// xray access log 解析（TASK-monitoring.md B）。
// 实测格式（xray 26.3.27，access log 纯文本，非 JSON）：
//   2026/09/04 22:53:17.938337 from 127.0.0.1:51706 accepted tcp:www.gstatic.com:443 email: lk_testuser
// 字段：时间 / 来源 / 事件(accepted) / tcp:目标:端口 / email: 用户。
// 说明：access log 只含连接建立事件，无字节数（实测）；字节溯源靠 traffic_samples。
// 解析要点：
//   - 仅 accepted 事件入库（避免多次统计重复行；其它事件忽略）
//   - 目标是域名或 IP：`tcp:host:port`；纯数字/IPv6 情况下仍取“最后一个冒号后为端口”。
//   - IPv6 目标是 [::1]:443 形态：显式取 ] 与 : 之间为端口。
//   - email 缺失/未知形态 → email=''（上层负责校验并跳过）

export interface ParsedAccessLine {
  /** epoch ms（文件内本地时间） */
  ts: number
  /** 事件（accepted 才入库；其余行解析后调用方丢弃） */
  event: string
  host: string
  port: number | null
  email: string
}

/** 形如 2026/09/04 22:53:17.938337 → epoch ms（按进程本地时区解释） */
export function parseLogDate(s: string): number | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s.trim())
  if (!m) return null
  const [, Y, Mo, D, h, mi, s2, frac = '0'] = m
  const d = new Date(Number(Y), Number(Mo) - 1, Number(D), Number(h), Number(mi), Number(s2))
  if (Number.isNaN(d.getTime())) return null
  const ms = Number(frac.padEnd(3, '0').slice(0, 3))
  return d.getTime() + ms
}

/** 解析单行 access log；非 accepted 事件 / 缺目标 / 缺 email 时返回 null（不落库） */
export function parseAccessLine(line: string): ParsedAccessLine | null {
  const text = line.trim()
  if (!text) return null
  // 时间与来源：固定前缀 "from <ip:port> <event>"（防误匹配正文里的 from）
  const head = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d+) from \S+ (accepted|rejected|dropped)\b/.exec(text)
  if (!head) return null
  const ts = parseLogDate(head[1] ?? '')
  if (ts === null) return null
  const event = head[2] ?? ''
  if (event !== 'accepted') return null

  const emailM = /email: (\S+)/.exec(text)
  const email = emailM ? (emailM[1] ?? '') : ''
  if (!email) return null

  const hostPort = extractTarget(text)
  return { ts, event, host: hostPort?.host ?? '', port: hostPort?.port ?? null, email }
}

/** 从正文提取目标 host:port（tcp: 前缀）；提取失败返回 null */
function extractTarget(text: string): { host: string; port: number | null } | null {
  // 先试 [IPv6]:port（冒号在方括号内，须整体消费）
  const bracketed = /\btcp:\[([^\]]+)\](?::(\d+))?/.exec(text)
  if (bracketed) {
    const port = bracketed[2] !== undefined ? Number(bracketed[2]) : null
    return { host: bracketed[1] ?? '', port: validPort(port) }
  }
  // 域名/IPv4：host:port 常规形态
  const plain = /\btcp:([A-Za-z0-9.-]+)(?::(\d+))?/.exec(text)
  if (!plain) return null
  const host = plain[1] ?? ''
  const port = plain[2] !== undefined ? Number(plain[2]) : null
  return host ? { host, port: validPort(port) } : null
}

function validPort(p: number | null): number | null {
  if (p !== null && (Number.isNaN(p) || p < 1 || p > 65535)) return null
  return p
}
