import { describe, expect, it } from 'vitest'
import { vlessLink } from './vless'

// vless:// 构造（对齐 server 端格式）；host/path 由 env 注入，测试直接调构造器
describe('vlessLink', () => {
  it('生成标准 vless ws+tls 链接', () => {
    const uri = vlessLink('11111111-1111-4111-8111-111111111111')
    expect(uri).toContain('vless://11111111-1111-4111-8111-111111111111@')
    expect(uri).toContain(':443?')
    expect(uri).toContain('encryption=none')
    expect(uri).toContain('type=ws')
    expect(uri).toContain('security=tls')
    expect(uri).toContain('path=%2Fv2ws')
    expect(uri).toContain(`host=${encodeURIComponent('v2.example.com')}`)
  })

  it('默认占位 host', () => {
    expect(vlessLink('u')).toContain('v2.example.com')
  })
})
