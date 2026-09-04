import { describe, expect, it } from 'vitest'
import {
  aggregateTraffic,
  bucketSeries,
  bucketStart,
  toTrafficSeries,
} from '../lib/trafficAgg.js'
import type { TrafficSampleRow } from '../types.js'

// 流量聚合（TASK-monitoring.md A）：本地时区桶对齐 + 空桶补零。

// 本地时区某整点的 epoch（便于断言不依赖 CI 时区）
function localHour(y: number, mo: number, d: number, h: number): number {
  return new Date(y, mo - 1, d, h, 0, 0, 0).getTime()
}

describe('bucketStart', () => {
  it('hour：本地整点对齐', () => {
    const anchor = localHour(2026, 9, 4, 22)
    expect(bucketStart(anchor + 30 * 60 * 1000, 'hour')).toBe(anchor)
    expect(bucketStart(anchor + 60 * 60 * 1000 - 1, 'hour')).toBe(anchor)
  })
  it('day：本地当日 0 点对齐', () => {
    const anchor = new Date(2026, 8, 4).getTime()
    expect(bucketStart(anchor + 23 * 3600 * 1000 + 59 * 60 * 1000, 'day')).toBe(anchor)
  })
})

describe('bucketSeries + toTrafficSeries', () => {
  it('hour 桶：覆盖 [from,to) 全部整点，空桶补 0', () => {
    const a = localHour(2026, 9, 4, 10)
    const b = localHour(2026, 9, 4, 12)
    const pts = toTrafficSeries(new Map(), a, b + 1, 'hour')
    expect(pts).toHaveLength(3) // 10,11,12
    expect(pts[0]).toEqual({ ts: a, up: 0, down: 0 })
    expect(pts[2]).toEqual({ ts: b, up: 0, down: 0 })
  })

  it('day 桶：骨架跨天', () => {
    const starts = bucketSeries(localHour(2026, 9, 4, 23), localHour(2026, 9, 6, 1), 'day')
    expect(starts).toHaveLength(3) // 9-4, 9-5, 9-6（本地日界）
  })
})

describe('aggregateTraffic', () => {
  it('按桶聚合 up/down delta', () => {
    const anchor = localHour(2026, 9, 4, 12)
    const samples: TrafficSampleRow[] = [
      { id: 1, link_id: 'lk_a', ts: anchor + 1000, up_delta: 5, down_delta: 7 },
      { id: 2, link_id: 'lk_a', ts: anchor + 30 * 60 * 1000, up_delta: 1, down_delta: 2 },
      { id: 3, link_id: 'lk_a', ts: anchor + 3600 * 1000, up_delta: 9, down_delta: 9 }, // 下一桶
    ]
    const acc = aggregateTraffic(samples, 'hour')
    expect(acc.get(anchor)).toEqual({ up: 6, down: 9 })
    expect(acc.get(anchor + 3600 * 1000)).toEqual({ up: 9, down: 9 })
  })
})
