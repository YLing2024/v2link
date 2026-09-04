import { describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../services/scheduler.js'
import type { XrayClient } from '../services/xrayClient.js'
import { createRegionProbeService, type RegionProbeService } from '../services/regionProbe.js'
import { makeMonitor, makeRepo, makeTestDb } from './helpers.js'

// Scheduler 单测：
//   · 过期扫描：active 且到期 → rmu + expired
//   · rmu 失败 → 本轮跳过（保持 active），不抛
//   · 账本首拉语义：首次不 reset、值丢弃；第二次起 reset + 累加
//   · 未知 email（数据面残留）不凭空累计
//   · 账本轮同时写 traffic_samples（A 层）；连接/采样保留清理（7 天 / 30 天滚动）

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
  connCleanupIntervalMs?: number
  sampleCleanupIntervalMs?: number
  connRetentionMs?: number
  sampleRetentionMs?: number
  regionProbe?: RegionProbeService
}) {
  const db = makeTestDb()
  const repo = makeRepo(db)
  const monitor = makeMonitor(db)
  const sched = new Scheduler({
    db,
    repo,
    monitor,
    xray: overrides?.xray ?? stubXray(),
    regionProbe: overrides?.regionProbe,
    logger: () => undefined,
    now: overrides?.now ?? (() => 1_800_000_000_000),
    expireIntervalMs: overrides?.expireIntervalMs ?? 15_000,
    ledgerIntervalMs: overrides?.ledgerIntervalMs ?? 30_000,
    connCleanupIntervalMs: overrides?.connCleanupIntervalMs ?? 60_000,
    sampleCleanupIntervalMs: overrides?.sampleCleanupIntervalMs ?? 86_400_000,
    connRetentionMs: overrides?.connRetentionMs ?? 7 * 86_400_000,
    sampleRetentionMs: overrides?.sampleRetentionMs ?? 30 * 86_400_000,
  })
  return { db, repo, monitor, sched }
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

  it('账本轮把 delta 写进 traffic_samples（采样 ts=当前轮时间）', async () => {
    const queryTraffic = vi
      .fn()
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(traffic({ lk_aaa: { up: 10, down: 20 } }))
    const xray = stubXray({ queryTraffic })
    const { db, sched } = makeScheduler({ xray, now: () => 1_800_000_123_000 })
    seed(db, { id: 'lk_aaa' })
    await sched.collectTraffic() // 预热
    const res = await sched.collectTraffic()
    expect(res.applied).toBe(1)
    expect(res.sampleRows).toBe(1)
    const samples = db
      .prepare('SELECT * FROM traffic_samples')
      .all() as { link_id: string; ts: number; up_delta: number; down_delta: number }[]
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({
      link_id: 'lk_aaa',
      ts: 1_800_000_123_000,
      up_delta: 10,
      down_delta: 20,
    })
  })
})

describe('保留清理（A/B 滚动）', () => {
  it('cleanupConnections 只删 7 天前的行', async () => {
    const { db, sched } = makeScheduler({ now: () => 2_000_000_000_000 })
    const now = 2_000_000_000_000
    const cutoff = now - 7 * 86_400_000
    const ins = db.prepare(
      `INSERT INTO connections (link_id, email, ts, host, port) VALUES (?, ?, ?, ?, ?)`,
    )
    ins.run('lk_a', 'lk_a', cutoff - 1, 'old.example', 443)
    ins.run('lk_b', 'lk_b', cutoff + 1, 'new.example', 443)
    const removed = sched.cleanupConnections()
    expect(removed).toBe(1)
    const left = db.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number }
    expect(left.n).toBe(1)
  })

  it('cleanupSamples 只删 30 天前的采样', async () => {
    const { db, sched } = makeScheduler({ now: () => 2_000_000_000_000 })
    const now = 2_000_000_000_000
    const cutoff = now - 30 * 86_400_000
    seed(db, { id: 'lk_a' })
    seed(db, { id: 'lk_b' })
    const ins = db.prepare(`INSERT INTO traffic_samples (link_id, ts, up_delta) VALUES (?, ?, ?)`)
    ins.run('lk_a', cutoff - 1000, 5)
    ins.run('lk_b', cutoff + 1000, 5)
    const removed = sched.cleanupSamples()
    expect(removed).toBe(1)
    const left = db.prepare('SELECT COUNT(*) AS n FROM traffic_samples').get() as { n: number }
    expect(left.n).toBe(1)
  })
})

describe('地区连通性探测（TASK-extend-regions.md 需求 2）', () => {
  function okFetch(): typeof fetch {
    return vi.fn(async () => ({ ok: true, status: 204 } as unknown as Response)) as unknown as typeof fetch
  }

  it('runRegionProbes：调 RegionProbeService，单轮结果入内存（snapshot 可见）', async () => {
    const probe = createRegionProbeService({
      probes: [{ key: 'us', name: '美国', flag: '🇺🇸', url: 'https://us.example/generate_204' }],
      fetchFn: okFetch(),
      logger: () => undefined,
    })
    const { sched } = makeScheduler({ regionProbe: probe })
    await sched.runRegionProbes()
    const snap = probe.snapshot()
    expect(snap.probes).toHaveLength(1)
    expect(snap.probes[0]).toMatchObject({ key: 'us', ok: true, error: null })
    expect(snap.probes[0]!.rttMs).not.toBeNull()
  })

  it('探测抛错不致命：scheduler 记日志不抛（下轮重试）', async () => {
    const probe = createRegionProbeService({
      probes: [{ key: 'us', name: '美国', flag: '🇺🇸', url: 'https://us.example/generate_204' }],
      fetchFn: vi.fn(async () => {
        throw new Error('boom')
      }) as unknown as typeof fetch,
      logger: () => undefined,
    })
    const { sched } = makeScheduler({ regionProbe: probe })
    await expect(sched.runRegionProbes()).resolves.toBeUndefined()
    const snap = probe.snapshot()
    expect(snap.probes[0]!.ok).toBe(false)
  })

  it('未挂 regionProbe 时 runRegionProbes 为空操作', async () => {
    const { sched } = makeScheduler({})
    await expect(sched.runRegionProbes()).resolves.toBeUndefined()
  })
})
