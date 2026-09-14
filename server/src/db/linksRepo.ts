import type { Database } from 'better-sqlite3'
import { getDb } from '../db/connection.js'
import { isPermanentExpiry, PERMANENT_EXPIRES_AT } from '../lib/expiry.js'
import type { DbLike, LinkRow, LinkStatus, LinkView } from '../types.js'

// links 表数据访问：全部 prepared statement（禁字符串拼接 SQL）。
// 写操作由服务层包在 db.transaction 里调用；本层函数本身不开启事务。

// 行 → 前端展示视图：内部 snake 列对外 camel 化，整型归一
export function toView(row: LinkRow): LinkView {
  return {
    id: row.id,
    uuid: row.uuid,
    note: row.note,
    alias: row.alias ?? '',
    upBytes: Number(row.up_bytes),
    downBytes: Number(row.down_bytes),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    // 永久语义由 expires_at 哨兵推导（见 lib/expiry.ts），前端优先用该布尔值
    permanent: isPermanentExpiry(Number(row.expires_at)),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    status: row.status,
  }
}

export interface LinksRepo {
  list(): LinkView[]
  byId(id: string): LinkRow | undefined
  /** 返回新行（须在服务层事务内使用） */
  insert(row: LinkRow): void
  updateStatus(id: string, status: LinkStatus, revokedAt: number | null): void
  addTraffic(id: string, upDelta: number, downDelta: number): void
  /** 返回上一状态；用于「状态机合法性」校验（active 才允许转移/延长） */
  getStatus(id: string): LinkStatus | undefined
  /** 一次性找出已过期但仍 active 的链接（过期扫描） */
  findActiveExpired(now: number): LinkRow[]
  /** 找出指定 uuid 仍 active 的链接（重启首拉放行判定） */
  findActiveByUuid(uuid: string): LinkRow | undefined
  /** 按 email 找仍 active 的链接（access log 采集关联） */
  findActiveByEmail(email: string): LinkRow | undefined
  listActive(): LinkRow[]
  extendExpiry(id: string, newExpiry: number): void
  expire(id: string, at: number): void
  revoke(id: string, at: number): void
}

function statements(db: Database): LinksRepo {
  const stmtInsert = db.prepare(
    `INSERT INTO links (id, uuid, email, note, alias, up_bytes, down_bytes, created_at, expires_at, revoked_at, status)
     VALUES (@id, @uuid, @email, @note, @alias, @up_bytes, @down_bytes, @created_at, @expires_at, @revoked_at, @status)`,
  )
  const stmtById = db.prepare('SELECT * FROM links WHERE id = ?')
  const stmtStatus = db.prepare('SELECT status FROM links WHERE id = ?')
  const stmtUpdateStatus = db.prepare('UPDATE links SET status = ?, revoked_at = ? WHERE id = ?')
  const stmtAddTraffic = db.prepare(
    'UPDATE links SET up_bytes = up_bytes + ?, down_bytes = down_bytes + ? WHERE id = ?',
  )
  const stmtActiveExpired = db.prepare(
    // expires_at = PERMANENT_EXPIRES_AT(0) 为永久链接，永不进入过期集
    `SELECT * FROM links WHERE status = 'active' AND expires_at > ? AND expires_at < ?`,
  )
  const stmtActiveByUuid = db.prepare(`SELECT * FROM links WHERE uuid = ? AND status = 'active'`)
  const stmtActiveByEmail = db.prepare(`SELECT * FROM links WHERE email = ? AND status = 'active'`)
  const stmtListActive = db.prepare(`SELECT * FROM links WHERE status = 'active'`)
  const stmtExtend = db.prepare('UPDATE links SET expires_at = ? WHERE id = ?')
  const stmtExpire = db.prepare(
    "UPDATE links SET status = 'expired' WHERE id = ? AND status = 'active'",
  )
  const stmtRevoke = db.prepare(
    "UPDATE links SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'",
  )
  const stmtList = db.prepare('SELECT * FROM links ORDER BY created_at DESC')

  return {
    list() {
      return stmtList.all().map((r) => toView(r as unknown as LinkRow))
    },
    byId(id) {
      const r = stmtById.get(id) as unknown as LinkRow | undefined
      return r
    },
    insert(row) {
      stmtInsert.run({ ...row })
    },
    updateStatus(id, status, revokedAt) {
      stmtUpdateStatus.run(status, revokedAt, id)
    },
    addTraffic(id, upDelta, downDelta) {
      stmtAddTraffic.run(upDelta, downDelta, id)
    },
    getStatus(id) {
      const r = stmtStatus.get(id) as { status: LinkStatus } | undefined
      return r?.status
    },
    findActiveExpired(now) {
      return stmtActiveExpired.all(PERMANENT_EXPIRES_AT, now).map((r) => r as unknown as LinkRow)
    },
    findActiveByUuid(uuid) {
      const r = stmtActiveByUuid.get(uuid) as unknown as LinkRow | undefined
      return r
    },
    findActiveByEmail(email) {
      const r = stmtActiveByEmail.get(email) as unknown as LinkRow | undefined
      return r
    },
    listActive() {
      return stmtListActive.all().map((r) => r as unknown as LinkRow)
    },
    extendExpiry(id, newExpiry) {
      stmtExtend.run(newExpiry, id)
    },
    expire(id, at) {
      // at 仅作占位(状态语义不需要时间戳)，保留列以与 revoked_at 对齐
      void at
      const info = stmtExpire.run(id)
      return info.changes > 0
    },
    revoke(id, at) {
      const info = stmtRevoke.run(at, id)
      return info.changes > 0
    },
  }
}

export function createLinksRepo(db: DbLike = getDb()): LinksRepo {
  return statements(db as Database)
}
