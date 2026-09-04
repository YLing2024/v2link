import type { TrafficPoint, TrafficSampleRow } from '../types.js'

// 流量采样聚合（TASK-monitoring.md A §2）。量小（30s × 30 天 ≈ 8.6 万行/链接），
// 按桶在 JS 聚合即可（SQL strftime 跨库时区语义不直观；JS 按本地时区取整更可控）。
//   bucket=hour：桶起始 = 本地时区整点
//   bucket=day ：桶起始 = 本地时区当天 0 点
// 每个桶输出该桶累计 delta 与「相对桶起始的偏移」两套语义（TrafficPoint 只取累计）。

export type BucketSize = 'hour' | 'day'

export const HOUR_MS = 3600 * 1000
export const DAY_MS = 24 * HOUR_MS

/** epoch ms → 所在桶起始（本地时区） */
export function bucketStart(ts: number, bucket: BucketSize): number {
  const d = new Date(ts)
  // epoch 是 UTC 毫秒；hour/day 都要按“本地当日 0 点”为锚对齐，
  // 不能直接对 epoch 取整（会偏到 UTC 整点）。
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (bucket === 'day') return dayStart
  const hourIdx = Math.floor((ts - dayStart) / HOUR_MS)
  return dayStart + hourIdx * HOUR_MS
}

/** 生成 [from, to) 区间内的完整桶骨架（含无数据的桶，前端画图需连续横轴） */
export function bucketSeries(from: number, to: number, bucket: BucketSize): number[] {
  const step = bucket === 'hour' ? HOUR_MS : DAY_MS
  const start = bucketStart(from, bucket)
  const out: number[] = []
  for (let t = start; t < to; t += step) out.push(t)
  return out
}

/** 采样明细 → 按桶聚合（仅含数据点；调用方再合并骨架补零） */
export function aggregateTraffic(
  samples: TrafficSampleRow[],
  bucket: BucketSize,
): Map<number, { up: number; down: number }> {
  const acc = new Map<number, { up: number; down: number }>()
  for (const s of samples) {
    const b = bucketStart(s.ts, bucket)
    const cur = acc.get(b) ?? { up: 0, down: 0 }
    cur.up += Number(s.up_delta)
    cur.down += Number(s.down_delta)
    acc.set(b, cur)
  }
  return acc
}

/** 骨架 + 数据 → 连续点序列（空桶补 0） */
export function toTrafficSeries(
  acc: Map<number, { up: number; down: number }>,
  from: number,
  to: number,
  bucket: BucketSize,
): TrafficPoint[] {
  return bucketSeries(from, to, bucket).map((t) => ({
    ts: t,
    up: acc.get(t)?.up ?? 0,
    down: acc.get(t)?.down ?? 0,
  }))
}
