// 统一 API client：每次带 Authorization Bearer；401 → 清 token 并跳认证中心。
// 与 admin-web/src/api.js 语义一致（REQUIREMENTS.md §6）。业务组件只调本文件。

import { getToken, redirectToAuth } from './lib/sso'
import type { Link } from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface ApiOptions {
  method?: string
  body?: unknown
  skipAuthRedirect?: boolean
}

async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const opts: RequestInit = { method: options.method ?? 'GET', headers }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(options.body)
  }

  const res = await fetch(path, opts)
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    data?: T
    error?: string
  }

  if (res.status === 401) {
    if (!options.skipAuthRedirect) {
      redirectToAuth()
    }
    throw new ApiError(401, data.error || '未登录或登录已过期')
  }
  if (!res.ok) {
    throw new ApiError(res.status, data.error || `HTTP ${res.status}`)
  }
  if (data && data.ok === false) {
    throw new ApiError(res.status, data.error || '请求失败')
  }
  return data.data as T
}

export function listLinks(): Promise<Link[]> {
  return request<Link[]>('/api/links')
}

export function createLink(body: { note?: string; hours?: number; speed_mbps?: number }): Promise<Link> {
  return request<Link>('/api/links', { method: 'POST', body })
}

export function revokeLink(id: string): Promise<Link> {
  return request<Link>(`/api/links/${encodeURIComponent(id)}/revoke`, { method: 'POST' })
}

export function extendLink(id: string, hours: number): Promise<Link> {
  return request<Link>(`/api/links/${encodeURIComponent(id)}/extend`, {
    method: 'POST',
    body: { hours },
  })
}

export function changeSpeed(id: string, speedMbps: number): Promise<Link> {
  return request<Link>(`/api/links/${encodeURIComponent(id)}/speed`, {
    method: 'POST',
    body: { speed_mbps: speedMbps },
  })
}
