// vless:// 链接构造（前端仅展示复制/二维码，参数拼装规则与 server 端一致）。
// 真实 host/path 来自构建注入 VITE_PUBLIC_HOST / VITE_PUBLIC_PATH（占位默认值）。

export function publicHost(): string {
  return (import.meta.env.VITE_PUBLIC_HOST as string | undefined)?.trim() || 'v2.example.com'
}

export function publicPath(): string {
  return (import.meta.env.VITE_PUBLIC_PATH as string | undefined)?.trim() || '/v2ws'
}

export function vlessLink(uuid: string): string {
  const host = publicHost()
  const path = publicPath()
  const wsPath = path.startsWith('/') ? path : `/${path}`
  const qs = new URLSearchParams({
    encryption: 'none',
    type: 'ws',
    security: 'tls',
    path: wsPath,
    host,
  }).toString()
  return `vless://${uuid}@${host}:443?${qs}`
}
