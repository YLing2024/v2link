import type { LinkRow } from '../types.js'

// VLESS 链接构造：唯一依赖环境注入的 PUBLIC_HOST/PUBLIC_PATH（不硬编码域名）。
// vless 解析说明（v2rayN/Shadowrocket/Clash/sing-box 全兼容）：
//   host 参数 = WS 的 Host 头（与 TLS SNI 一致），不带端口；端口保留在主机段。
// 格式（占位域名，仅示意）：
//   vless://<uuid>@<host>:443?encryption=none&security=tls&type=ws&path=%2Fv2ws&host=<host>

export interface VlessLinkParams {
  host: string
  port?: number
  path: string
  security?: 'tls' | 'reality' | 'none'
  uuid: string
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
  return `vless://${p.uuid}@${p.host}:${port}?${qs}`
}

export function publicHost(): string {
  return process.env.PUBLIC_HOST ?? 'v2.example.com'
}

export function publicPath(): string {
  return process.env.PUBLIC_PATH ?? '/v2ws'
}

export function linkToVlessUri(
  row: Pick<LinkRow, 'uuid'>,
  host = publicHost(),
  path = publicPath(),
): string {
  return buildVlessUri({ host, path, uuid: row.uuid })
}

// 构建 adu 所需的 xray inbound 配置片段（含 speedLimit）。
// 需求 §3.1 + 本地实测确认（2026-09-04）：
//   · 顶层必须含 inbounds 数组（缺则 "Added 0 user(s)"）
//   · inbound 至少含 tag / port / protocol / settings；listen/streamSettings 可省略
//     （adu 只在运行中的 inbound 上加用户，不重建监听；port 任意正整数即可，语义上用不到）
//   · 改速不能 adu 覆盖更新（同 email 报 already exists，Added 0 且 exit 0）→ 需 rmu + adu
export interface XrayUserSpec {
  email: string
  uuid: string
  speedMbps: number
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
  // speed_mbps=0 表示不限速：不携带 speedLimit 字段（xray 缺省即不限）
  if (spec.speedMbps > 0) {
    client.speedLimitUpMbps = spec.speedMbps
    client.speedLimitDownMbps = spec.speedMbps
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
