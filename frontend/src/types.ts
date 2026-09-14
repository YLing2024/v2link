// 与后端 LinkView 对应（见 server/src/types.ts）
export type LinkStatus = 'active' | 'expired' | 'revoked'

export interface Link {
  id: string
  uuid: string
  note: string
  /** 客户端节点名（vless #fragment）；空串 = 未设置，回退 note → id */
  alias: string
  upBytes: number
  downBytes: number
  createdAt: number
  /** 永久链接为哨兵 0；展示/判定请用 permanent */
  expiresAt: number
  /** 永久有效（永不过期）；由后端按 expires_at 推导 */
  permanent: boolean
  revokedAt: number | null
  status: LinkStatus
}

export interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

export interface CreateLinkBody {
  note?: string
  /** 客户端节点名（写入 vless #fragment） */
  alias?: string
  hours?: number
  /** true = 永久有效（与 hours 互斥） */
  permanent?: boolean
}

// ---- 监控/追溯/审计（TASK-monitoring.md A/B/C）----

// 流量曲线桶点（A）
export interface TrafficPoint {
  ts: number
  up: number
  down: number
}

// 连接记录行（B）
export interface ConnectionRecord {
  id: number
  link_id: string | null
  email: string
  ts: number
  host: string | null
  port: number | null
  up_bytes: number | null
  down_bytes: number | null
  duration_ms: number | null
}

// 审计日志行（C）
export interface AuditRecord {
  id: number
  ts: number
  actor: string
  action: 'create' | 'revoke' | 'extend'
  link_id: string | null
  detail: Record<string, unknown> | null
}

// 分页信封（/connections 与 /audit 共用）
export interface Paged<T> {
  rows: T[]
  total: number
  limit: number
  offset: number
}

// ---- 地区连通性监控（TASK-extend-regions.md 需求 2）----

export interface RegionProbeResult {
  key: string
  ok: boolean
  rttMs: number | null
  error: string | null
  ts: number
}

export interface RegionProbeSnapshot {
  updatedAt: number
  probes: (RegionProbeResult & { flag: string; name: string })[]
  history: { ts: number; results: RegionProbeResult[] }[]
}
