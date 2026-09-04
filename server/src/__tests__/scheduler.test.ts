import { describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../services/scheduler.js'
import type { XrayClient } from '../services/xrayClient.js'
import { makeRepo, makeTestDb } from './helpers.js'

// Scheduler 单测：
//   · 过期扫描：active 且到期 → rmu + expired
//   · rmu 失败 → 本轮跳过（保持 active），不抛
//   · 账本首拉语义：首次不 reset、值丢弃；第二次起 reset + 累加
//   · 未知 email（数据面残留）不凭空累计

function stubXray(overrides?: Partial<XrayClient>): XrayClient {
  return {
    addUser: vi.fn(async () => undefined),
    removeUser: vi.fn(async () => 1),
    queryTraffic: vi.fn(async () => '{}'),
    ...overrides,
  } as unknown as XrayClient
}

interface TrafficResp {
  stat: { name: string; value?: number }[]
}

function traffic(users: Record<string, { up: number; down: number }>): string {
  const stat: TrafficResp['stat'] = []
  for (const [email, t] of Object.entries(users)) {
    if (t.up) stat.push({ name: `user>>>${email}>>>traffic>>>uplink`, value: t.up })
    if (t.down) stat.push({ name: `user>>>${email}>>>traffic>>>downlink`, value: t.down })
  }
  return JSON.stringify({ stat })
}

function makeScheduler(overrides?: {
  xray?: XrayClient
  now?: () => number
  expireIntervalMs?: number
  ledgerIntervalMs?: number
}) {
  const db = makeTestDb()
  const repo = makeRepo(db)
  const sched = new Scheduler({
    db,
    repo,
    xray: overrides?.xray ?? stubXray(),
    logger: () => undefined,
    now: overrides?.now ?? (() => 1_800_000_000_000),
    expireIntervalMs: overrides?.expireIntervalMs ?? 15_000,
    ledgerIntervalMs: overrides?.ledgerIntervalMs ?? 30_000,
  })
  return { db, repo, sched }
}

async function seed(
  db: ReturnType<typeof makeTestDb>,
  opts: { id?: string; expiresAt?: number; status?: string } = {},
) {
  const id = opts.id ?? 'lk_aaa'
  // uuid 用随机值，避免跨用例重复触发 UNIQUE 约束
  const uuid = crypto.randomUUID()
  db.prepare(
    `INSERT INTO links (id, uuid, email, note, up_bytes, down_bytes, created_at, expires_at, revoked_at, status)
     VALUES (?, ?, ?, '', 0, 0, 0, ?, NULL, ?)`,
  ).run(id, uuid, id, opts.expiresAt ?? 1_900_000_000_000, opts.status ?? 'active')
}

describe('过期扫描', () => {
  it('到期的 active 链接 → rmu + 标 expired', async () => {
    const removeUser = vi.fn(async () => 1)
    const xray = stubXray({ removeUser })
    const { db, sched } = makeScheduler({ xray, now: () => 1_800_000_000_000 })
    seed(db, { id: 'lk_aaa', expiresAt: 1_000_000_000 }) // 已过期
    seed(db, { id: 'lk_bbb', expiresAt: 9_000_000_000_000 }) // 未过期

    const expired = await sched.runExpire()
    expect(expired).toEqual(['lk_aaa'])
    expect(removeUser).toHaveBeenCalledWith('lk_aaa')
    const rowA = db.prepare('SELECT status FROM links WHERE id=?').get('lk_aaa') as { status: string }
    const rowB = db.prepare('SELECT status FROM links WHERE id=?').get('lk_bbb') as { status: string }
    expect(rowA.status).toBe('expired')
    expect(rowB.status).toBe('active')
  })

  it('rmu 失败 → 本轮跳过且不抛（下轮重试），保持 active', async () => {
    const removeUser = vi.fn(async () => { throw new Error('down') })
    const xray = stubXray({ removeUser })
    const { db, sched } = makeScheduler({ xray, now: () => 1_800_000_000_000 })
    seed(db, { id: 'lk_aaa', expiresAt: 1_000 })
    const expired = await sched.runExpire()
    expect(expired).toEqual([])
    const row = db.prepare('SELECT status FROM links WHERE id=?').get('lk_aaa') as { status: string }
    expect(row.status).toBe('active')
  })
})

describe('流量账本', () => {
  it('首次采集（未预热）：不 reset、值丢弃（基线），账本不变', async () => {
    const queryTraffic = vi.fn(async () => '{}')
    const xray = stubXray({ queryTraffic })
    const { db, sched } = makeScheduler({ xray })
    seed(db, { id: 'lk_aaa' })
    // firstLedger=true 时调用 queryTraffic(reset=false)
    const res = await sched.collectTraffic()
    expect(res.applied).toBe(0)
    expect(queryTraffic).toHaveBeenCalledWith('user>>>', false)
    const row = db.prepare('SELECT up_bytes, down_bytes FROM links WHERE id=?').get('lk_aaa') as {
      up_bytes: number
      down_bytes: number
    }
    expect(row.up_bytes).toBe(0)
    expect(row.down_bytes).toBe(0)
  })

  it('预热后采集：reset=true，delta 累加进对应 email 的链接', async () => {
    const queryTraffic = vi
      .fn()
      .mockResolvedValueOnce('{}') // 首拉（不 reset）
      .mockResolvedValueOnce(traffic({ lk_aaa: { up: 100, down: 200 } }))
    const xray = stubXray({ queryTraffic })
    const { db, sched } = makeScheduler({ xray })
    seed(db, { id: 'lk_aaa' })
    await sched.collectTraffic() // 首拉预热
    const res = await sched.collectTraffic()
    expect(res.applied).toBe(1)
    expect(queryTraffic).toHaveBeenLastCalledWith('user>>>', true)
    const row = db.prepare('SELECT up_bytes, down_bytes FROM links WHERE id=?').get('lk_aaa') as {
      up_bytes: number
      down_bytes: number
    }
    expect(row.up_bytes).toBe(100)
    expect(row.down_bytes).toBe(200)
  })

  it('账本中无对应 active 链接（xray 残留）→ 不凭空累计', async () => {
    const queryTraffic = vi
      .fn()
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(traffic({ lk_ghost: { up: 100, down: 100 } }))
    const xray = stubXray({ queryTraffic })
    const { db, sched } = makeScheduler({ xray })
    seed(db, { id: 'lk_aaa' })
    await sched.collectTraffic()
    const res = await sched.collectTraffic()
    expect(res.applied).toBe(0)
    const row = db.prepare('SELECT up_bytes FROM links WHERE id=?').get('lk_aaa') as {
      up_bytes: number
    }
    expect(row.up_bytes).toBe(0)
  })
})
