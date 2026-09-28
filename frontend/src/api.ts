// 统一 API client：身份由 Auth Gateway 的站点会话 cookie 证明（同源自动携带），
// 不再读写 localStorage token。全局唯一 401 处理：整页跳网关登录页。

import type {
  AuditRecord,
  ConnectionRecord,
  Link,
  Paged,
  RegionProbeSnapshot,
  TrafficPoint,
} from './types'

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
}

let redirecting = false

// 401 → 整页跳网关登录页，next 带回当前地址（pathname + search）
export function redirectToLogin(): void {
  if (redirecting) return
  redirecting = true
  const next = encodeURIComponent(window.location.pathname + window.location.search)
  window.location.href = `/_auth/login?next=${next}`
}

// 退出：交给网关处理（清站点会话）
export function logout(): void {
  window.location.href = '/_auth/logout'
}

async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
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
    redirectToLogin()
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

export function createLink(body: {
  note?: string
  alias?: string
  expiresAt?: number
  hours?: number
  permanent?: boolean
}): Promise<Link> {
  return request<Link>('/api/links', { method: 'POST', body })
}

export function revokeLink(id: string): Promise<Link> {
  return request<Link>(`/api/links/${encodeURIComponent(id)}/revoke`, { method: 'POST' })
}

export function extendLink(
  id: string,
  body: { expiresAt?: number; hours?: number; permanent?: boolean },
): Promise<Link> {
  return request<Link>(`/api/links/${encodeURIComponent(id)}/extend`, {
    method: 'POST',
    body,
  })
}

export function regionProbes(): Promise<RegionProbeSnapshot> {
  return request<RegionProbeSnapshot>('/api/regions/probes')
}

export function linkTraffic(id: string, bucket: 'hour' | 'day', from?: number, to?: number): Promise<TrafficPoint[]> {
  const qs = new URLSearchParams({ bucket })
  if (from !== undefined) qs.set('from', String(from))
  if (to !== undefined) qs.set('to', String(to))
  return request<TrafficPoint[]>(`/api/links/${encodeURIComponent(id)}/traffic?${qs}`)
}

export function linkConnections(
  id: string,
  opts: { q?: string; from?: number; to?: number; limit?: number; offset?: number } = {},
): Promise<Paged<ConnectionRecord>> {
  const qs = new URLSearchParams()
  if (opts.q) qs.set('q', opts.q)
  if (opts.from !== undefined) qs.set('from', String(opts.from))
  if (opts.to !== undefined) qs.set('to', String(opts.to))
  if (opts.limit !== undefined) qs.set('limit', String(opts.limit))
  if (opts.offset !== undefined) qs.set('offset', String(opts.offset))
  return request<Paged<ConnectionRecord>>(`/api/links/${encodeURIComponent(id)}/connections?${qs}`)
}

export function auditLog(opts: { limit?: number; offset?: number } = {}): Promise<Paged<AuditRecord>> {
  const qs = new URLSearchParams()
  if (opts.limit !== undefined) qs.set('limit', String(opts.limit))
  if (opts.offset !== undefined) qs.set('offset', String(opts.offset))
  return request<Paged<AuditRecord>>(`/api/audit?${qs}`)
}
