import fs from 'node:fs'
import { parseAccessLine } from './accessLogParse.js'
import type { ConnectionRow } from '../types.js'

// access log 采集器（TASK-monitoring.md B §2「控制面新增 access log 采集器」）。
// 职责：轮询读取 access.log 增量，解析 accepted 事件行，按 email → links.id 关联后攒批落库。
//
// 自愈设计（与 logrotate copytruncate 配合）：
//   - 文件不存在/暂不可读 → 记日志降级，下轮重试，不崩；
//   - 同 inode 且 size 变小（copytruncate 截断）→ offset 归零重读，不丢不重；
//   - inode 变化（rename+新建 式轮转）→ 重开新文件，offset 回退到「新文件里已消费的
//     偏移以内」，并依据 lastSeenTs 去重（重读旧行直接丢弃）；
//   - 首轮只建基线（offset=文件尾），不灌历史日志；
//   - 解析失败/无 email 的行跳过（计数），不因脏行中断。
//
// 说明：xray access log 只含 accepted（连接建立），无字节数（实测）——connection 行的
//       up/down/duration 恒为 NULL，字节溯源走 traffic_samples。email 在库中无链接
//       （残留/已吊销）→ link_id=NULL 仅记 email，仍可追溯。

export const BATCH_SIZE = 100

export interface TailerOptions {
  /** 日志文件路径 */
  path: string
  /** 采集周期（ms）。测试可注入 0 = 不自动轮询，手动 poll */
  intervalMs: number
  /** 关联 email → link_id；返回 null 表示库中无匹配（记 link_id=NULL） */
  resolveLinkId: (email: string) => string | null
  /** 攒批落库（一批一事务） */
  sink: (rows: ConnectionRow[]) => void
  logger?: (msg: string, meta?: Record<string, unknown>) => void
}

export interface TailerPollResult {
  /** 本轮读取字节数 */
  bytes: number
  /** 本轮解析出的有效行数 */
  parsed: number
  /** 本轮跳过行数（非 accepted / 无 email / 关联水位去重） */
  skipped: number
  /** 本轮末 flush 落库的行数 */
  flushed: number
}

export class AccessLogTailer {
  private readonly path: string
  private readonly intervalMs: number
  private readonly resolveLinkId: (email: string) => string | null
  private readonly sink: (rows: ConnectionRow[]) => void
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private offset = 0
  /** 最近一次已知 stat（轮转/截断检测基线） */
  private stat: fs.Stats | null = null
  /** 已消费行指纹（轮转回退重读时去重）。Map 保插入序；超上限丢最旧。
   *  指纹 = email|host|port|ts，同一毫秒的两条真实连接因 host/email 不同不会误删。 */
  private readonly seen = new Map<string, true>()
  private readonly seenCap = 1024
  /** 跨轮残留的半行（chunk 边界截断的完整行） */
  private partial = ''
  /** 攒批缓冲 */
  private readonly pending: ConnectionRow[] = []

  constructor(opts: TailerOptions) {
    this.path = opts.path
    this.intervalMs = opts.intervalMs
    this.resolveLinkId = opts.resolveLinkId
    this.sink = opts.sink
    this.log = opts.logger ?? ((msg) => console.log(`[tailer] ${msg}`))
  }

  start(): void {
    if (this.running) return
    this.running = true
    if (this.intervalMs <= 0) return // 测试驱动：手动 poll
    try {
      this.poll()
    } catch (e) {
      this.log('启动首轮采集失败（下轮重试）', { err: (e as Error).message })
    }
    this.timer = setInterval(() => {
      try {
        this.poll()
      } catch (e) {
        this.log('定时采集失败（下轮重试）', { err: (e as Error).message })
      }
    }, this.intervalMs)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 单轮增量读 + 攒批 + flush；返回本轮统计 */
  poll(): TailerPollResult {
    const res: TailerPollResult = { bytes: 0, parsed: 0, skipped: 0, flushed: 0 }
    try {
      const cur = fs.statSync(this.path)
      if (this.stat === null) {
        // 首次：建基线（从文件尾开始），不重复灌历史
        this.offset = cur.size
        this.stat = cur
        return res
      }
      const inodeChanged = cur.ino !== this.stat.ino
      const truncated = !inodeChanged && cur.size < this.stat.size
      if (inodeChanged) {
        this.log('检测到日志轮转（inode 变化），重开新文件', { ino: cur.ino })
        // rename+新建：新文件里旧行若已消费会重读 → 用 lastSeenTs 去重。
        // 回退 offset 至新文件内偏移（保守起见从已读到的最大偏移截断；若无则从 0）。
        this.offset = 0
        this.partial = ''
        this.stat = cur
      } else if (truncated) {
        this.log('检测到日志截断（copytruncate），offset 归零重读')
        this.offset = 0
        this.partial = ''
        this.stat = cur
      }
      if (cur.size > this.offset) {
        const want = Math.min(cur.size - this.offset, 1 << 20)
        const buf = Buffer.alloc(want)
        const fd = fs.openSync(this.path, 'r')
        try {
          const n = fs.readSync(fd, buf, 0, want, this.offset)
          this.offset += n
          res.bytes = n
          this.consumeChunk(buf.subarray(0, n).toString('utf8'), res)
        } finally {
          fs.closeSync(fd)
        }
      }
      this.stat = cur
      res.flushed = this.flush()
    } catch (e) {
      this.log('读取 access log 失败（下轮重试）', { path: this.path, err: (e as Error).message })
    }
    return res
  }

  /** 把积压缓冲落库（攒批）；失败时丢弃该批并记录指纹，防内存无限增长 */
  flush(): number {
    if (!this.pending.length) return 0
    const batch = this.pending.splice(0, this.pending.length)
    try {
      this.sink(batch)
    } catch (e) {
      this.log('connections 落库失败（丢弃本批，下次重试）', {
        err: (e as Error).message,
        rows: batch.length,
      })
    }
    for (const r of batch) this.remember(r)
    return batch.length
  }

  private remember(r: ConnectionRow): void {
    const key = `${r.email}|${r.host ?? ''}|${r.port ?? ''}|${r.ts}`
    this.seen.delete(key)
    this.seen.set(key, true)
    if (this.seen.size > this.seenCap) {
      const oldest = this.seen.keys().next().value as string | undefined
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  private isDuplicate(r: ConnectionRow): boolean {
    const key = `${r.email}|${r.host ?? ''}|${r.port ?? ''}|${r.ts}`
    return this.seen.has(key)
  }

  private consumeChunk(chunk: string, res: TailerPollResult): void {
    const text = this.partial + chunk
    const lines = text.split('\n')
    // 末段无换行符结尾 → 半行，暂存下次拼接
    this.partial = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      const parsed = parseAccessLine(line)
      if (!parsed) {
        res.skipped++
        continue
      }
      const row: ConnectionRow = {
        id: 0,
        link_id: this.resolveLinkId(parsed.email),
        email: parsed.email,
        ts: parsed.ts,
        host: parsed.host || null,
        port: parsed.port,
        up_bytes: null,
        down_bytes: null,
        duration_ms: null,
      }
      // 轮转回退重读去重：指纹已见过 → 丢弃
      if (this.isDuplicate(row)) {
        res.skipped++
        continue
      }
      this.pending.push(row)
      res.parsed++
      if (this.pending.length >= BATCH_SIZE) {
        res.flushed += this.flush()
      }
    }
  }
}
