import { describe, expect, it } from 'vitest'
import { parseAccessLine, parseLogDate } from '../lib/accessLogParse.js'

// access log 解析（TASK-monitoring.md B）。实测格式：
//   2026/09/04 22:53:17.938337 from 127.0.0.1:51706 accepted tcp:www.gstatic.com:443 email: lk_testuser
// 文本非 JSON、无字节数、含 email。

describe('parseLogDate', () => {
  it('本地时区解析 xray 时间戳 → epoch ms', () => {
    // 用本地时间构造期望值，避免时区依赖
    const expectTs = new Date(2026, 8, 4, 22, 53, 17, 938).getTime()
    expect(parseLogDate('2026/09/04 22:53:17.938337')).toBe(expectTs)
  })
  it('非法输入 → null', () => {
    expect(parseLogDate('garbage')).toBeNull()
    expect(parseLogDate('')).toBeNull()
  })
})

describe('parseAccessLine', () => {
  const line = '2026/09/04 22:53:17.938337 from 127.0.0.1:51706 accepted tcp:www.gstatic.com:443 email: lk_testuser'

  it('解析域名目标与端口', () => {
    const p = parseAccessLine(line)!
    expect(p).not.toBeNull()
    expect(p.event).toBe('accepted')
    expect(p.host).toBe('www.gstatic.com')
    expect(p.port).toBe(443)
    expect(p.email).toBe('lk_testuser')
    const expectedTs = new Date(2026, 8, 4, 22, 53, 17, 938).getTime()
    expect(p.ts).toBe(expectedTs)
  })

  it('IP 目标', () => {
    const p = parseAccessLine('2026/09/04 22:53:18.000000 from 127.0.0.1:51707 accepted tcp:142.250.0.1:443 email: lk_a')!
    expect(p.host).toBe('142.250.0.1')
    expect(p.port).toBe(443)
  })

  it('email 缺失 → null（无法关联用户，不入库）', () => {
    const p = parseAccessLine('2026/09/04 22:53:18.000000 from 1.2.3.4:5 accepted tcp:example.com:80')
    expect(p).toBeNull()
  })

  it('非 accepted 事件（如 noised/closed）→ null', () => {
    const p = parseAccessLine('2026/09/04 22:53:18.000000 from 1.2.3.4:5 closed tcp:example.com:80 email: lk_a')
    expect(p).toBeNull()
  })

  it('rejected/dropped 事件不入库（只 accepted 建立事件）', () => {
    for (const ev of ['rejected', 'dropped']) {
      const p = parseAccessLine(
        `2026/09/04 22:53:18.000000 from 1.2.3.4:5 ${ev} tcp:example.com:80 email: lk_a`,
      )
      expect(p).toBeNull()
    }
  })

  it('无目标行/垃圾行 → null，不抛', () => {
    expect(parseAccessLine('')).toBeNull()
    expect(parseAccessLine('   ')).toBeNull()
    expect(parseAccessLine('some random text')).toBeNull()
  })

  it('IPv6 目标 [::1]:port', () => {
    const p = parseAccessLine('2026/09/04 22:53:18.000000 from 127.0.0.1:9 accepted tcp:[::1]:443 email: lk_v6')!
    expect(p.host).toBe('::1')
    expect(p.port).toBe(443)
  })
})
