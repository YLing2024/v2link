import type { Database } from 'better-sqlite3'
import { toView, type LinksRepo } from '../db/linksRepo.js'
import type { MonitoringRepo } from '../db/monitoringRepo.js'
import { newLinkId, randomUuid } from '../lib/id.js'
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
// extend 双语义（TASK-extend-regions.md 需求 1）：
//   · hours 模式：相对延长，expires_at += hours*3600*1000（沿用 MAX_HOURS 上限）
//   · expiresAt 模式：直接设置绝对过期时刻（epoch ms）
// 两模式实现：先统一解析出「新的绝对过期时刻」，再一并落库 + 审计，天然二选一。

/** extend 入参：绝对过期时刻与相对延长二选一（服务层以「都传报 400 拒绝」为准） */
export interface ExtendInput {
  expiresAt?: number
  hours?: number
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

  // ---- 输入校验（与 API 表一致：默认 hours=24；hours≤720）----
  function normalizeInput(input: CreateLinkInput): { note: string; hours: number } {
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : ''
    const { hours } = input
    if (hours !== undefined) {
      if (!Number.isInteger(hours) || hours < 1 || hours > limits.maxHours) {
        throw apiError(400, `时长须为 1~${limits.maxHours} 小时的整数`)
      }
    }
    return {
      note,
      hours: hours ?? limits.defaultHours,
    }
  }

  async function create(input: CreateLinkInput, actor?: string): Promise<LinkView> {
    const { note, hours } = normalizeInput(input)
    const id = newLinkId()
    const uuid = randomUuid()
    const email = id // email = id（xray 用户标识/账本 key，REQUIREMENTS.md §4）
    const createdAt = nowMs()
    const expiresAt = createdAt + hours * 3600 * 1000
    const row: LinkRow = {
      id,
      uuid,
      email,
      note,
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
      audit('create', id, { note: note || null, hours }, actor)
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

  // extend：支持相对（hours）与绝对（expiresAt, epoch ms）两种模式。
  //   - 两者都传 / 都不传 → 400（要求明确意图，避免歧义）
  //   - hours：仅 active 可延；expires_at 向后平移 hours（沿用 MAX_HOURS 上限）
  //   - expiresAt：直接把 expires_at 设为该值（显式绝对时刻，允许提前缩短有效期——
  //     用户「自由设置过期时间」的隐含语义；前端二次 confirm 提示）。
  //     范围 sanity：不得早于当前时刻（不允许设过去时间）；距 now > 365 天拒绝（防误填）。
  async function extend(id: string, input: ExtendInput, actor?: string): Promise<LinkView> {
    const row = activeRow(id) // 延长仅 active（MVP）
    const { expiresAt, hours } = input
    const hasHours = hours !== undefined
    const hasAbs = expiresAt !== undefined
    if (hasHours === hasAbs) {
      throw apiError(400, hasHours ? '请二选一：expiresAt 或 hours，不能同时传' : '请指定 expiresAt 或 hours')
    }

    let newExpiry: number
    let detail: AuditDetail
    if (hasAbs) {
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
      detail = { expiresAt: at, expires_at: newExpiry }
    } else {
      const h = hours as number
      if (!Number.isInteger(h) || h < 1 || h > limits.maxHours) {
        throw apiError(400, `延长时长须为 1~${limits.maxHours} 小时的整数`)
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

