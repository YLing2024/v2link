// vless:// 链接构造（前端仅展示复制/二维码，参数拼装规则与 server 端一致）。
// 真实 host/path 来自构建注入 VITE_PUBLIC_HOST / VITE_PUBLIC_PATH（占位默认值）。
// #fragment = 客户端显示的节点名（别名）；按 RFC 3986 百分号编码（v2rayN/NG、Shadowrocket、
// sing-box 导入时都会 UrlDecode，中文/空格安全）。

export function publicHost(): string {
  return (import.meta.env.VITE_PUBLIC_HOST as string | undefined)?.trim() || 'v2.example.com'
}

export function publicPath(): string {
  return (import.meta.env.VITE_PUBLIC_PATH as string | undefined)?.trim() || '/v2ws'
}

/** 别名回退链：alias（客户端名）→ note（备注）→ id；保证导入后节点有可辨识名字
 *  逐级 trim 后判定非空（纯空白视为未设置，继续回退） */
export function displayAlias(link: { alias?: string; note?: string; id?: string }): string {
  for (const v of [link.alias, link.note, link.id]) {
    const t = (v ?? '').trim()
    if (t) return t
  }
  return ''
}

export function vlessLink(
  uuid: string,
  host: string = publicHost(),
  path: string = publicPath(),
  alias?: string,
): string {
  const wsPath = path.startsWith('/') ? path : `/${path}`
  const qs = new URLSearchParams({
    encryption: 'none',
    type: 'ws',
    security: 'tls',
    path: wsPath,
    host,
  }).toString()
  const uri = `vless://${uuid}@${host}:443?${qs}`
  const name = alias?.trim()
  return name ? `${uri}#${encodeURIComponent(name)}` : uri
}
