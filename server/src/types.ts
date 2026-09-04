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
