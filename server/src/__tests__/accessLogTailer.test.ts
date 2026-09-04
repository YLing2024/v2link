import { describe, expect, it } from 'vitest'
import { AccessLogTailer, BATCH_SIZE } from '../lib/accessLogTailer.js'
import type { ConnectionRow } from '../types.js'

// tailer 单测（TASK-monitoring.md B）：增量读、攒批、logrotate copytruncate 自愈、
// rename 轮转跟随、基线/去重。用临时目录里的真实文件驱动（fs mock 不用，验证真实语义）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tmpLog(): { dir: string; file: string; write: (s: string) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2link-tail-'))
  const file = path.join(dir, 'access.log')
  // 与生产一致：xray 启动即创建 access.log（空文件）
  fs.writeFileSync(file, '')
  const write = (s: string) => fs.appendFileSync(file, s)
  return { dir, file, write }
}

function mkTailer(file: string, sink: (rows: ConnectionRow[]) => void) {
  return new AccessLogTailer({
    path: file,
    intervalMs: 0, // 手动驱动
    resolveLinkId: (email) => (email.startsWith('lk_') ? email : null),
    sink,
    logger: () => undefined,
  })
}

function accLine(ts: number, host: string, email: string): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return (
    `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000000 ` +
    `from 1.2.3.4:55555 accepted tcp:${host}:443 email: ${email}`
  )
}

describe('AccessLogTailer', () => {
  it('首轮建基线：不灌已有历史，仅消费之后追加的行', () => {
    const { dir, file, write } = tmpLog()
    try {
      write(accLine(1_800_000_000_000, 'old.example', 'lk_old') + '\n')
      const sunk: ConnectionRow[][] = []
      const t = mkTailer(file, (rows) => sunk.push(rows))
      t.poll() // 基线：offset=文件尾
      expect(sunk).toHaveLength(0)
      write(accLine(1_800_000_000_001, 'new.example', 'lk_new') + '\n')
      t.poll()
      expect(sunk).toHaveLength(1)
      expect(sunk[0]).toHaveLength(1)
      expect(sunk[0]![0]!).toMatchObject({
        email: 'lk_new',
        host: 'new.example',
        link_id: 'lk_new',
        port: 443,
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('攒批落库：超过 BATCH_SIZE 自动 flush 为一整批', () => {
    const { dir, file, write } = tmpLog()
    try {
      const sunk: ConnectionRow[][] = []
      const t = mkTailer(file, (rows) => sunk.push(rows))
      t.poll() // 基线
      const lines = Array.from({ length: BATCH_SIZE + 3 }, (_, i) =>
        accLine(1_800_000_000_000 + i, `h${i}.example`, `lk_u${i}`),
      ).join('\n')
      write(lines + '\n')
      const res = t.poll()
      // 满 100 自动 flush；轮末 flush 残余 3 → 共两批 103 行
      expect(res.parsed).toBe(BATCH_SIZE + 3)
      expect(sunk[0]).toHaveLength(BATCH_SIZE)
      expect(sunk.flat()).toHaveLength(BATCH_SIZE + 3)
      expect(t.flush()).toBe(0) // 轮末已 flush，无残留
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copytruncate（同 inode size 变小）→ offset 归零重读，不丢不重', () => {
    const { dir, file, write } = tmpLog()
    try {
      const sunk: ConnectionRow[][] = []
      const t = mkTailer(file, (rows) => sunk.push(rows))
      t.poll() // 基线（空）
      write(accLine(1_800_000_000_010, 'a.example', 'lk_a') + '\n')
      write(accLine(1_800_000_000_011, 'b.example', 'lk_b') + '\n')
      t.poll()
      expect(sunk.flat()).toHaveLength(2)
      // 模拟 logrotate copytruncate：截断原文件为 0，再写新行
      fs.truncateSync(file, 0)
      t.poll() // 检测截断 → offset=0；此时无新数据
      expect(sunk.flat()).toHaveLength(2) // 不重复
      write(accLine(1_800_000_000_012, 'c.example', 'lk_c') + '\n')
      t.poll()
      const hosts = sunk.flat().map((r) => r.host)
      expect(hosts).toEqual(['a.example', 'b.example', 'c.example'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rename 轮转（新 inode）→ 跟随新文件且按 ts 去重不重复消费', () => {
    const { dir, file, write } = tmpLog()
    try {
      const sunk: ConnectionRow[][] = []
      const t = mkTailer(file, (rows) => sunk.push(rows))
      t.poll()
      write(accLine(1_800_000_000_020, 'old.example', 'lk_x') + '\n')
      t.poll()
      expect(sunk.flat()).toHaveLength(1)
      // logrotate rename 方案：mv 走旧文件，新文件被创建
      fs.renameSync(file, path.join(dir, 'access.log.1'))
      write(accLine(1_800_000_000_021, 'new.example', 'lk_y') + '\n') // 新 inode 文件里已有新行
      t.poll()
      // 新 inode 检测：offset 归零重读。重读会看到新行 lk_y；
      // 旧行 lk_x 在新文件不存在。不重复计数（仅有新行 1 条）
      const hosts = sunk.flat().map((r) => r.host)
      expect(hosts).toContain('new.example')
      expect(sunk.flat().filter((r) => r.host === 'old.example')).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件不存在 → 不抛、自愈（下轮可恢复）', () => {
    const { dir } = tmpLog()
    try {
      const file = path.join(dir, 'nope.log') // 尚未创建
      const t = mkTailer(file, () => undefined)
      const res = t.poll()
      expect(res.bytes).toBe(0)
      // 之后文件出现 → 正常建基线
      fs.writeFileSync(file, accLine(1_800_000_000_030, 'later.example', 'lk_z') + '\n')
      t.poll() // 建基线
      fs.appendFileSync(file, accLine(1_800_000_000_031, 'now.example', 'lk_n') + '\n')
      const res2 = t.poll()
      expect(res2.parsed).toBe(1) // 轮末 flush，sink 已收到
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('email 在库中无链接 → link_id=null，仍记 email', () => {
    const { dir, file, write } = tmpLog()
    try {
      const sunk: ConnectionRow[][] = []
      const t = mkTailer(file, (rows) => sunk.push(rows))
      t.poll()
      write(accLine(1_800_000_000_040, 'ghost.example', 'ghost@xray') + '\n')
      t.poll()
      expect(sunk.flat()[0]).toMatchObject({ email: 'ghost@xray', link_id: null })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
