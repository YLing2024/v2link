import { describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { XrayClient } from '../services/xrayClient.js'
import { XrayClient as RealXrayClient, type ExecFn } from '../services/xrayClient.js'
import { ReconcileService, shouldBeActive } from '../services/reconcile.js'
import { makeRepo, makeTestDb } from './helpers.js'

// ReconcileService 单测（需求文档 R5）：
//   1. 账本有效但 xray 缺失 → adu；
//   2. revoked/expired（含 active 但已到期）→ rmu；
//   3. xray 已存在（already exists，走真实 XrayClient + 假 execFn）→ 视为成功、不抛、不误报动作；
//   4. adu 抛错 → 不抛、不改账本、记失败日志、下轮重试；
//   5. 稳态无动作 → 不打日志（R4）。

function stubXray(overrides?: Partial<XrayClient>): XrayClient {
  return {
    addUser: vi.fn(async () => true),
    removeUser: vi.fn(async () => 0),
    queryTraffic: vi.fn(async () => '{}'),
    ...overrides,
  } as unknown as XrayClient
}

function seed(
  db: Database.Database,
  opts: { id: string; uuid?: string; expiresAt?: number; status?: string; revokedAt?: number | null },
): string {
  const uuid = opts.uuid ?? crypto.randomUUID()
  db.prepare(
    `INSERT INTO links (id, uuid, email, note, up_bytes, down_bytes, created_at, expires_at, revoked_at, status)
     VALUES (?, ?, ?, '', 0, 0, 0, ?, ?, ?)`,
  ).run(opts.id, uuid, opts.id, opts.expiresAt ?? 1_900_000_000_000, opts.revokedAt ?? null, opts.status ?? 'active')
  return uuid
}

function makeReconcile(opts?: { xray?: XrayClient; now?: () => number }) {
  const db = makeTestDb()
  const repo = makeRepo(db)
  const xray = opts?.xray ?? stubXray()
  const logs: string[] = []
  const svc = new ReconcileService({
    repo,
    xray,
    now: opts?.now ?? (() => 1_800_000_000_000),
    logger: (msg) => {
      logs.push(msg)
    },
  })
  return { db, repo, xray, svc, logs }
}

describe('账本判定 shouldBeActive', () => {
  const base = {
    id: 'lk',
    uuid: 'u',
    email: 'lk',
    note: '',
    alias: '',
    up_bytes: 0,
    down_bytes: 0,
    created_at: 0,
    revoked_at: null,
    status: 'active' as const,
  }
  it('active 且未到期/未吊销 → true；永久（expires_at=0）→ true', () => {
    expect(shouldBeActive({ ...base, expires_at: 2_000 }, 1_000)).toBe(true)
    expect(shouldBeActive({ ...base, expires_at: 0 }, 1_000)).toBe(true)
  })
  it('已到期 / revoked / 非 active → false', () => {
    expect(shouldBeActive({ ...base, expires_at: 500 }, 1_000)).toBe(false)
    expect(shouldBeActive({ ...base, expires_at: 2_000, revoked_at: 1 }, 1_000)).toBe(false)
    expect(shouldBeActive({ ...base, expires_at: 2_000, status: 'expired' }, 1_000)).toBe(false)
  })
})

describe('ReconcileService.run', () => {
  it('账本有效但 xray 缺失 → adu 补回；快照 activeLinks/lastFix 正确', async () => {
    const addUser = vi.fn(async () => true)
    const xray = stubXray({ addUser })
    const { db, svc } = makeReconcile({ xray })
    const uuid = seed(db, { id: 'lk_a' })

    const res = await svc.run()
    expect(addUser).toHaveBeenCalledWith({ email: 'lk_a', uuid })
    expect(res).toMatchObject({ checked: 1, added: ['lk_a'], removed: [], failures: [] })
    expect(svc.snapshot()).toEqual({
      activeLinks: 1,
      reconciledAt: 1_800_000_000_000,
      lastFix: { added: 1, removed: 0 },
    })
  })

  it('revoked / expired 非 active → rmu 清理；active 仍走 adu', async () => {
    const addUser = vi.fn(async () => true)
    const removeUser = vi.fn(async () => 1)
    const { db, svc } = makeReconcile({ xray: stubXray({ addUser, removeUser }) })
    seed(db, { id: 'lk_r', status: 'revoked', revokedAt: 100 })
    seed(db, { id: 'lk_e', status: 'expired' })
    seed(db, { id: 'lk_a' })

    const res = await svc.run()
    expect(removeUser).toHaveBeenCalledWith('lk_r')
    expect(removeUser).toHaveBeenCalledWith('lk_e')
    expect(addUser).toHaveBeenCalledWith({ email: 'lk_a', uuid: expect.any(String) })
    expect([...res.removed].sort()).toEqual(['lk_e', 'lk_r'])
    expect(res.added).toEqual(['lk_a'])
  })

  it('active 但已到期（等过期扫描前的窗口）→ 视为无效，rmu 且不 adu', async () => {
    const addUser = vi.fn(async () => true)
    const removeUser = vi.fn(async () => 1)
    const { db, svc } = makeReconcile({ xray: stubXray({ addUser, removeUser }) })
    seed(db, { id: 'lk_due', expiresAt: 1_000 })

    const res = await svc.run()
    expect(addUser).not.toHaveBeenCalled()
    expect(removeUser).toHaveBeenCalledWith('lk_due')
    expect(res.removed).toEqual(['lk_due'])
    expect(res.added).toEqual([])
  })

  it('永久链接（expires_at=0）视为有效 → adu', async () => {
    const addUser = vi.fn(async () => true)
    const { db, svc } = makeReconcile({ xray: stubXray({ addUser }) })
    seed(db, { id: 'lk_p', expiresAt: 0 })
    const res = await svc.run()
    expect(res.added).toEqual(['lk_p'])
  })

  it('xray 已存在（already exists，真实 XrayClient）→ 幂等成功不抛，不计动作、不产日志', async () => {
    const execFn: ExecFn = async (_file, args) => ({
      stdout:
        args[1] === 'adu'
          ? 'rpc error: User lk_a already exists.\nAdded 0 user(s) in total.\n'
          : 'Removed 0 user(s) in total.\n',
      stderr: '',
    })
    const xray = new RealXrayClient({
      apiAddr: '127.0.0.1:8081',
      inboundTag: 'vless-in',
      execFn,
    })
    const { db, svc, logs } = makeReconcile({ xray })
    seed(db, { id: 'lk_a' })

    await expect(svc.run()).resolves.toMatchObject({ added: [], removed: [], failures: [] })
    expect(logs).toEqual([])
  })

  it('adu 抛错 → 不抛、账本原样，记失败日志，下轮重试', async () => {
    let calls = 0
    const addUser = vi.fn(async () => {
      calls++
      throw new Error('conn refused')
    })
    const { db, repo, svc, logs } = makeReconcile({ xray: stubXray({ addUser }) })
    seed(db, { id: 'lk_a' })
    const before = { ...repo.byId('lk_a')! }

    const res = await svc.run()
    expect(res.failures).toEqual(['lk_a'])
    expect(res.added).toEqual([])
    expect({ ...repo.byId('lk_a')! }).toEqual(before) // 账本一字未改
    expect(logs.some((m) => m.includes('调用失败'))).toBe(true)

    await svc.run() // 下轮重试
    expect(addUser).toHaveBeenCalledTimes(2)
    expect(calls).toBe(2)
  })

  it('rmu 抛错 → 同样不抛、不改账本，计入 failures', async () => {
    const removeUser = vi.fn(async () => {
      throw new Error('down')
    })
    const { db, repo, svc } = makeReconcile({ xray: stubXray({ removeUser }) })
    seed(db, { id: 'lk_r', status: 'revoked', revokedAt: 1 })
    const before = { ...repo.byId('lk_r')! }
    const res = await svc.run()
    expect(res.failures).toEqual(['lk_r'])
    expect({ ...repo.byId('lk_r')! }).toEqual(before)
  })

  it('稳态（已存在 + 无残留）→ 无动作、不产日志（R4 防洪水）', async () => {
    const xray = stubXray({ addUser: vi.fn(async () => false) })
    const { db, svc, logs } = makeReconcile({ xray })
    seed(db, { id: 'lk_a' }) // xray 已有 → addUser false
    seed(db, { id: 'lk_r', status: 'revoked', revokedAt: 1 }) // rmu 返回 0
    const res = await svc.run()
    expect(res).toMatchObject({ added: [], removed: [], failures: [] })
    expect(logs).toEqual([])
    expect(svc.snapshot().lastFix).toEqual({ added: 0, removed: 0 })
  })

  it('有动作时打一行摘要（含 [reconcile] 与计数）', async () => {
    const { db, svc, logs } = makeReconcile({ xray: stubXray({ addUser: vi.fn(async () => true) }) })
    seed(db, { id: 'lk_a' })
    await svc.run()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('[reconcile] 检查 1 / 补回 1（lk_a）')
  })

  it('snapshot 初始为全 0（尚未跑过）', () => {
    const { svc } = makeReconcile()
    expect(svc.snapshot()).toEqual({ activeLinks: 0, reconciledAt: 0, lastFix: { added: 0, removed: 0 } })
  })
})
