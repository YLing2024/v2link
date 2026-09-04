// 与后端 LinkView 对应（见 server/src/types.ts）
export type LinkStatus = 'active' | 'expired' | 'revoked'

export interface Link {
  id: string
  uuid: string
  note: string
  speedMbps: number
  upBytes: number
  downBytes: number
  createdAt: number
  expiresAt: number
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
  hours?: number
  speed_mbps?: number
}
