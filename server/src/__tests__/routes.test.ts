import express from 'express'
import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { makeMonitor, makeRepo, makeTestDb } from './helpers.js'
import { createLinksRouter } from '../routes/links.js'
import { createAuditRouter } from '../routes/audit.js'
import { createRegionsRouter } from '../routes/regions.js'
import { createLinkService } from '../services/linkService.js'
import { createRegionProbeService } from '../services/regionProbe.js'
import { createHealthRouter } from '../routes/health.js'
import type { XrayClient } from '../services/xrayClient.js'

// /api/links 追溯子路由 + /api/audit 路由（TASK-monitoring.md A/B/C 对外接口）。
// 说明：链接创建真实走 service（连 xray mock），据此拿到真实 link 与 audit 行。

function stubXray(): XrayClient {
  return {
    addUser: async () => undefined,
    removeUser: async () => 1,
    queryTraffic: async () => '{}',
  } as unknown as XrayClient
}

describe('GET /api/healthz', () => {
  it('返回进程运行秒数（取整）', async () => {
    const app = express()
    app.use('/api/healthz', createHealthRouter())
    const before = Math.floor(process.uptime())
    const res = await request(app).get('/api/healthz')
    const after = Math.floor(process.uptime())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, data: { status: 'ok' } })
    expect(Number.isInteger(res.body.data.uptime)).toBe(true)
    expect(res.body.data.uptime).toBeGreaterThanOrEqual(before)
    expect(res.body.data.uptime).toBeLessThanOrEqual(after)
  })
})

async function makeApp() {
  const db = makeTestDb()
  const repo = makeRepo(db)
  const monitor = makeMonitor(db)
  const service = createLinkService({
    db,
    repo,
    monitor,
    xray: stubXray(),
    limits: { defaultHours: 24, maxHours: 720 },
  })
  const link = await service.create({ note: 'rt', hours: 1 }, 'tester')
  const app = express()
  app.use(express.json())
  // 不挂鉴权中间件：单测直接暴露 route（auth 已由 linkService.test 覆盖 actor 链路）
  app.use('/api/links', createLinksRouter(service, monitor))
  app.use('/api/audit', createAuditRouter(monitor))
  return { app, db, monitor, link }
}

describe('GET /api/links/:id/traffic', () => {
  it('空数据返回近 24h 的 hour 连续桶（补零），不报错', async () => {
    const { app, link } = await makeApp()
    const res = await request(app).get(`/api/links/${link.id}/traffic?bucket=hour`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const arr = res.body.data as { ts: number; up: number; down: number }[]
    expect(Array.isArray(arr)).toBe(true)
    expect(arr.length).toBeGreaterThanOrEqual(24)
    expect(arr[0]).toMatchObject({ up: 0, down: 0 })
  })

  it('有采样时按桶聚合 up/down；bucket=day 生效', async () => {
    const { app, link, db } = await makeApp()
    const now = Date.now()
    const hourStart = now - (now % 3600_000)
    const ins = db.prepare(
      `INSERT INTO traffic_samples (link_id, ts, up_delta, down_delta) VALUES (?,?,?,?)`,
    )
    ins.run(link.id, hourStart + 1000, 5, 10)
    ins.run(link.id, hourStart + 2000, 1, 2)
    ins.run(link.id, hourStart - 1, 100, 200) // 上一整点桶
    const from = hourStart - 3600_000
    const to = now + 1
    const res = await request(app).get(
      `/api/links/${link.id}/traffic?bucket=hour&from=${from}&to=${to}`,
    )
    expect(res.status).toBe(200)
    const arr = res.body.data as { ts: number; up: number; down: number }[]
    const cur = arr.find((p) => p.ts === hourStart)!
    const prev = arr.find((p) => p.ts === hourStart - 3600_000)!
    expect(cur.up).toBe(6)
    expect(cur.down).toBe(12)
    expect(prev.up).toBe(100)
  })
})

describe('GET /api/links/:id/connections', () => {
  it('分页返回（ts 倒序）+ total + host 前缀搜索', async () => {
    const { app, link, db } = await makeApp()
    const ins = db.prepare(
      `INSERT INTO connections (link_id, email, ts, host, port) VALUES (?,?,?,?,?)`,
    )
    ins.run(link.id, link.id, 1003, 'h3.example', 443)
    ins.run(link.id, link.id, 1002, 'h2.example', 443)
    ins.run(link.id, link.id, 1001, 'other.example', 443)
    const res = await request(app).get(`/api/links/${link.id}/connections?limit=2&offset=0`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(3)
    expect(res.body.data.rows).toHaveLength(2)
    expect((res.body.data.rows[0] as { ts: number }).ts).toBe(1003)

    const search = await request(app).get(`/api/links/${link.id}/connections?q=h2`)
    expect(search.body.data.total).toBe(1)
    expect((search.body.data.rows[0] as { host: string }).host).toBe('h2.example')
  })
})

describe('GET /api/audit', () => {
  it('返回审计分页（ts 倒序）；create 写 audit_log', async () => {
    const { app } = await makeApp()
    const res = await request(app).get('/api/audit?limit=10')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.total).toBe(1)
    expect(res.body.data.rows[0]).toMatchObject({ actor: 'tester', action: 'create' })
  })
})

describe('POST /api/links/:id/extend（TASK-extend-regions.md 需求 1）', () => {
  it('expiresAt 绝对时刻 → 精确设置；过期时间返回毫秒时间戳', async () => {
    const { app, link } = await makeApp()
    const at = Date.now() + 7 * 3600 * 1000
    const res = await request(app)
      .post(`/api/links/${link.id}/extend`)
      .send({ expiresAt: at })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect((res.body.data as { expiresAt: number }).expiresAt).toBe(at)
  })

  it('hours 兼容旧行为（相对延长）', async () => {
    const { app, link } = await makeApp()
    const before = (await request(app).get('/api/links')).body.data as {
      id: string
      expiresAt: number
    }[]
    const orig = before.find((l) => l.id === link.id)!.expiresAt
    const res = await request(app).post(`/api/links/${link.id}/extend`).send({ hours: 3 })
    expect(res.status).toBe(200)
    expect((res.body.data as { expiresAt: number }).expiresAt).toBe(orig + 3 * 3600 * 1000)
  })

  it('expiresAt 与 hours 都传 → 400；都不传 → 400；过去时间 → 400', async () => {
    const { app, link } = await makeApp()
    const both = await request(app)
      .post(`/api/links/${link.id}/extend`)
      .send({ expiresAt: Date.now() + 3600 * 1000, hours: 1 })
    expect(both.status).toBe(400)
    const none = await request(app).post(`/api/links/${link.id}/extend`).send({})
    expect(none.status).toBe(400)
    const past = await request(app).post(`/api/links/${link.id}/extend`).send({ expiresAt: 1 })
    expect(past.status).toBe(400)
  })

  it('非 active 链接（expired）extend → 400', async () => {
    const db = makeTestDb()
    const repo = makeRepo(db)
    const monitor = makeMonitor(db)
    const service = createLinkService({
      db,
      repo,
      monitor,
      xray: stubXray(),
      limits: { defaultHours: 24, maxHours: 720 },
    })
    const link = await service.create({ hours: 1 }, 'tester')
    db.prepare("UPDATE links SET status='expired' WHERE id=?").run(link.id)
    const app = express()
    app.use(express.json())
    app.use('/api/links', createLinksRouter(service, monitor))
    const res = await request(app)
      .post(`/api/links/${link.id}/extend`)
      .send({ expiresAt: Date.now() + 3600 * 1000 })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/regions/probes（TASK-extend-regions.md 需求 2）', () => {
  it('空快照（未跑过）→ updatedAt=0 probes=[]；跑一轮后返回地区结果', async () => {
    const probe = createRegionProbeService({
      probes: [
        { key: 'us', name: '美国', flag: '🇺🇸', url: 'https://us.example/generate_204' },
        { key: 'jp', name: '日本', flag: '🇯🇵', url: 'https://jp.example/' },
      ],
      fetchFn: (async () => ({ ok: true, status: 204 } as unknown as Response)) as unknown as typeof fetch,
      logger: () => undefined,
    })
    const app = express()
    app.use(express.json())
    app.use('/api/regions', createRegionsRouter(probe))

    const empty = await request(app).get('/api/regions/probes')
    expect(empty.status).toBe(200)
    expect(empty.body.ok).toBe(true)
    expect(empty.body.data.updatedAt).toBe(0)
    expect(empty.body.data.probes).toEqual([])

    await probe.runRound()
    const res = await request(app).get('/api/regions/probes')
    expect(res.status).toBe(200)
    expect(res.body.data.probes).toHaveLength(2)
    expect(res.body.data.probes[0]).toMatchObject({ key: 'us', ok: true, rttMs: expect.any(Number) })
    expect(res.body.data.history).toHaveLength(1)
  })

  it('地区失败 → ok=false + error 文案（timeout）', async () => {
    const probe = createRegionProbeService({
      probes: [{ key: 'us', name: '美国', flag: '🇺🇸', url: 'https://us.example/generate_204' }],
      fetchFn: (async () => {
        throw new DOMException('aborted', 'AbortError')
      }) as unknown as typeof fetch,
      logger: () => undefined,
    })
    await probe.runRound()
    const app = express()
    app.use(express.json())
    app.use('/api/regions', createRegionsRouter(probe))
    const res = await request(app).get('/api/regions/probes')
    expect(res.body.data.probes[0]).toMatchObject({ key: 'us', ok: false, error: 'timeout', rttMs: null })
  })
})
