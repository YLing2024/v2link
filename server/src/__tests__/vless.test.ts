import { describe, expect, it } from 'vitest'
import { buildVlessUri, buildInboundFragment, displayAlias, linkToVlessUri } from '../lib/vless.js'

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
  it('生成完整 inbounds 包装（adu 必需）且不携带限速字段', () => {
    const frag = buildInboundFragment({ email: 'lk_abc', uuid: 'u' }, 'vless-in')
    expect(frag.inbounds).toHaveLength(1)
    const inbound = frag.inbounds[0] as { tag: string; protocol: string; settings: { clients: unknown[] } }
    expect(inbound.tag).toBe('vless-in')
    expect(inbound.protocol).toBe('vless')
    expect(inbound.settings.clients).toEqual([
      {
        id: 'u',
        email: 'lk_abc',
        level: 0,
      },
    ])
  })
})

describe('linkToVlessUri', () => {
  it('基于 row.uuid 生成，宿主由参数注入', () => {
    const uri = linkToVlessUri({ uuid: 'uuid-1' }, 'node.example.com', '/x')
    expect(uri).toContain('uuid-1@node.example.com')
  })
})

// 别名（#fragment）—— 用户 2026-09-14 需求：导入客户端后节点要有名字
describe('别名 / #fragment', () => {
  it('传 alias → 追加百分号编码的 #fragment（中文安全）', () => {
    const uri = buildVlessUri({
      host: 'v2.example.com',
      path: '/v2ws',
      uuid: 'u',
      alias: '我的节点',
    })
    expect(uri.endsWith(`#${encodeURIComponent('我的节点')}`)).toBe(true)
    expect(uri).not.toContain('#我的节点') // 未编码形态不应出现
  })

  it('alias 含空格 / # / & 等特殊字符也安全', () => {
    const uri = buildVlessUri({ host: 'h', path: '/p', uuid: 'u', alias: 'a b#c&d' })
    expect(uri).toBe(`vless://u@h:443?encryption=none&type=ws&security=tls&path=%2Fp&host=h#a%20b%23c%26d`)
  })

  it('alias 为空 / 仅空白 → 不带 #', () => {
    expect(buildVlessUri({ host: 'h', path: '/p', uuid: 'u' })).not.toContain('#')
    expect(buildVlessUri({ host: 'h', path: '/p', uuid: 'u', alias: '   ' })).not.toContain('#')
  })

  it('displayAlias 回退链：alias → note → id', () => {
    expect(displayAlias({ alias: 'A', note: 'N', id: 'I' })).toBe('A')
    expect(displayAlias({ alias: '', note: 'N', id: 'I' })).toBe('N')
    expect(displayAlias({ alias: '  ', note: '', id: 'I' })).toBe('I')
    expect(displayAlias({})).toBe('')
  })

  it('linkToVlessUri：有 alias 用 alias，无 alias 回退 note/id', () => {
    expect(linkToVlessUri({ uuid: 'u', alias: '客户端名', note: '备注', id: 'lk_x' }, 'h', '/p')).toContain(
      `#${encodeURIComponent('客户端名')}`,
    )
    expect(linkToVlessUri({ uuid: 'u', alias: '', note: '', id: 'lk_x' }, 'h', '/p')).toContain('#lk_x')
  })
})
