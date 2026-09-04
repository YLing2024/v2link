import { describe, expect, it } from 'vitest'
import { parseStatsQuery } from '../lib/xrayStats.js'

// statsquery 输出解析单测。覆盖实测到的四种形态（见 lib/xrayStats.ts 注释）：
//   空 {} / 正常 / value 缺省（reset 后）/ 多用户多方向
describe('parseStatsQuery', () => {
  it('空对象（无流量）→ 空 map', () => {
    const { byUser } = parseStatsQuery('{}')
    expect(byUser.size).toBe(0)
  })

  it('正常流量 → 按 email 聚合 up/down', () => {
    const raw = JSON.stringify({
      stat: [
        { name: 'user>>>lk_aaa>>>traffic>>>uplink', value: 72 },
        { name: 'user>>>lk_aaa>>>traffic>>>downlink', value: 146 },
        { name: 'user>>>lk_bbb>>>traffic>>>downlink', value: 1000 },
      ],
    })
    const { byUser } = parseStatsQuery(raw)
    expect(byUser.get('lk_aaa')).toEqual({ up: 72, down: 146 })
    expect(byUser.get('lk_bbb')).toEqual({ up: 0, down: 1000 })
  })

  it('reset 后 value 字段消失（xray 省略 0）→ 按 0 处理不产生条目', () => {
    const raw = JSON.stringify({
      stat: [{ name: 'user>>>lk_aaa>>>traffic>>>uplink' }],
    })
    const { byUser } = parseStatsQuery(raw)
    expect(byUser.size).toBe(0)
  })

  it('非 JSON（xray 警告混入 stdout）→ 空 map 不抛', () => {
    const { byUser } = parseStatsQuery('2026/09/04 warning ...\n{}')
    expect(byUser.size).toBe(0)
    // 纯噪声
    expect(parseStatsQuery('some random text').byUser.size).toBe(0)
  })

  it('value 为 0 或负 → 忽略', () => {
    const raw = JSON.stringify({
      stat: [
        { name: 'user>>>lk_aaa>>>traffic>>>uplink', value: 0 },
        { name: 'user>>>lk_aaa>>>traffic>>>downlink', value: -5 },
      ],
    })
    expect(parseStatsQuery(raw).byUser.size).toBe(0)
  })
})
