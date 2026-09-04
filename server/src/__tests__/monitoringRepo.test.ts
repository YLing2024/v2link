import { describe, expect, it } from 'vitest'
import { makeMonitor, makeRepo, makeTestDb } from './helpers.js'

// monitoringRepo 单测：三张表的批量写 + 索引查询语义 + 分页/计数（A/B/C 数据访问层）。

describe('traffic_samples', () => {
  it('批量插入 + 按链接/时间范围查询', () => {
    const db = makeTestDb()
    const mon = makeMonitor(db)
    const repo = makeRepo(db)
    repo.insert({ id: 'lk_a', uuid: crypto.randomUUID(), email: 'lk_a', note: '', up_bytes: 0, down_bytes: 0, created_at: 1, expires_at: 2, revoked_at: null, status: 'active' })
    repo.insert({ id: 'lk_b', uuid: crypto.randomUUID(), email: 'lk_b', note: '', up_bytes: 0, down_bytes: 0, created_at: 1, expires_at: 2, revoked_at: null, status: 'active' })
    mon.insertSamples([
      { link_id: 'lk_a', ts: 1000, up_delta: 1, down_delta: 2 },
      { link_id: 'lk_a', ts: 2000, up_delta: 3, down_delta: 4 },
      { link_id: 'lk_b', ts: 1500, up_delta: 9, down_delta: 9 },
    ])
    expect(mon.listSamples({ id: 'lk_a', from: 0, to: 3000 })).toHaveLength(2)
    expect(mon.listSamples({ id: 'lk_a', from: 1500, to: 3000 })).toHaveLength(1)
    expect(mon.listSamples({ email: 'lk_b', from: 0, to: 3000 })).toHaveLength(1)
    expect(mon.listSamples({ id: 'lk_a', from: 0, to: 500 })).toHaveLength(0)
  })
})

describe('connections', () => {
  function seedLink(repo: ReturnType<typeof makeRepo>, id: string) {
    repo.insert({ id, uuid: crypto.randomUUID(), email: id, note: '', up_bytes: 0, down_bytes: 0, created_at: 1, expires_at: 2, revoked_at: null, status: 'active' })
  }

  it('分页：ts 倒序 + total + host 前缀搜索', () => {
    const db = makeTestDb()
    const mon = makeMonitor(db)
    const repo = makeRepo(db)
    seedLink(repo, 'lk_a')
    mon.insertConnections([
      { link_id: 'lk_a', email: 'lk_a', ts: 3000, host: 'api.example.com', port: 443, up_bytes: null, down_bytes: null, duration_ms: null },
      { link_id: 'lk_a', email: 'lk_a', ts: 2000, host: 'www.gstatic.com', port: 443, up_bytes: null, down_bytes: null, duration_ms: null },
      { link_id: 'lk_a', email: 'lk_a', ts: 1000, host: 'cdn.cloudflare.com', port: 80, up_bytes: null, down_bytes: null, duration_ms: null },
    ])
    const page1 = mon.listConnections({ link_id: 'lk_a', limit: 2, offset: 0 })
    expect(page1.total).toBe(3)
    expect(page1.rows.map((r) => r.ts)).toEqual([3000, 2000])
    const page2 = mon.listConnections({ link_id: 'lk_a', limit: 2, offset: 2 })
    expect(page2.rows).toHaveLength(1)
    expect(page2.rows[0]!.ts).toBe(1000)
    // host 前缀搜索
    const filtered = mon.listConnections({ link_id: 'lk_a', hostPrefix: 'www', limit: 10, offset: 0 })
    expect(filtered.total).toBe(1)
    expect(filtered.rows[0]!.host).toBe('www.gstatic.com')
  })

  it('email 过滤（链接外也可按 email 追溯）', () => {
    const db = makeTestDb()
    const mon = makeMonitor(db)
    mon.insertConnections([
      { link_id: null, email: 'ghost@x', ts: 1000, host: 'a.com', port: 1, up_bytes: null, down_bytes: null, duration_ms: null },
      { link_id: 'lk_a', email: 'ghost@x', ts: 2000, host: 'b.com', port: 1, up_bytes: null, down_bytes: null, duration_ms: null },
    ])
    const page = mon.listConnections({ email: 'ghost@x', limit: 10, offset: 0 })
    expect(page.total).toBe(2)
    const byLink = mon.listConnections({ link_id: 'lk_a', limit: 10, offset: 0 })
    expect(byLink.total).toBe(1)
  })
})

describe('audit_log', () => {
  it('写 + 分页 + detail 反序列化为对象', () => {
    const db = makeTestDb()
    const mon = makeMonitor(db)
    mon.insertAudit({ ts: 1000, actor: 'dev', action: 'create', link_id: 'lk_a', detail: { hours: 24 } })
    mon.insertAudit({ ts: 2000, actor: 'dev', action: 'revoke', link_id: 'lk_a', detail: null })
    const page = mon.listAudit({ limit: 10, offset: 0 })
    expect(page.total).toBe(2)
    expect(page.rows[0]).toMatchObject({ action: 'revoke', actor: 'dev' })
    expect(page.rows[1].detail).toEqual({ hours: 24 })
    const range = mon.listAudit({ from: 1500, limit: 10, offset: 0 })
    expect(range.total).toBe(1)
    expect(range.rows[0].action).toBe('revoke')
  })
})
