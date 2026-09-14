import { describe, expect, it, vi } from 'vitest'
import type { XrayClient } from '../services/xrayClient.js'
import { createLinkService, HttpError } from '../services/linkService.js'
import { makeMonitor, makeRepo, makeTestDb } from './helpers.js'
import type { MonitoringRepo } from '../db/monitoringRepo.js'

// linkService 单测：状态机 + 「先落库后调 xray，失败回滚」的一致性约束 + 操作审计（C 层）。
// xray 用 mock（记录调用 / 可控失败）。

function stubXray(overrides?: Partial<XrayClient>): XrayClient {
  return {
    addUser: vi.fn(async () => undefined),
    removeUser: vi.fn(async () => 1),
    queryTraffic: vi.fn(async () => '{}'),
    ...overrides,
  } as unknown as XrayClient
}

const limits = { defaultHours: 24, maxHours: 720 }

function makeService(overrides?: { xray?: XrayClient; now?: () => number }) {
  const db = makeTestDb()
  const repo = makeRepo(db)
  const monitor = makeMonitor(db)
  const svc = createLinkService({
    db,
    repo,
    monitor,
    xray: overrides?.xray ?? stubXray(),
    limits,
    now: overrides?.now ?? (() => 1_700_000_000_000),
  })
  return { db, repo, monitor, svc }
}

describe('create', () => {
  it('默认 hours=24；返回 active 且 email=id', async () => {
    const { svc, repo } = makeService()
    const created = await svc.create({})
    expect(created.status).toBe('active')
    expect(created.upBytes).toBe(0)
    expect(created.note).toBe('')
    const row = repo.byId(created.id)!
    expect(row.email).toBe(created.id)
    expect(row.expires_at - row.created_at).toBe(24 * 3600 * 1000)
  })

  it('自定义 note/hours 生效', async () => {
    const { svc } = makeService()
    const created = await svc.create({ note: ' 朋友 ', hours: 2 })
    expect(created.note).toBe('朋友')
    expect(created.expiresAt - created.createdAt).toBe(2 * 3600 * 1000)
  })

  it('非法输入 → 400', async () => {
    const { svc } = makeService()
    await expect(svc.create({ hours: 0 })).rejects.toMatchObject({ status: 400 })
    await expect(svc.create({ hours: 721 })).rejects.toMatchObject({ status: 400 })
  })

  it('xray addUser 失败 → 回滚（DB 无残留行）+ 502', async () => {
    const xray = stubXray({ addUser: vi.fn(async () => { throw new Error('conn refused') }) })
    const { svc, repo } = makeService({ xray })
    await expect(svc.create({})).rejects.toMatchObject({ status: 502 })
    expect(repo.list()).toHaveLength(0)
  })

  it('成功时 adu 参数带 email/uuid', async () => {
    const addUser = vi.fn(async () => undefined)
    const xray = stubXray({ addUser })
    const { svc } = makeService({ xray })
    const link = await svc.create({})
    expect(addUser).toHaveBeenCalledWith({
      email: link.id,
      uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
  })
})

describe('状态机', () => {
  it('revoke：active → revoked，调 xray rmu，revoked_at 置位', async () => {
    const removeUser = vi.fn(async () => 1)
    const xray = stubXray({ removeUser })
    const { svc } = makeService({ xray, now: () => 1_700_000_000_000 })
    const link = await svc.create({})
    const revoked = await svc.revoke(link.id)
    expect(revoked.status).toBe('revoked')
    expect(revoked.revokedAt).toBe(1_700_000_000_000)
    expect(removeUser).toHaveBeenCalledWith(link.id)
  })

  it('rmu 失败 → 回滚回 active + 502', async () => {
    const removeUser = vi.fn(async () => { throw new Error('down') })
    const xray = stubXray({ removeUser })
    const { svc } = makeService({ xray })
    const link = await svc.create({})
    await expect(svc.revoke(link.id)).rejects.toMatchObject({ status: 502 })
    const after = svc.list()[0]!
    expect(after.status).toBe('active')
    expect(after.revokedAt).toBeNull()
  })

  it('revoke 后不可 extend（400）', async () => {
    const { svc } = makeService()
    const link = await svc.create({})
    await svc.revoke(link.id)
    await expect(svc.extend(link.id, { hours: 1 })).rejects.toMatchObject({ status: 400 })
  })

  it('expired 状态同样拒绝操作（模拟扫描后）', async () => {
    const db = makeTestDb()
    const repo = makeRepo(db)
    const monitor = makeMonitor(db)
    const svc = createLinkService({
      db, repo, monitor,
      xray: stubXray(),
      limits,
      now: () => 1_700_000_000_000,
    })
    const link = await svc.create({ hours: 1 })
    db.prepare("UPDATE links SET status='expired' WHERE id=?").run(link.id)
    await expect(svc.extend(link.id, { hours: 1 })).rejects.toMatchObject({ status: 400 })
  })
})

describe('extend', () => {
  it('extend：仅 active，expires_at 增加 hours，不触 xray', async () => {
    const removeUser = vi.fn(async () => 1)
    const addUser = vi.fn(async () => undefined)
    const xray = stubXray({ removeUser, addUser })
    const { svc } = makeService({ xray })
    const link = await svc.create({ hours: 1 })
    // create 已调用过 addUser；清空计数后再断言 extend 不触 xray
    addUser.mockClear()
    removeUser.mockClear()
    const ext = await svc.extend(link.id, { hours: 5 })
    expect(ext.expiresAt - link.expiresAt).toBe(5 * 3600 * 1000)
    expect(addUser).not.toHaveBeenCalled()
    expect(removeUser).not.toHaveBeenCalled()
  })

  it('extend 非法时长 → 400', async () => {
    const { svc } = makeService()
    const link = await svc.create({})
    await expect(svc.extend(link.id, { hours: 0 })).rejects.toMatchObject({ status: 400 })
    await expect(svc.extend(link.id, { hours: 721 })).rejects.toMatchObject({ status: 400 })
  })

  it('不存在的链接 → 404', async () => {
    const { svc } = makeService()
    await expect(svc.revoke('nope')).rejects.toMatchObject({ status: 404 })
    await expect(svc.extend('nope', { hours: 1 })).rejects.toMatchObject({ status: 404 })
  })
})

describe('extend expiresAt 绝对过期时刻（TASK-extend-regions.md 需求 1）', () => {
  const NOW = 1_700_000_000_000

  it('传 expiresAt → expires_at 精确设为该值；详情写 {expiresAt}', async () => {
    const { svc, repo, monitor } = makeService({ now: () => NOW })
    const link = await svc.create({ hours: 1 })
    const at = NOW + 3 * 3600 * 1000
    const ext = await svc.extend(link.id, { expiresAt: at })
    expect(ext.expiresAt).toBe(at)
    expect(repo.byId(link.id)!.expires_at).toBe(at)
    const audit = monitor.listAudit({ limit: 10, offset: 0 }).rows[0]!
    expect(audit.action).toBe('extend')
    expect(audit.detail).toMatchObject({ expiresAt: at, expires_at: at })
    expect((audit.detail as Record<string, unknown>).hours).toBeUndefined()
  })

  it('expiresAt 可提前（缩短有效期），仍精确生效', async () => {
    const { svc, repo } = makeService({ now: () => NOW })
    const link = await svc.create({ hours: 48 })
    const earlier = link.expiresAt - 2 * 3600 * 1000 // 比当前到期提前 2h，仍晚于 now
    const ext = await svc.extend(link.id, { expiresAt: earlier })
    expect(ext.expiresAt).toBe(earlier)
    expect(repo.byId(link.id)!.expires_at).toBe(earlier)
  })

  it('expiresAt 早于当前时间 → 400', async () => {
    const { svc } = makeService({ now: () => NOW })
    const link = await svc.create({ hours: 1 })
    await expect(svc.extend(link.id, { expiresAt: NOW })).rejects.toMatchObject({ status: 400 })
    await expect(svc.extend(link.id, { expiresAt: NOW - 1000 })).rejects.toMatchObject({ status: 400 })
  })

  it('expiresAt 超过 365 天 → 400（sanity 上限）', async () => {
    const { svc } = makeService({ now: () => NOW })
    const link = await svc.create({ hours: 1 })
    const tooFar = NOW + 366 * 24 * 3600 * 1000
    await expect(svc.extend(link.id, { expiresAt: tooFar })).rejects.toMatchObject({ status: 400 })
    const ok = NOW + 365 * 24 * 3600 * 1000
    const ext = await svc.extend(link.id, { expiresAt: ok })
    expect(ext.expiresAt).toBe(ok)
  })

  it('非整数 / 非有限 expiresAt → 400', async () => {
    const { svc } = makeService({ now: () => NOW })
    const link = await svc.create({ hours: 1 })
    await expect(svc.extend(link.id, { expiresAt: 1.5 })).rejects.toMatchObject({ status: 400 })
    await expect(svc.extend(link.id, { expiresAt: NaN })).rejects.toMatchObject({ status: 400 })
  })

  it('expiresAt 与 hours 都传 → 400；都不传 → 400', async () => {
    const { svc, repo } = makeService({ now: () => NOW })
    const link = await svc.create({ hours: 1 })
    const orig = repo.byId(link.id)!.expires_at
    await expect(
      svc.extend(link.id, { expiresAt: NOW + 3600 * 1000, hours: 1 }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(svc.extend(link.id, {})).rejects.toMatchObject({ status: 400 })
    // 双传/都不传均不落地：expires_at 未变
    expect(repo.byId(link.id)!.expires_at).toBe(orig)
  })

  it('audit 详情区分：hours 模式仍写 {hours, expires_at}；actor 透传', async () => {
    const { svc, monitor } = makeService({ now: () => NOW })
    const link = await svc.create({}, 'ops@example')
    await svc.extend(link.id, { hours: 3 }, 'ops@example')
    const extHours = monitor.listAudit({ limit: 10, offset: 0 }).rows[0]!
    expect(extHours).toMatchObject({ actor: 'ops@example', action: 'extend' })
    expect(extHours.detail).toMatchObject({ hours: 3 })
    expect((extHours.detail as Record<string, unknown>).expiresAt).toBeUndefined()
  })
})

describe('操作审计（C 层）', () => {
  function auditRows(monitor: MonitoringRepo): unknown[] {
    return monitor.listAudit({ limit: 100, offset: 0 }).rows
  }

  it('create/revoke/extend 各写一条 audit_log，actor 缺省为 dev', async () => {
    const { svc, monitor } = makeService({ now: () => 1_700_000_000_000 })
    const link = await svc.create({ note: '朋友', hours: 2 })
    await svc.revoke(link.id)
    const rows = auditRows(monitor)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ actor: 'dev', action: 'revoke', link_id: link.id })
    expect(rows[1]).toMatchObject({
      actor: 'dev',
      action: 'create',
      link_id: link.id,
      detail: { note: '朋友', hours: 2 },
    })
  })

  it('传入 actor 时按实名记录；detail 为 JSON 对象', async () => {
    const { svc, monitor } = makeService()
    const link = await svc.create({}, 'admin@example')
    await svc.revoke(link.id, 'admin@example')
    const rows = auditRows(monitor)
    expect(rows[0]).toMatchObject({ actor: 'admin@example', action: 'revoke' })
    expect(rows[1]).toMatchObject({ actor: 'admin@example', action: 'create' })
    // extend 的 detail 带 hours
    const link2 = await svc.create({}, 'ops@example')
    await svc.extend(link2.id, { hours: 3 }, 'ops@example')
    const ext = auditRows(monitor)[0]
    expect(ext.action).toBe('extend')
    expect((ext.detail as Record<string, unknown>).hours).toBe(3)
  })

  it('create 时 xray 失败回滚 → 不留 audit 痕迹', async () => {
    const xray = stubXray({ addUser: vi.fn(async () => { throw new Error('down') }) })
    const { svc, monitor } = makeService({ xray })
    await expect(svc.create({})).rejects.toMatchObject({ status: 502 })
    expect(auditRows(monitor)).toHaveLength(0)
  })
})

// 永久有效（expires_at = 哨兵 0）—— 用户 2026-09-14 需求
describe('永久链接（permanent）', () => {
  it('create permanent → expires_at=0、view.permanent=true、status=active', async () => {
    const { svc, repo } = makeService()
    const link = await svc.create({ note: ' 长期 ', permanent: true })
    expect(link.permanent).toBe(true)
    expect(link.expiresAt).toBe(0)
    expect(link.status).toBe('active')
    expect(link.note).toBe('长期')
    expect(repo.byId(link.id)!.expires_at).toBe(0)
  })

  it('create 非 permanent → permanent=false（默认路径不受影响）', async () => {
    const { svc } = makeService()
    const link = await svc.create({ hours: 2 })
    expect(link.permanent).toBe(false)
    expect(link.expiresAt).toBeGreaterThan(0)
  })

  it('审计 detail 记 { permanent: true }（而非 hours）', async () => {
    const { svc, monitor } = makeService()
    await svc.create({ permanent: true })
    const rows = monitor.listAudit({ limit: 10, offset: 0 }).rows
    const create = rows.find((r) => r.action === 'create')!
    expect(create.detail as Record<string, unknown>).toMatchObject({ permanent: true })
    expect((create.detail as Record<string, unknown>).hours).toBeUndefined()
  })

  it('permanent 与 hours 互斥 → 400', async () => {
    const { svc } = makeService()
    await expect(svc.create({ permanent: true, hours: 3 })).rejects.toMatchObject({ status: 400 })
  })

  it('permanent 非布尔 → 400', async () => {
    const { svc } = makeService()
    await expect(
      svc.create({ permanent: 'yes' as unknown as boolean }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('extend 三选一校验：多传 / 都不传 → 400', async () => {
    const { svc } = makeService()
    const link = await svc.create({ hours: 1 })
    await expect(svc.extend(link.id, { hours: 1, permanent: true })).rejects.toMatchObject({ status: 400 })
    await expect(
      svc.extend(link.id, { hours: 1, expiresAt: 1_700_000_000_000 + 1000 }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(svc.extend(link.id, {})).rejects.toMatchObject({ status: 400 })
  })

  it('限时 → 永久：expires_at 置哨兵 0、view.permanent=true、审计 {permanent:true}', async () => {
    const { svc, repo, monitor } = makeService()
    const link = await svc.create({ hours: 2 })
    const conv = await svc.extend(link.id, { permanent: true })
    expect(conv.permanent).toBe(true)
    expect(conv.expiresAt).toBe(0)
    expect(repo.byId(link.id)!.expires_at).toBe(0)
    const row = monitor.listAudit({ limit: 5, offset: 0 }).rows.find((r) => r.action === 'extend')!
    expect(row.detail as Record<string, unknown>).toMatchObject({ permanent: true })
  })

  it('永久 → 限时：expiresAt 精确设值、permanent=false、审计标 from=permanent', async () => {
    const NOW = 1_700_000_000_000
    const { svc, repo, monitor } = makeService({ now: () => NOW })
    const link = await svc.create({ permanent: true })
    const at = NOW + 6 * 3600 * 1000
    const conv = await svc.extend(link.id, { expiresAt: at })
    expect(conv.permanent).toBe(false)
    expect(conv.expiresAt).toBe(at)
    expect(repo.byId(link.id)!.expires_at).toBe(at)
    const row = monitor.listAudit({ limit: 5, offset: 0 }).rows.find((r) => r.action === 'extend')!
    expect(row.detail as Record<string, unknown>).toMatchObject({ from: 'permanent' })
  })

  it('永久 + hours → 400（无基准时刻）；永久 + permanent → 400（已是永久）', async () => {
    const { svc } = makeService()
    const link = await svc.create({ permanent: true })
    await expect(svc.extend(link.id, { hours: 3 })).rejects.toMatchObject({ status: 400 })
    await expect(svc.extend(link.id, { permanent: true })).rejects.toMatchObject({ status: 400 })
  })

  it('永久链接仍可吊销（不因永久而不可逆）', async () => {
    const { svc } = makeService()
    const link = await svc.create({ permanent: true })
    const revoked = await svc.revoke(link.id)
    expect(revoked.status).toBe('revoked')
  })
})

// HttpError 构造可用性
describe('HttpError', () => {
  it('实例可携带 status', () => {
    const e = new HttpError(502, 'x')
    expect(e.status).toBe(502)
    expect(e.message).toBe('x')
  })
})
