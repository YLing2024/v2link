// Clash / mihomo 订阅配置生成（纯函数，零第三方依赖 —— 仓库铁律禁止新增依赖，不引 js-yaml）。
//
// 输出形态选择（写进注释的理由）：
//   · 需求要求 Content-Type 为 text/yaml，故输出惯用的手写 YAML，便于人工核对结构；
//   · 转义安全靠单一原语 yamlScalar()：它借 JSON.stringify() 产出**合法的 YAML 双引号标量**
//     （YAML 双引号转义是 JSON 转义的超集：\b \f \n \r \t \" \\ \/ \uXXXX 两边都认）。
//     因此别名里的 `:` `#` `"` `\`、中文、emoji 都不会破坏 YAML 结构 —— 比手写一串
//     replace(/"|\\/g) 更不容易漏，也比整份配置直接输出 JSON 更贴近 Clash 习惯。
//
// 结构面向 mihomo / Clash.Meta（支持 vless）：
//   proxies / proxy-groups(select, 名 v2link，引用全部节点) / rules(MATCH,v2link)
// 节点顺序 = 传入顺序（= 前端勾选顺序）。

/** 订阅代理组名（固定）；rules 末尾 MATCH 到它 */
export const CLASH_GROUP_NAME = 'v2link'
/** 默认对外端口（nginx 终结 TLS 后回源） */
export const CLASH_DEFAULT_PORT = 443
/** 默认 WS 路径（与控制面 / 数据面一致） */
export const CLASH_DEFAULT_PATH = '/v2ws'

export interface ClashNode {
  /** xray 用户 uuid */
  uuid: string
  /** 原始节点名（通常来自 displayAlias）；本函数负责去重，代理名与组引用始终一致 */
  name: string
  /** 连接地址（域名或 IP） */
  server: string
  /** TLS SNI / WS Host；空串则回退 server */
  sni: string
  /** 端口，默认 443 */
  port?: number
  /** WS 路径，默认 /v2ws */
  path?: string
}

/**
 * 节点名去重：重名依次追加 `#2`、`#3`…，保证结果全局唯一。
 * 同时处理「新名恰好已被占用」的情况（如输入 a / a / a#2 → a / a#2 / a#2#2 不会冲突）。
 */
export function dedupeNodeNames(names: string[]): string[] {
  const used = new Set<string>()
  const nextSuffix = new Map<string, number>()
  const out: string[] = []
  for (const raw of names) {
    let candidate = raw
    if (used.has(candidate)) {
      let n = nextSuffix.get(raw) ?? 1
      do {
        n += 1
        candidate = `${raw}#${n}`
      } while (used.has(candidate))
      nextSuffix.set(raw, n)
    } else {
      nextSuffix.set(raw, 1)
    }
    used.add(candidate)
    out.push(candidate)
  }
  return out
}

/** 字符串标量 → 双引号 YAML 标量（JSON 转义即合法 YAML 双引号转义） */
function yamlScalar(s: string): string {
  return JSON.stringify(s)
}

/** 生成 Clash / mihomo 配置 YAML 文本（末尾带换行） */
export function buildClashConfig(nodes: ClashNode[]): string {
  const names = dedupeNodeNames(nodes.map((n) => n.name))
  const lines: string[] = []

  if (nodes.length === 0) {
    lines.push('proxies: []')
  } else {
    lines.push('proxies:')
    nodes.forEach((node, i) => {
      const name = names[i] ?? node.name
      const server = node.server
      const sni = node.sni.trim() || server
      const port = node.port ?? CLASH_DEFAULT_PORT
      const path = node.path ?? CLASH_DEFAULT_PATH
      lines.push(`  - name: ${yamlScalar(name)}`)
      lines.push('    type: vless')
      lines.push(`    server: ${yamlScalar(server)}`)
      lines.push(`    port: ${port}`)
      lines.push(`    uuid: ${yamlScalar(node.uuid)}`)
      lines.push('    udp: true')
      lines.push('    tls: true')
      lines.push(`    servername: ${yamlScalar(sni)}`)
      lines.push('    network: ws')
      lines.push('    ws-opts:')
      lines.push(`      path: ${yamlScalar(path)}`)
      lines.push('      headers:')
      lines.push(`        Host: ${yamlScalar(sni)}`)
    })
  }

  lines.push('proxy-groups:')
  lines.push(`  - name: ${yamlScalar(CLASH_GROUP_NAME)}`)
  lines.push('    type: select')
  if (names.length === 0) {
    lines.push('    proxies: []')
  } else {
    lines.push('    proxies:')
    for (const name of names) lines.push(`      - ${yamlScalar(name)}`)
  }

  lines.push('rules:')
  lines.push(`  - ${yamlScalar(`MATCH,${CLASH_GROUP_NAME}`)}`)

  return `${lines.join('\n')}\n`
}
