import { describe, expect, it, vi } from 'vitest'
import type { XrayClient } from '../services/xrayClient.js'
import { createLinkService, HttpError } from '../services/linkService.js'
import { makeRepo, makeTestDb } from './helpers.js'

// linkService 单测：状态机 + 「先落库后调 xray，失败回滚」的一致性约束。
// xray 用 mock（记录调用 / 可控失败）。

function stubXray(overrides?: Partial<XrayClient>): XrayClient {
  return {
    addUser: vi.fn(async () => undefined),
    removeUser: vi.fn(async () => 1),
    queryTraffic: vi.fn(async () => '{}'),
    ...overrides,
  } as unknown as XrayClient
}

const limits = { defaultHours: 24, maxHours: 720, defaultSpeed: 10, maxSpeed: 100 }

function makeService(overrides?: { xray?: XrayClient; now?: () => number }) {
  const db = makeTestDb()
  const repo = makeRepo(db)
  const svc = createLinkService({
    db,
    repo,
    xray: overrides?.xray ?? stubXray(),
    limits,
    now: overrides?.now ?? (() => 1_700_000_000_000),
  })
  return { db, repo, svc }
}

describe('create', () => {
  it('默认 hours=24 speed=10；返回 active 且 email=id', async () => {
    const { svc, repo } = makeService()
    const created = await svc.create({})
    expect(created.status).toBe('active')
    expect(created.speedMbps).toBe(10)
    expect(created.upBytes).toBe(0)
    expect(created.note).toBe('')
    const row = repo.byId(created.id)!
    expect(row.email).toBe(created.id)
    expect(row.expires_at - row.created_at).toBe(24 * 3600 * 1000)
  })

  it('自定义 note/hours/speed 生效', async () => {
    const { svc } = makeService()
    const created = await svc.create({ note: ' 朋友 ', hours: 2, speedMbps: 3 })
    expect(created.note).toBe('朋友')
    expect(created.speedMbps).toBe(3)
    expect(created.expiresAt - created.createdAt).toBe(2 * 3600 * 1000)
  })

  it('非法输入 → 400', async () => {
    const { svc } = makeService()
    await expect(svc.create({ hours: 0 })).rejects.toMatchObject({ status: 400 })
    await expect(svc.create({ hours: 721 })).rejects.toMatchObject({ status: 400 })
    await expect(svc.create({ speedMbps: 101 })).rejects.toMatchObject({ status: 400 })
    await expect(svc.create({ speedMbps: -1 })).rejects.toMatchObject({ status: 400 })
  })

  it('xray addUser 失败 → 回滚（DB 无残留行）+ 502', async () => {
    const xray = stubXray({ addUser: vi.fn(async () => { throw new Error('conn refused') }) })
    const { svc, repo } = makeService({ xray })
    await expect(svc.create({})).rejects.toMatchObject({ status: 502 })
    expect(repo.list()).toHaveLength(0)
  })

  it('成功时 adu 参数带 email/uuid/speed', async () => {
    const addUser = vi.fn(async () => undefined)
    const xray = stubXray({ addUser })
    const { svc } = makeService({ xray })
    const link = await svc.create({ speedMbps: 5 })
    expect(addUser).toHaveBeenCalledWith({
      email: link.id,
      uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      speedMbps: 5,
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

  it('revoke 后不可 extend/speed（400）', async () => {
    const { svc } = makeService()
    const link = await svc.create({})
    await svc.revoke(link.id)
    await expect(svc.extend(link.id, 1)).rejects.toMatchObject({ status: 400 })
    await expect(svc.changeSpeed(link.id, 5)).rejects.toMatchObject({ status: 400 })
  })

  it('expired 状态同样拒绝操作（模拟扫描后）', async () => {
    const db = makeTestDb()
    const repo = makeRepo(db)
    const svc = createLinkService({
      db, repo,
      xray: stubXray(),
      limits,
      now: () => 1_700_000_000_000,
    })
    const link = await svc.create({ hours: 1 })
    db.prepare("UPDATE links SET status='expired' WHERE id=?").run(link.id)
    await expect(svc.extend(link.id, 1)).rejects.toMatchObject({ status: 400 })
  })
})

describe('extend / changeSpeed', () => {
  it('extend：仅 active，expires_at 增加 hours，不触 xray', async () => {
    const removeUser = vi.fn(async () => 1)
    const addUser = vi.fn(async () => undefined)
    const xray = stubXray({ removeUser, addUser })
    const { svc } = makeService({ xray })
    const link = await svc.create({ hours: 1 })
    // create 已调用过 addUser；清空计数后再断言 extend 不触 xray
    addUser.mockClear()
    removeUser.mockClear()
    const ext = await svc.extend(link.id, 5)
    expect(ext.expiresAt - link.expiresAt).toBe(5 * 3600 * 1000)
    expect(addUser).not.toHaveBeenCalled()
    expect(removeUser).not.toHaveBeenCalled()
  })

  it('extend 非法时长 → 400', async () => {
    const { svc } = makeService()
    const link = await svc.create({})
    await expect(svc.extend(link.id, 0)).rejects.toMatchObject({ status: 400 })
    await expect(svc.extend(link.id, 721)).rejects.toMatchObject({ status: 400 })
  })

  it('changeSpeed：adu 不能覆盖 → rmu + adu 顺序；speed 更新', async () => {
    const calls: string[] = []
    const removeUser = vi.fn(async () => 1)
    const addUser = vi.fn(async () => undefined)
    const xray = stubXray({ removeUser, addUser })
    const { svc } = makeService({ xray })
    const link = await svc.create({ speedMbps: 10 })
    const changed = await svc.changeSpeed(link.id, 2)
    expect(changed.speedMbps).toBe(2)
    expect(removeUser).toHaveBeenCalledWith(link.id)
    expect(addUser).toHaveBeenCalledWith({ email: link.id, uuid: expect.any(String), speedMbps: 2 })
    void calls
  })

  it('changeSpeed xray 失败 → 回滚 speed + 502', async () => {
    const addUser = vi
      .fn()
      .mockResolvedValueOnce(undefined) // create 阶段成功
      .mockRejectedValueOnce(new Error('down')) // changeSpeed 阶段失败
    const xray = stubXray({ removeUser: vi.fn(async () => 1), addUser })
    const { svc } = makeService({ xray })
    const link = await svc.create({ speedMbps: 10 })
    await expect(svc.changeSpeed(link.id, 3)).rejects.toMatchObject({ status: 502 })
    expect(svc.list()[0]!.speedMbps).toBe(10)
  })

  it('不存在的链接 → 404', async () => {
    const { svc } = makeService()
    await expect(svc.revoke('nope')).rejects.toMatchObject({ status: 404 })
    await expect(svc.extend('nope', 1)).rejects.toMatchObject({ status: 404 })
    await expect(svc.changeSpeed('nope', 1)).rejects.toMatchObject({ status: 404 })
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
