import express from 'express'
import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { makeMonitor, makeRepo, makeTestDb } from './helpers.js'
import { createClashSubRepo } from '../db/clashSubRepo.js'
import { createLinkService } from '../services/linkService.js'
import { createClashService } from '../services/clashService.js'
import { createClashRouter } from '../routes/clash.js'
import type { XrayClient } from '../services/xrayClient.js'

// /api/clash 路由：GET 免鉴权 + 响应头；POST 需鉴权。
// 用测试中间件模拟鉴权：带 x-test-user 头即通过（并写入 req.authUser），否则 401。

function stubXray(): XrayClient {
  return {
    addUser: async () => undefined,
    removeUser: async () => 1,
    queryTraffic: async () => '{}',
  } as unknown as XrayClient
}

async function makeApp() {
  const db = makeTestDb()
  const repo = makeRepo(db)
  const monitor = makeMonitor(db)
  const clashSubs = createClashSubRepo(db)
  const links = createLinkService({
    db,
    repo,
    monitor,
    xray: stubXray(),
    limits: { defaultHours: 24, maxHours: 720 },
  })
  const clash = createClashService({
    repo,
    clashSubs,
    monitor,
    publicBaseUrl: 'https://v2.example.com',
    ttlMs: 600_000,
    host: 'v2.example.com',
    sni: 'v2.example.com',
    path: '/v2ws',
  })
  const authRequired = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const u = req.get('x-test-user')
    if (u) {
      req.authUser = u
      return next()
    }
    res.status(401).json({ ok: false, error: '未登录' })
  }
  const app = express()
  app.use(express.json())
  app.use('/api/clash', createClashRouter(clash, authRequired))
  const a = await links.create({ note: '甲' })
  const b = await links.create({ note: '乙' })
  return { app, a, b }
}

describe('POST /api/clash/subscriptions', () => {
  it('未登录 → 401', async () => {
    const { app, a } = await makeApp()
    const res = await request(app).post('/api/clash/subscriptions').send({ linkIds: [a.id] })
    expect(res.status).toBe(401)
    expect(res.body.ok).toBe(false)
  })

  it('空数组 → 400 中文；成功 → 201 + 出参形态', async () => {
    const { app, a } = await makeApp()
    const empty = await request(app)
      .post('/api/clash/subscriptions')
      .set('x-test-user', 'tester')
      .send({ linkIds: [] })
    expect(empty.status).toBe(400)
    expect(empty.body.error).toContain('1~50')

    const ok = await request(app)
      .post('/api/clash/subscriptions')
      .set('x-test-user', 'tester')
      .send({ linkIds: [a.id] })
    expect(ok.status).toBe(201)
    expect(ok.body.ok).toBe(true)
    expect(ok.body.data).toMatchObject({ count: 1, skipped: [], ttlSeconds: 600 })
    expect(ok.body.data.url).toContain('/api/clash/subscriptions/')
  })
})

describe('GET /api/clash/subscriptions/:token', () => {
  it('未知 token → 404 纯文本（不是 401/HTML）', async () => {
    const { app } = await makeApp()
    const res = await request(app).get('/api/clash/subscriptions/nope')
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.text).toContain('订阅不存在')
  })

  it('未登录直接抓订阅地址 → 200（token 即凭据）并带正确响应头', async () => {
    const { app, a, b } = await makeApp()
    const created = await request(app)
      .post('/api/clash/subscriptions')
      .set('x-test-user', 'tester')
      .send({ linkIds: [a.id, b.id] })
    const token = created.body.data.token as string

    // 不带任何鉴权头
    const res = await request(app).get(`/api/clash/subscriptions/${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/yaml')
    expect(res.headers['content-disposition']).toBe('attachment; filename="v2link.yaml"')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['subscription-userinfo']).toContain('upload=0')
    expect(res.text).toContain('  - name: "甲"')
    expect(res.text).toContain('  - name: "乙"')
    expect(res.text).toContain('      - "甲"')
  })
})
