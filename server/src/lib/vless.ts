import type { LinkRow } from '../types.js'

// VLESS 链接构造：唯一依赖环境注入的 PUBLIC_HOST/PUBLIC_PATH（不硬编码域名）。
// vless 解析说明（v2rayN/Shadowrocket/Clash/sing-box 全兼容）：
//   host 参数 = WS 的 Host 头（与 TLS SNI 一致），不带端口；端口保留在主机段。
//   #fragment = 客户端显示的节点名（别名）；按 RFC 3986 百分号编码，
//   v2rayN/NG、Shadowrocket、sing-box 导入时都会 UrlDecode（含中文/空格安全）。
// 格式（占位域名，仅示意）：
//   vless://<uuid>@<host>:443?encryption=none&security=tls&type=ws&path=%2Fv2ws&host=<host>#<别名>

export interface VlessLinkParams {
  host: string
  port?: number
  path: string
  security?: 'tls' | 'reality' | 'none'
  uuid: string
  /** 客户端节点名（URL fragment）；空/缺省则不带 # */
  alias?: string
}

export function buildVlessUri(p: VlessLinkParams): string {
  const params: Record<string, string> = {
    encryption: 'none',
    type: 'ws',
  }
  const security = p.security ?? 'tls'
  if (security !== 'none') params.security = security
  const wsPath = p.path.startsWith('/') ? p.path : `/${p.path}`
  // 注意：不要预先 encodeURIComponent(path) —— URLSearchParams 会统一做 form-urlencoded
  // 编码（把 / → %2F、% → %25 一次完成），结果即客户端期望的 path=%2Fv2ws。
  params.path = wsPath
  // host 参数必须与 SNI/WS Host 一致（不带端口）
  params.host = p.host
  const port = p.port ?? 443
  const qs = new URLSearchParams(params).toString()
  const uri = `vless://${p.uuid}@${p.host}:${port}?${qs}`
  const alias = p.alias?.trim()
  return alias ? `${uri}#${encodeURIComponent(alias)}` : uri
}

export function publicHost(): string {
  return process.env.PUBLIC_HOST ?? 'v2.example.com'
}

export function publicPath(): string {
  return process.env.PUBLIC_PATH ?? '/v2ws'
}

/** 别名回退链：alias（客户端名）→ note（备注）→ id —— 保证导入客户端后节点有可辨识名字
 *  逐级 trim 后判定非空（纯空白视为未设置，继续回退） */
export function displayAlias(row: { alias?: string; note?: string; id?: string }): string {
  for (const v of [row.alias, row.note, row.id]) {
    const t = (v ?? '').trim()
    if (t) return t
  }
  return ''
}

export function linkToVlessUri(
  row: Pick<LinkRow, 'uuid'> & { alias?: string; note?: string; id?: string },
  host = publicHost(),
  path = publicPath(),
): string {
  return buildVlessUri({ host, path, uuid: row.uuid, alias: displayAlias(row) })
}

// 构建 adu 所需的 xray inbound 配置片段。
// 需求 §3.1 + 本地实测确认（2026-09-04）：
//   · 顶层必须含 inbounds 数组（缺则 "Added 0 user(s)"）
//   · inbound 至少含 tag / port / protocol / settings；listen/streamSettings 可省略
//     （adu 只在运行中的 inbound 上加用户，不重建监听；port 任意正整数即可，语义上用不到）
//   · 不做限速：xray VLESS 无 per-user 限速原生支持，不携带任何 speedLimit 字段
export interface XrayUserSpec {
  email: string
  uuid: string
}

export function buildInboundFragment(
  spec: XrayUserSpec,
  inboundTag: string,
): Record<string, unknown> {
  const client: Record<string, unknown> = {
    id: spec.uuid,
    email: spec.email,
    level: 0,
  }
  return {
    inbounds: [
      {
        tag: inboundTag,
        // port 为 xray 配置解析所需字段（缺失会报 "no Port(s) set"）。adu 按 tag 定位运行中
        // 的 inbound 合并用户，port 值不影响合并（实测 0 也能 Added 1）；此处填部署拓扑里的
        // 标准值 7895（与 REQUIREMENTS.md §3.5 一致），非私有地址。
        port: 7895,
        protocol: 'vless',
        settings: {
          clients: [client],
          decryption: 'none',
        },
      },
    ],
  }
}
