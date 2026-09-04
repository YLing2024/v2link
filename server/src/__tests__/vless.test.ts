import { describe, expect, it } from 'vitest'
import { buildVlessUri, buildInboundFragment, linkToVlessUri } from '../lib/vless.js'

describe('buildVlessUri', () => {
  it('默认 tls + ws，path 做 URL 编码，host 参数与主机一致', () => {
    const uri = buildVlessUri({
      host: 'v2.example.com',
      path: '/v2ws',
      uuid: '11111111-1111-4111-8111-111111111111',
    })
    expect(uri).toBe(
      'vless://11111111-1111-4111-8111-111111111111@v2.example.com:443?encryption=none&type=ws&security=tls&path=%2Fv2ws&host=v2.example.com',
    )
  })

  it('指定端口/无 TLS', () => {
    const uri = buildVlessUri({
      host: 'h.example.com',
      port: 8080,
      path: 'ws',
      security: 'none',
      uuid: 'u',
    })
    expect(uri).toContain('@h.example.com:8080?')
    expect(uri).toContain('type=ws')
    expect(uri).not.toContain('security=')
    // path 自动补 /
    expect(uri).toContain('path=%2Fws')  })
})

describe('buildInboundFragment', () => {
  it('带限速：生成完整 inbounds 包装（adu 必需）+ speedLimit 字段', () => {
    const frag = buildInboundFragment(
      { email: 'lk_abc', uuid: 'u', speedMbps: 5 },
      'vless-in',
    )
    expect(frag.inbounds).toHaveLength(1)
    const inbound = frag.inbounds[0] as { tag: string; protocol: string; settings: { clients: unknown[] } }
    expect(inbound.tag).toBe('vless-in')
    expect(inbound.protocol).toBe('vless')
    expect(inbound.settings.clients).toEqual([
      {
        id: 'u',
        email: 'lk_abc',
        level: 0,
        speedLimitUpMbps: 5,
        speedLimitDownMbps: 5,
      },
    ])
  })

  it('speedMbps=0（不限）→ 不携带 speedLimit 字段', () => {
    const frag = buildInboundFragment({ email: 'e', uuid: 'u', speedMbps: 0 }, 'vless-in')
    const clients = (frag.inbounds[0] as { settings: { clients: Record<string, unknown>[] } })
      .settings.clients
    expect(clients[0]).toEqual({ id: 'u', email: 'e', level: 0 })
  })
})

describe('linkToVlessUri', () => {
  it('基于 row.uuid 生成，宿主由参数注入', () => {
    const uri = linkToVlessUri({ uuid: 'uuid-1' }, 'node.example.com', '/x')
    expect(uri).toContain('uuid-1@node.example.com')
  })
})
