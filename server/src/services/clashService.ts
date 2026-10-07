import crypto from 'node:crypto'
import type { LinksRepo } from '../db/linksRepo.js'
import type { ClashSubRepo } from '../db/clashSubRepo.js'
import type { MonitoringRepo } from '../db/monitoringRepo.js'
import { buildClashConfig, type ClashNode } from '../lib/clash.js'
import { displayAlias } from '../lib/vless.js'
import { shouldBeActive } from './reconcile.js'
import { apiError } from './linkService.js'
import type { LinkRow } from '../types.js'

// Clash 订阅编排（控制面）：
//   · create：校验 linkIds（1–50）→ 保留存在顺序、忽略不存在并回报 skipped → 生成不可猜 token
//     → 落库 + 审计（只记节点数与 token 前缀，不记完整订阅地址）。
//   · get：token 即凭据（免鉴权），按链接**当前状态**重新生成 YAML；revoked/expired 自动不出现，
//     全失效 → 404。订阅存的是「指针」（link_ids），不是快照。
// 依赖 xray 无关：订阅正文只由链接账本 + 公开地址（host/sni/path，注入，测试零环境依赖）决定。

export const MIN_CLASH_LINKS = 1
export const MAX_CLASH_LINKS = 50
/** 审计 detail 里 token 前缀长度（可追溯同一订阅，又不泄漏完整凭证） */
const TOKEN_PREFIX_LEN = 8

export interface ClashSubCreated {
  token: string
  url: string
  importUrl: string
  expiresAt: number
  ttlSeconds: number
  count: number
  skipped: string[]
  nodes: { id: string; name: string }[]
}

export interface ClashSubscription {
  yaml: string
  /** subscription-userinfo 头内容；连接/到期信息不足时为 null */
  userinfo: string | null
  /** 本次实际包含的节点数 */
  count: number
  expiresAt: number
}

export interface ClashServiceDeps {
  repo: Pick<LinksRepo, 'byId'>
  clashSubs: Pick<ClashSubRepo, 'insert' | 'byToken'>
  monitor: Pick<MonitoringRepo, 'insertAudit'>
  /** 订阅地址前缀（PUBLIC_BASE_URL） */
  publicBaseUrl: string
  /** 订阅有效期（毫秒） */
  ttlMs: number
  /** 连接地址、TLS SNI/WS Host、WS 路径（生产注入 lib/vless 的 publicHost/publicSni/publicPath） */
  host: string
  sni: string
  path: string
  /** 默认系统时钟；测试注入固定值 */
  now?: () => number
}

export interface ClashService {
  create(linkIds: unknown, actor?: string): ClashSubCreated
  get(token: string): ClashSubscription
}

function normalizeLinkIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw apiError(400, 'linkIds 须为数组')
  if (raw.length < MIN_CLASH_LINKS || raw.length > MAX_CLASH_LINKS) {
    throw apiError(
      400,
      `请选择 ${MIN_CLASH_LINKS}~${MAX_CLASH_LINKS} 条链接（当前 ${raw.length} 条）`,
    )
  }
  const ids: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string' || !v.trim()) throw apiError(400, 'linkIds 含非法项')
    ids.push(v.trim())
  }
  return ids
}

export function createClashService(deps: ClashServiceDeps): ClashService {
  const nowMs = deps.now ?? (() => Date.now())

  function buildUrl(token: string): string {
    const base = deps.publicBaseUrl.trim().replace(/\/+$/, '')
    return `${base}/api/clash/subscriptions/${token}`
  }

  function buildImportUrl(url: string): string {
    return `clash://install-config?url=${encodeURIComponent(url)}&name=v2link`
  }

  function create(linkIds: unknown, actor?: string): ClashSubCreated {
    const ids = normalizeLinkIds(linkIds)
    const accepted: LinkRow[] = []
    const skipped: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const row = deps.repo.byId(id)
      if (row) accepted.push(row)
      else skipped.push(id)
    }
    if (accepted.length === 0) throw apiError(400, '所选链接均不存在')

    const token = crypto.randomBytes(32).toString('base64url')
    const now = nowMs()
    const expiresAt = now + deps.ttlMs
    const who = actor?.trim() || 'dev'
    deps.clashSubs.insert({
      token,
      link_ids: JSON.stringify(accepted.map((r) => r.id)),
      created_at: now,
      expires_at: expiresAt,
      created_by: who,
    })
    // 审计：只记节点数与 token 前缀，不落完整订阅地址（地址即凭据）
    deps.monitor.insertAudit({
      ts: now,
      actor: who,
      action: 'clash_sub_create',
      link_id: null,
      detail: { count: accepted.length, token_prefix: token.slice(0, TOKEN_PREFIX_LEN) },
    })

    const url = buildUrl(token)
    return {
      token,
      url,
      importUrl: buildImportUrl(url),
      expiresAt,
      ttlSeconds: Math.round(deps.ttlMs / 1000),
      count: accepted.length,
      skipped,
      nodes: accepted.map((r) => ({ id: r.id, name: displayAlias(r) })),
    }
  }

  function get(token: string): ClashSubscription {
    const row = deps.clashSubs.byToken(token)
    if (!row) throw apiError(404, '订阅不存在')
    const now = nowMs()
    if (row.expires_at <= now) throw apiError(404, '订阅已过期')

    let ids: string[] = []
    try {
      const parsed = JSON.parse(row.link_ids) as unknown
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      ids = []
    }

    const live: LinkRow[] = []
    for (const id of ids) {
      const link = deps.repo.byId(id)
      if (link && shouldBeActive(link, now)) live.push(link)
    }
    if (live.length === 0) throw apiError(404, '所选节点均已失效')

    const nodes: ClashNode[] = live.map((r) => ({
      uuid: r.uuid,
      name: displayAlias(r),
      server: deps.host,
      sni: deps.sni,
      path: deps.path,
    }))
    return {
      yaml: buildClashConfig(nodes),
      userinfo: buildUserinfo(live),
      count: live.length,
      expiresAt: row.expires_at,
    }
  }

  return { create, get }
}

/** subscription-userinfo：上传/下载字节合计 + 最早到期（秒）；全部永久有效则省略 expire */
function buildUserinfo(rows: LinkRow[]): string | null {
  if (rows.length === 0) return null
  const up = rows.reduce((a, r) => a + Number(r.up_bytes), 0)
  const down = rows.reduce((a, r) => a + Number(r.down_bytes), 0)
  const finite = rows.map((r) => Number(r.expires_at)).filter((e) => e > 0)
  const parts = [`upload=${up}`, `download=${down}`]
  if (finite.length) parts.push(`expire=${Math.floor(Math.min(...finite) / 1000)}`)
  return parts.join('; ')
}
