import type { Database } from 'better-sqlite3'
import type { LinksRepo } from '../db/linksRepo.js'
import type { XrayClient } from './xrayClient.js'
import { parseStatsQuery } from '../lib/xrayStats.js'

// 后台调度器（REQUIREMENTS.md §3.2/§3.3）：
//   · 过期扫描：每 15s 扫 status='active' AND expires_at<now → 逐个 rmu + 标 expired
//   · 流量账本：每 30s statsquery -reset → delta 累加进 SQLite（links.up_bytes/down_bytes）
//
// 首拉语义（REQUIREMENTS.md §3.2 关注点）：xray stats 是易失计数器，账本权威在 SQLite。
//   进程重启后第一次 statsquery 若带 -reset，会把「停机期间的累计流量」一次性清零——
//   但 xray 侧计数器在重启前后并未归零，账本会**永久漏掉停机窗口的流量**。
// 解决：首次采集（进程启动后的第一次）不带 -reset，仅读值并**丢弃**（记为基线 0），
//   从第二次起才用 -reset 的增量（此时每轮结算窗口 = 30s，天然不漏，见注释三）。
//   对「瞬时」流量本就不保证（30s 粒度），需求明确接受该语义。
// 触发时机：start() 时立即做一次预热（顺序等待），此后定时器轮询。
//
// 过期扫描的 rmu 顺序执行；若某次 rmu 抛错（xray 暂不可达），记日志并跳过该链接
// （下一轮 15s 会再试）——不阻塞其余链接的吊销。

export interface SchedulerOptions {
  db: Database
  repo: LinksRepo
  xray: XrayClient
  logger?: (msg: string, meta?: Record<string, unknown>) => void
  now?: () => number
  /** 周期（ms）。测试可注入短周期/为 0 则单跑不循环。 */
  expireIntervalMs: number
  ledgerIntervalMs: number
}

export class Scheduler {
  private readonly db: Database
  private readonly repo: LinksRepo
  private readonly xray: XrayClient
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void
  private readonly now: () => number
  private readonly expireIntervalMs: number
  private readonly ledgerIntervalMs: number
  private expireTimer: ReturnType<typeof setTimeout> | null = null
  private ledgerTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  /** 首次采集前置位：true = 未预热（见类头「首拉语义」注释） */
  private firstLedger = true

  constructor(opts: SchedulerOptions) {
    this.db = opts.db
    this.repo = opts.repo
    this.xray = opts.xray
    this.log = opts.logger ?? ((msg) => console.log(`[scheduler] ${msg}`))
    this.now = opts.now ?? (() => Date.now())
    this.expireIntervalMs = opts.expireIntervalMs
    this.ledgerIntervalMs = opts.ledgerIntervalMs
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    // 预热首拉（详见类头）；collectTraffic 内部会翻转 firstLedger。
    // 失败不致命：记日志，等第一个定时周期再试（firstLedger 保持，届时仍按首拉处理）。
    try {
      await this.collectTraffic()
    } catch (e) {
      this.log('首次流量采集失败（将延后至下一轮）', { err: (e as Error).message })
    }
    this.expireTimer = setInterval(() => void this.runExpire(), this.expireIntervalMs)
    this.ledgerTimer = setInterval(() => void this.runLedger(), this.ledgerIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.expireTimer) clearInterval(this.expireTimer)
    if (this.ledgerTimer) clearInterval(this.ledgerTimer)
    this.expireTimer = null
    this.ledgerTimer = null
  }

  /** 过期扫描单轮（导出便于测试） */
  async runExpire(): Promise<string[]> {
    const expired: string[] = []
    const now = this.now()
    for (const row of this.repo.findActiveExpired(now)) {
      try {
        await this.xray.removeUser(row.email)
        // rmu 幂等（不存在返回 0），删除数无关紧要
      } catch (e) {
        this.log('过期链接 rmu 失败（下轮重试）', { email: row.email, err: (e as Error).message })
        continue
      }
      this.db.transaction(() => {
        // 仅 active → expired（防与手动 revoke 竞态）
        this.db.prepare(`UPDATE links SET status = 'expired' WHERE id = ? AND status = 'active'`).run(row.id)
      })()
      expired.push(row.id)
    }
    if (expired.length) this.log(`过期吊销 ${expired.length} 条`, { ids: expired })
    return expired
  }

  /** 流量账本单轮（导出便于测试）。预热与正常采集共用本方法：首次内部自动翻转 firstLedger。 */
  async collectTraffic(): Promise<{ applied: number }> {
    const isFirst = this.firstLedger
    const raw = await this.xray.queryTraffic('user>>>', !isFirst)
    if (isFirst) {
      // 首拉仅读不 reset、值丢弃（见类头「首拉语义」注释）
      this.firstLedger = false
      return { applied: 0 }
    }
    const { byUser } = parseStats(raw)
    let applied = 0
    const tx = this.db.transaction(() => {
      for (const [email, t] of byUser) {
        const link = this.repo.listActive().find((v) => v.email === email)
        if (!link) {
          // 账本里没有对应 active 链接（如 xray 残留/手工 adu 用户）——忽略，
          // 避免凭空累计。也可记日志供排障。
          continue
        }
        this.repo.addTraffic(link.id, t.up, t.down)
        applied++
      }
    })
    tx()
    return { applied }
  }

  private async runLedger(): Promise<void> {
    try {
      await this.collectTraffic()
    } catch (e) {
      this.log('流量账本采集失败（下轮重试）', { err: (e as Error).message })
    }
  }
}

// 复用 lib 解析，避免本文件重复实现
function parseStats(raw: string): ReturnType<typeof parseStatsQuery> {
  return parseStatsQuery(raw)
}
