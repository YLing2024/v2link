import type { Database } from 'better-sqlite3'

// 与 REQUIREMENTS.md §4 links 表逐列对应
export interface LinkRow {
  id: string
  uuid: string
  email: string
  note: string
  up_bytes: number
  down_bytes: number
  created_at: number
  expires_at: number
  revoked_at: number | null
  status: LinkStatus
}

export type LinkStatus = 'active' | 'expired' | 'revoked'

// 对外 API 展示形态（数值已整型归一化，便于前端直用）。
// 含 uuid：管理后台「复制链接/二维码」需要用它构造 vless://（需求 §6 操作列）。
export interface LinkView {
  id: string
  uuid: string
  note: string
  upBytes: number
  downBytes: number
  createdAt: number
  expiresAt: number
  revokedAt: number | null
  status: LinkStatus
}

// xray statsquery 返回的单条 stat（lib/xrayStats.ts 解析目标）
export interface TrafficStat {
  /** 形如 user>>><email>>>traffic>>>uplink|downlink */
  name: string
  value: number
}

export type DbLike = Pick<Database, 'prepare' | 'transaction' | 'exec'> | Database

// 写接口入参（服务层/路由共用）
export interface CreateLinkInput {
  note?: string
  hours?: number
}

// ---- 监控/追溯/审计（TASK-monitoring.md A/B/C）----

// traffic_samples 行（30s 采样 delta）
export interface TrafficSampleRow {
  id: number
  link_id: string
  ts: number
  up_delta: number
  down_delta: number
}

// 聚合桶结果（API 返回形态）：ts = 桶起始时间（epoch ms，本地时区对齐）
export interface TrafficPoint {
  ts: number
  up: number
  down: number
}

// connections 行（access log 采集）
export interface ConnectionRow {
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

// audit_log 行
export interface AuditRow {
  id: number
  ts: number
  actor: string
  action: string
  link_id: string | null
  detail: string | null
}

// audit 对外展示形态（detail 已 JSON.parse 为对象）
export interface AuditView extends Omit<AuditRow, 'detail'> {
  detail: AuditDetail
}

export type AuditAction = 'create' | 'revoke' | 'extend'

export type AuditDetail = Record<string, unknown> | null
