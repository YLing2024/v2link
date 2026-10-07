import { describe, expect, it } from 'vitest'
import { makeMonitor, makeRepo, makeTestDb } from './helpers.js'
import { createClashSubRepo } from '../db/clashSubRepo.js'
import { createLinkService, HttpError } from '../services/linkService.js'
import { createClashService } from '../services/clashService.js'
import type { XrayClient } from '../services/xrayClient.js'

// clashService 单测：创建校验/400、忽略不存在 id、TTL、audit、GET 200/404/吊销过滤。

function stubXray(): XrayClient {
  return {
    addUser: async () => undefined,
    removeUser: async () => 1,
    queryTraffic: async () => '{}',
  } as unknown as XrayClient
}

function setup() {
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
  let now = Date.now()
  const clash = createClashService({
    repo,
    clashSubs,
    monitor,
    publicBaseUrl: 'https://v2.example.com',
    ttlMs: 600_000,
    host: 'v2.example.com',
    sni: 'v2.example.com',
    path: '/v2ws',
    now: () => now,
  })
  return {
    db,
    repo,
    monitor,
    clash,
    links,
    setNow: (t: number) => {
      now = t
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

function expectHttpError(fn: () => unknown, status: number, msgPart: string) {
  try {
    fn()
    throw new Error('应当抛错但没有')
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError)
    expect((e as HttpError).status).toBe(status)
    expect((e as HttpError).message).toContain(msgPart)
  }
}

describe('clashService.create', () => {
  it('空数组 / 超限 → 400 中文报错', async () => {
    const { clash } = setup()
    expectHttpError(() => clash.create([], 'tester'), 400, '1~50')
    const tooMany = Array.from({ length: 51 }, (_, i) => `lk_${i}`)
    expectHttpError(() => clash.create(tooMany, 'tester'), 400, '1~50')
  })

  it('忽略不存在的 id 并在 skipped 回报；节点顺序 = 勾选顺序', async () => {
    const { clash, links } = setup()
    const a = await links.create({ note: 'A' })
    const b = await links.create({ note: 'B' })
    const res = clash.create([b.id, 'lk_missing', a.id], 'tester')
    expect(res.count).toBe(2)
    expect(res.skipped).toEqual(['lk_missing'])
    expect(res.nodes.map((n) => n.id)).toEqual([b.id, a.id])
    expect(res.nodes.map((n) => n.name)).toEqual(['B', 'A'])
  })

  it('url / importUrl 形态正确；TTL 计算正确', async () => {
    const { clash, links, setNow } = setup()
    const fixed = 1_700_000_000_000
    setNow(fixed)
    const a = await links.create({ note: 'A' })
    const res = clash.create([a.id], 'tester')
    expect(res.url).toBe(`https://v2.example.com/api/clash/subscriptions/${res.token}`)
    expect(res.importUrl).toBe(
      `clash://install-config?url=${encodeURIComponent(res.url)}&name=v2link`,
    )
    expect(res.expiresAt).toBe(fixed + 600_000)
    expect(res.ttlSeconds).toBe(600)
    expect(res.token.length).toBeGreaterThanOrEqual(40)
    expect(/^[A-Za-z0-9_-]+$/.test(res.token)).toBe(true)
  })

  it('审计 clash_sub_create：只记节点数与 token 前缀', async () => {
    const { clash, links, monitor } = setup()
    const a = await links.create({ note: 'A' })
    const b = await links.create({ note: 'B' })
    const res = clash.create([a.id, b.id], 'tester')
    const page = monitor.listAudit({ limit: 10, offset: 0 })
    const row = page.rows.find((r) => r.action === 'clash_sub_create')!
    expect(row.actor).toBe('tester')
    expect(row.detail).toMatchObject({ count: 2, token_prefix: res.token.slice(0, 8) })
    expect(JSON.stringify(row.detail)).not.toContain(res.token)
  })

  it('所选链接均不存在 → 400', async () => {
    const { clash } = setup()
    expectHttpError(() => clash.create(['lk_x', 'lk_y'], 'tester'), 400, '均不存在')
  })
})

describe('clashService.get', () => {
  it('200：正文含节点与一致的 group 引用', async () => {
    const { clash, links } = setup()
    const a = await links.create({ note: '节点甲' })
    const b = await links.create({ note: '节点乙' })
    const { token } = clash.create([a.id, b.id], 'tester')
    const sub = clash.get(token)
    expect(sub.count).toBe(2)
    expect(sub.yaml).toContain('  - name: "节点甲"')
    expect(sub.yaml).toContain('  - name: "节点乙"')
    expect(sub.yaml).toContain('      - "节点甲"')
    expect(sub.yaml).toContain('      - "节点乙"')
    expect(sub.userinfo).toContain('upload=0; download=0')
  })

  it('未知 token → 404 订阅不存在', () => {
    const { clash } = setup()
    expectHttpError(() => clash.get('nope'), 404, '订阅不存在')
  })

  it('过期 → 404 订阅已过期', async () => {
    const { clash, links, advance } = setup()
    const a = await links.create({ note: 'A' })
    const { token } = clash.create([a.id], 'tester')
    advance(600_001)
    expectHttpError(() => clash.get(token), 404, '订阅已过期')
  })

  it('已吊销节点从正文消失；全部失效 → 404', async () => {
    const { clash, links, db } = setup()
    const a = await links.create({ note: 'A' })
    const b = await links.create({ note: 'B' })
    const { token } = clash.create([a.id, b.id], 'tester')
    db.prepare("UPDATE links SET status='revoked', revoked_at=? WHERE id=?").run(Date.now(), a.id)
    const sub = clash.get(token)
    expect(sub.count).toBe(1)
    expect(sub.yaml).not.toContain('  - name: "A"')
    expect(sub.yaml).toContain('  - name: "B"')

    db.prepare("UPDATE links SET status='revoked', revoked_at=? WHERE id=?").run(Date.now(), b.id)
    expectHttpError(() => clash.get(token), 404, '均已失效')
  })
})
