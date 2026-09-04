import type { Database } from 'better-sqlite3'
import { toView, type LinksRepo } from '../db/linksRepo.js'
import { newLinkId, randomUuid } from '../lib/id.js'
import type { CreateLinkInput, LinkRow, LinkView } from '../types.js'
import type { XrayClient } from './xrayClient.js'

// 业务编排：SQLite 账本为权威，xray 数据面为镜像。约定（REQUIREMENTS.md §5）：
//   所有写操作 = 先落 SQLite（事务）→ 再调 xray；
//   xray 失败 → 回滚 SQLite 并抛 502（保证账本与数据面一致）。
//
// 状态机：active → expired | revoked；expired/revoked 不可再延长；revoked 不可逆（MVP，
// 需求 §4 允许取舍：延长仅 active、revoked 不可复活）。
// 说明：仅 extend 不触 xray（expires_at 纯控制面字段）；create/revoke 才需要数据面一致。

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

/** 业务上限（默认值）来自 config，组装时注入——服务层不碰全局 config，利于测试 */
export interface LinkLimits {
  defaultHours: number
  maxHours: number
}

export interface LinkService {
  list(): LinkView[]
  create(input: CreateLinkInput): Promise<LinkView>
  revoke(id: string): Promise<LinkView>
  extend(id: string, hours: number): Promise<LinkView>
}

interface Deps {
  db: Database
  repo: LinksRepo
  xray: XrayClient
  limits: LinkLimits
  /** 默认取系统时钟；测试注入固定值 */
  now?: () => number
}

export function createLinkService(deps: Deps): LinkService {
  const { db, repo, xray, limits } = deps
  const nowMs = deps.now ?? (() => Date.now())

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

  async function create(input: CreateLinkInput): Promise<LinkView> {
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
    })
    insertTx()

    // ② 再 xray adu；失败 → 回滚 DB + 502（账本与数据面一致）
    try {
      await xray.addUser({ email, uuid })
    } catch (e) {
      db.transaction(() => {
        db.prepare('DELETE FROM links WHERE id = ?').run(id)
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

  async function revoke(id: string): Promise<LinkView> {
    activeRow(id)
    const revokedAt = nowMs()
    // ① 先标 revoked（事务）
    db.transaction(() => {
      repo.revoke(id, revokedAt)
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

  async function extend(id: string, hours: number): Promise<LinkView> {
    const row = activeRow(id) // 延长仅 active（MVP）
    if (!Number.isInteger(hours) || hours < 1 || hours > limits.maxHours) {
      throw apiError(400, `延长时长须为 1~${limits.maxHours} 小时的整数`)
    }
    const newExpiry = row.expires_at + hours * 3600 * 1000
    // 仅落库（expires_at 是纯控制面字段，xray 侧无需改动）
    db.transaction(() => {
      repo.extendExpiry(id, newExpiry)
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

