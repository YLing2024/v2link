import type { Database } from 'better-sqlite3'
import { toView, type LinksRepo } from '../db/linksRepo.js'
import type { MonitoringRepo } from '../db/monitoringRepo.js'
import { newLinkId, randomUuid } from '../lib/id.js'
import { isPermanentExpiry, PERMANENT_EXPIRES_AT } from '../lib/expiry.js'
import type { AuditAction, AuditDetail, CreateLinkInput, LinkRow, LinkView } from '../types.js'
import type { XrayClient } from './xrayClient.js'

// 业务编排：SQLite 账本为权威，xray 数据面为镜像。约定（REQUIREMENTS.md §5）：
//   所有写操作 = 先落 SQLite（事务）→ 再调 xray；
//   xray 失败 → 回滚 SQLite 并抛 502（保证账本与数据面一致）。
//
// 状态机：active → expired | revoked；expired/revoked 不可再延长；revoked 不可逆（MVP，
// 需求 §4 允许取舍：延长仅 active、revoked 不可复活）。
// 说明：仅 extend 不触 xray（expires_at 纯控制面字段）；create/revoke 才需要数据面一致。
//
// 永久链接（permanent）：expires_at = PERMANENT_EXPIRES_AT(0)，永不过期（过期扫描跳过）。
//   生成时与 hours 互斥；extend 三选一（hours / expiresAt / permanent），
//   支持 限时 ↔ 永久 双向转换（永久 → 限时用 expiresAt 表达）。
//
// extend 三选一（hours / expiresAt / permanent）：
//   · hours 模式：相对延长，expires_at += hours*3600*1000（沿用 MAX_HOURS 上限）
//   · expiresAt 模式：直接设置绝对过期时刻（epoch ms）
//   · permanent 模式：转为永久（expires_at = 哨兵 0）
// 实现：先统一解析出「新的绝对过期时刻」（或永久哨兵），再一并落库 + 审计，天然三选一。

/** extend 入参：相对延长（hours）/ 绝对到期（expiresAt）/ 转永久（permanent）三选一
 *  （服务层以「多传或都不传报 400」为准） */
export interface ExtendInput {
  expiresAt?: number
  hours?: number
  permanent?: boolean
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function apiError(status: number, message: string): HttpError {
  return new HttpError(status, message)
}

/** 绝对过期时刻允许的最大跨度（now ~ now+365 天；显式绝对时间不设小时上限，超出拒绝） */
const MAX_EXPIRE_ABS_DAYS = 365

/** 业务上限（默认值）来自 config，组装时注入——服务层不碰全局 config，利于测试 */
export interface LinkLimits {
  defaultHours: number
  maxHours: number
}

export interface LinkService {
  list(): LinkView[]
  create(input: CreateLinkInput, actor?: string): Promise<LinkView>
  revoke(id: string, actor?: string): Promise<LinkView>
  extend(id: string, input: ExtendInput, actor?: string): Promise<LinkView>
}

interface Deps {
  db: Database
  repo: LinksRepo
  monitor: MonitoringRepo
  xray: XrayClient
  limits: LinkLimits
  /** 默认取系统时钟；测试注入固定值 */
  now?: () => number
}

export function createLinkService(deps: Deps): LinkService {
  const { db, repo, monitor, xray, limits } = deps
  const nowMs = deps.now ?? (() => Date.now())

  // 操作审计：直连 dev token / 探针注入用户名 / 测试默认 → 缺省 'dev'
  // （TASK-monitoring.md C §2：直连 dev token 场景 actor='dev'）。
  function audit(action: AuditAction, link_id: string | null, detail: AuditDetail, actor?: string) {
    monitor.insertAudit({
      ts: nowMs(),
      actor: actor?.trim() || 'dev',
      action,
      link_id,
      detail,
    })
  }

  // ---- 输入校验（与 API 表一致：默认 hours=24；hours≤720；permanent 与 hours 互斥）----
  function normalizeInput(input: CreateLinkInput): {
    note: string
    alias: string
    hours: number
    permanent: boolean
  } {
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : ''
    // 别名进 URL fragment，限长 100（客户端节点名展示用）
    const alias = typeof input.alias === 'string' ? input.alias.trim().slice(0, 100) : ''
    const { hours, permanent } = input
    if (permanent !== undefined && typeof permanent !== 'boolean') {
      throw apiError(400, 'permanent 须为布尔值')
    }
    const isPermanent = permanent === true
    if (isPermanent && hours !== undefined) {
      throw apiError(400, '已选永久有效，不能再指定 hours（二选一）')
    }
    if (!isPermanent && hours !== undefined) {
      if (!Number.isInteger(hours) || hours < 1 || hours > limits.maxHours) {
        throw apiError(400, `时长须为 1~${limits.maxHours} 小时的整数`)
      }
    }
    return {
      note,
      alias,
      hours: hours ?? limits.defaultHours,
      permanent: isPermanent,
    }
  }

  async function create(input: CreateLinkInput, actor?: string): Promise<LinkView> {
    const { note, alias, hours, permanent } = normalizeInput(input)
    const id = newLinkId()
    const uuid = randomUuid()
    const email = id // email = id（xray 用户标识/账本 key，REQUIREMENTS.md §4）
    const createdAt = nowMs()
    // 永久 → 哨兵 0（永不过期）；否则 创建时刻 + hours
    const expiresAt = permanent ? PERMANENT_EXPIRES_AT : createdAt + hours * 3600 * 1000
    const row: LinkRow = {
      id,
      uuid,
      email,
      note,
      alias,
      up_bytes: 0,
      down_bytes: 0,
      created_at: createdAt,
      expires_at: expiresAt,
      revoked_at: null,
      status: 'active',
    }

    // ① 先落 SQLite（事务）
    const insertTx = db.transaction(() => {
      repo.insert(row)
      // 审计留痕：永久记 { permanent: true }，限时记 { hours }；别名非空时一并留痕
      audit(
        'create',
        id,
        {
          note: note || null,
          ...(alias ? { alias } : {}),
          ...(permanent ? { permanent: true } : { hours }),
        },
        actor,
      )
    })
    insertTx()

    // ② 再 xray adu；失败 → 回滚 DB + 502（账本与数据面一致）
    try {
      await xray.addUser({ email, uuid })
    } catch (e) {
      db.transaction(() => {
        db.prepare('DELETE FROM links WHERE id = ?').run(id)
        // 审计留痕与账本一致：本次 create 未生效，同事务撤销审计行
        db.prepare('DELETE FROM audit_log WHERE link_id = ?').run(id)
      })()
      throw apiError(502, `xray 添加用户失败，已回滚: ${(e as Error).message}`)
    }
    return viewById(repo, id)
  }

  function activeRow(id: string): LinkRow {
    const row = repo.byId(id)
    if (!row) throw apiError(404, '链接不存在')
    if (row.status !== 'active') {
      throw apiError(400, `仅 active 链接可操作（当前 ${row.status}）`)
    }
    return row
  }

  async function revoke(id: string, actor?: string): Promise<LinkView> {
    const row = activeRow(id)
    const revokedAt = nowMs()
    // ① 先标 revoked（事务）
    db.transaction(() => {
      repo.revoke(id, revokedAt)
      audit('revoke', id, { note: row.note || null }, actor)
    })()
    // ② xray rmu；失败 → 回滚回 active（可重试）
    try {
      await xray.removeUser(id)
    } catch (e) {
      db.transaction(() => {
        db.prepare('UPDATE links SET status = ?, revoked_at = ? WHERE id = ?').run(
          'active',
          null,
          id,
        )
      })()
      throw apiError(502, `xray 删除用户失败，已回滚: ${(e as Error).message}`)
    }
    return viewById(repo, id)
  }

  // extend：三选一 —— 相对（hours）/ 绝对（expiresAt, epoch ms）/ 转永久（permanent: true）。
  //   - 两个及以上 / 一个都没有 → 400（要求明确意图，避免歧义）
  //   - hours：仅限时链接可延；expires_at 向后平移 hours（沿用 MAX_HOURS 上限）
  //   - expiresAt：直接把 expires_at 设为该值（显式绝对时刻，允许提前缩短有效期——
  //     用户「自由设置过期时间」的隐含语义；前端二次 confirm 提示）。
  //     范围 sanity：不得早于当前时刻（不允许设过去时间）；距 now > 365 天拒绝（防误填）。
  //   - permanent: true：限时 → 永久（expires_at = 哨兵 0）；已是永久 → 400
  //   - 永久 → 限时：用 expiresAt 表达（永久链接没有基准时刻，hours 无意义 → 400）
  async function extend(id: string, input: ExtendInput, actor?: string): Promise<LinkView> {
    const row = activeRow(id) // 延长/转换仅 active（MVP）
    const wasPermanent = isPermanentExpiry(row.expires_at)
    const { expiresAt, hours, permanent } = input
    if (permanent !== undefined && typeof permanent !== 'boolean') {
      throw apiError(400, 'permanent 须为布尔值')
    }
    const hasHours = hours !== undefined
    const hasAbs = expiresAt !== undefined
    const hasPerm = permanent === true

    const provided = [hasHours, hasAbs, hasPerm].filter(Boolean).length
    if (provided !== 1) {
      throw apiError(
        400,
        provided === 0
          ? '请指定 hours、expiresAt 或 permanent 之一'
          : '请三选一：hours / expiresAt / permanent，不能同时传',
      )
    }

    let newExpiry: number
    let detail: AuditDetail
    if (hasPerm) {
      if (wasPermanent) throw apiError(400, '该链接已是永久有效')
      newExpiry = PERMANENT_EXPIRES_AT
      detail = { permanent: true }
    } else if (hasAbs) {
      const at = expiresAt as number
      if (!Number.isFinite(at) || Math.trunc(at) !== at) {
        throw apiError(400, 'expiresAt 须为 epoch 毫秒整数')
      }
      const now = nowMs()
      if (at <= now) {
        throw apiError(400, 'expiresAt 须晚于当前时间（不允许设置过去时刻）')
      }
      if (at - now > MAX_EXPIRE_ABS_DAYS * 24 * 3600 * 1000) {
        throw apiError(400, `expiresAt 超出合理范围（未来 ${MAX_EXPIRE_ABS_DAYS} 天内）`)
      }
      newExpiry = at
      // 永久 → 限时：审计标注来源，便于后台一眼看出这次是「转限时」而非普通延长
      detail = wasPermanent
        ? { from: 'permanent', expiresAt: at, expires_at: newExpiry }
        : { expiresAt: at, expires_at: newExpiry }
    } else {
      const h = hours as number
      if (!Number.isInteger(h) || h < 1 || h > limits.maxHours) {
        throw apiError(400, `延长时长须为 1~${limits.maxHours} 小时的整数`)
      }
      if (wasPermanent) {
        throw apiError(400, '永久链接没有到期时刻可平移，请用 expiresAt 指定绝对到期时间')
      }
      newExpiry = row.expires_at + h * 3600 * 1000
      detail = { hours: h, expires_at: newExpiry }
    }
    // 仅落库（expires_at 是纯控制面字段，xray 侧无需改动）
    db.transaction(() => {
      repo.extendExpiry(id, newExpiry)
      audit('extend', id, detail, actor)
    })()
    return viewById(repo, id)
  }

  return {
    list: () => repo.list(),
    create,
    revoke,
    extend,
  }
}

function viewById(repo: LinksRepo, id: string): LinkView {
  const row = repo.byId(id)
  if (!row) throw apiError(404, '链接不存在')
  return toView(row)
}

