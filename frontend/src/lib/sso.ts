// SSO 客户端核心（对齐 admin-web/quotahub 模式，见 REQUIREMENTS.md §10 参考）：
//   · token 从 URL query/fragment 提取 → localStorage
//   · 请求统一带 Authorization: Bearer
//   · 401 → 清 token + 跳认证中心（带 redirect 回跳）
// 认证中心地址走环境变量注入（构建时 VITE_AUTH_CENTER_URL）；缺省占位（部署方配置）。

export function authCenterUrl(): string {
  const v = (import.meta.env.VITE_AUTH_CENTER_URL as string | undefined)?.trim()
  return v && v.length ? v : 'https://auth.example.com/auth'
}

export const TOKEN_KEY = 'auth_token'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// 从 URL 提取认证中心回跳的 token：OAuth2 风格 query ?token=（fragment #token= 兜底）
export function extractToken(search: string, hash: string): string | null {
  const frag = /^#token=([^&]+)/.exec(hash)
  if (frag) return decodeURIComponent(frag[1])
  return new URLSearchParams(search).get('token')
}

export function getToken(storage: StorageLike = defaultStorage()): string {
  return storage.getItem(TOKEN_KEY) || ''
}

export function saveToken(token: string, storage: StorageLike = defaultStorage()): void {
  storage.setItem(TOKEN_KEY, token)
}

export function clearToken(storage: StorageLike = defaultStorage()): void {
  storage.removeItem(TOKEN_KEY)
}

// 页面加载处理回跳 token：存入 + 清地址栏；返回捕获到的 token
export function captureTokenFromLocation(
  loc: { search: string; hash: string; pathname: string } = window.location,
  storage: StorageLike = defaultStorage(),
): string | null {
  const token = extractToken(loc.search, loc.hash)
  if (token) {
    saveToken(token, storage)
    // 清掉地址栏 token，避免留在地址栏/浏览器历史
    history.replaceState(null, '', loc.pathname)
  }
  return token
}

// 构造认证中心跳转地址（带回跳）
export function buildAuthRedirect(currentHref: string, authCenter = authCenterUrl()): string {
  return `${authCenter}?redirect=${encodeURIComponent(currentHref)}`
}

export function redirectToAuth(
  currentHref: string = window.location.href,
  storage: StorageLike = defaultStorage(),
): void {
  clearToken(storage)
  if (typeof window !== 'undefined') {
    window.location.href = buildAuthRedirect(currentHref)
  }
}

function defaultStorage(): Storage {
  return window.localStorage
}
