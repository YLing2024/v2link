import type { TrafficStat } from '../types.js'

// xray statsquery 原始输出解析。
// 实测输出形态（见 REQUIREMENTS.md §3.1 与本地验证）：
//   {}                                    → 无任何流量（stat 为空）
//   { "stat": [ {name, value}, ... ] }    → 有流量
//   { "stat": [ {name}, ... ] }           → name 带 value 缺失（为 0 时 xray 省略 value 字段，
//                                           实测 -reset 后即出现该形态）；value 按 0 处理
// name 形如 user>>><email>>>traffic>>>uplink|downlink

export interface ParsedTraffic {
  /** email → { up, down }（字节） */
  byUser: Map<string, { up: number; down: number }>
}

export function parseStatsQuery(raw: string): ParsedTraffic {
  const byUser = new Map<string, { up: number; down: number }>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // xray 偶发把非 JSON（如空/警告）打到 stdout；按无流量处理不抛异常，
    // 但调用方会记日志（区别于正常空结果）
    return { byUser }
  }
  const obj = parsed as { stat?: unknown }
  if (!Array.isArray(obj.stat)) return { byUser }
  const RE = /^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/
  for (const item of obj.stat) {
    const s = item as TrafficStat
    if (typeof s.name !== 'string') continue
    const m = RE.exec(s.name)
    if (!m) continue
    const email = m[1] as string
    const dir = m[2] as 'uplink' | 'downlink'
    // value 可能缺省（xray 省略 0 值字段）
    const v = typeof s.value === 'number' && Number.isFinite(s.value) ? s.value : 0
    if (v <= 0) continue
    const cur = byUser.get(email) ?? { up: 0, down: 0 }
    if (dir === 'uplink') cur.up += v
    else cur.down += v
    byUser.set(email, cur)
  }
  return { byUser }
}
