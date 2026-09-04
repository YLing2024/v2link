import type { Database } from 'better-sqlite3'
import { getDb } from './connection.js'
import type {
  AuditAction,
  AuditDetail,
  AuditRow,
  AuditView,
  ConnectionRow,
  DbLike,
  TrafficSampleRow,
} from '../types.js'

// 监控/追溯/审计数据访问（TASK-monitoring.md A/B/C）：全部 prepared statement。
// 写操作由服务层/采集器包在 db.transaction 里调用；批量语义：tailer 攒批 100 行一插。
// 读操作组装 WHERE 的每一列都有索引锚点：(link_id, ts) / (ts) / host 前缀过滤在
// link_id 子集内扫描（行数有限），不触发全表扫。

export interface SampleQuery {
  id?: string
  email?: string
  from: number
  to: number
}

export interface ConnectionQuery {
  link_id?: string
  email?: string
  /** host 前缀过滤（按域名简单搜索；仅配合 link_id/email 使用） */
  hostPrefix?: string
  from?: number
  to?: number
}

export interface Page<T> {
  rows: T[]
  total: number
}

export interface AuditQuery {
  from?: number
  to?: number
}

export interface MonitoringRepo {
  listSamples(q: SampleQuery): TrafficSampleRow[]
  insertSamples(rows: { link_id: string; ts: number; up_delta: number; down_delta: number }[]): void
  deleteSamplesBefore(ts: number): number

  listConnections(q: ConnectionQuery & { limit: number; offset: number }): Page<ConnectionRow>
  insertConnections(rows: {
    link_id: string | null
    email: string
    ts: number
    host: string | null
    port: number | null
    up_bytes: number | null
    down_bytes: number | null
    duration_ms: number | null
  }[]): void
  deleteConnectionsBefore(ts: number): number

  insertAudit(input: {
    ts: number
    actor: string
    action: AuditAction
    link_id: string | null
    detail: AuditDetail
  }): void
  listAudit(q: AuditQuery & { limit: number; offset: number }): Page<AuditView>
}

// ---- WHERE 组装（白名单列；所有动态片段皆来自受控枚举，无注入面）----

interface ConnCond {
  link_id?: string
  email?: string
  hostPrefix?: string
  from?: number
  to?: number
}

function connWhere(c: ConnCond): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  if (c.link_id !== undefined) {
    parts.push('link_id = ?')
    params.push(c.link_id)
  } else if (c.email !== undefined) {
    parts.push('email = ?')
    params.push(c.email)
  }
  if (c.hostPrefix !== undefined && c.hostPrefix !== '') {
    parts.push('host LIKE ?')
    params.push(`${c.hostPrefix}%`)
  }
  if (c.from !== undefined) {
    parts.push('ts >= ?')
    params.push(c.from)
  }
  if (c.to !== undefined) {
    parts.push('ts < ?')
    params.push(c.to)
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

function statements(db: Database): MonitoringRepo {
  // ---- traffic_samples ----
  const stmtSampleByLink = db.prepare(
    `SELECT * FROM traffic_samples
     WHERE link_id = ? AND ts >= ? AND ts < ?
     ORDER BY ts ASC`,
  )
  const stmtSampleByEmail = db.prepare(
    `SELECT ts.* FROM traffic_samples ts
     JOIN links l ON l.id = ts.link_id
     WHERE l.email = ? AND ts.ts >= ? AND ts.ts < ?
     ORDER BY ts.ts ASC`,
  )
  const stmtInsertSample = db.prepare(
    `INSERT INTO traffic_samples (link_id, ts, up_delta, down_delta)
     VALUES (@link_id, @ts, @up_delta, @down_delta)`,
  )
  const stmtDeleteSamples = db.prepare('DELETE FROM traffic_samples WHERE ts < ?')

  // ---- connections ----
  const stmtInsertConn = db.prepare(
    `INSERT INTO connections (link_id, email, ts, host, port, up_bytes, down_bytes, duration_ms)
     VALUES (@link_id, @email, @ts, @host, @port, @up_bytes, @down_bytes, @duration_ms)`,
  )
  const stmtDeleteConns = db.prepare('DELETE FROM connections WHERE ts < ?')

  // ---- audit_log ----
  const stmtInsertAudit = db.prepare(
    `INSERT INTO audit_log (ts, actor, action, link_id, detail)
     VALUES (@ts, @actor, @action, @link_id, @detail)`,
  )

  return {
    listSamples({ id, email, from, to }) {
      const rows = email
        ? (stmtSampleByEmail.all(email, from, to) as unknown as TrafficSampleRow[])
        : (stmtSampleByLink.all(id ?? '', from, to) as unknown as TrafficSampleRow[])
      return rows.map((r) => ({ ...r, ts: Number(r.ts) }))
    },

    insertSamples(rows) {
      if (!rows.length) return
      const tx = db.transaction(() => {
        for (const r of rows) stmtInsertSample.run({ ...r })
      })
      tx()
    },

    deleteSamplesBefore(ts) {
      return stmtDeleteSamples.run(ts).changes
    },

    listConnections({ link_id, email, hostPrefix, from, to, limit, offset }) {
      const cond: ConnCond = { link_id, email, hostPrefix, from, to }
      const { sql, params } = connWhere(cond)
      const stmt = db.prepare(
        `SELECT * FROM connections ${sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
      )
      const cntStmt = db.prepare(`SELECT COUNT(*) AS n FROM connections ${sql}`)
      const rows = stmt.all(...params, limit, offset) as unknown as ConnectionRow[]
      const total = (cntStmt.get(...params) as { n: number }).n
      return { rows: rows.map((r) => ({ ...r, id: Number(r.id), ts: Number(r.ts) })), total }
    },

    insertConnections(rows) {
      if (!rows.length) return
      const tx = db.transaction(() => {
        for (const r of rows) stmtInsertConn.run({ ...r })
      })
      tx()
    },

    deleteConnectionsBefore(ts) {
      return stmtDeleteConns.run(ts).changes
    },

    insertAudit(input) {
      stmtInsertAudit.run({
        ts: input.ts,
        actor: input.actor,
        action: input.action,
        link_id: input.link_id,
        detail: input.detail ? JSON.stringify(input.detail) : null,
      })
    },

    listAudit({ from, to, limit, offset }) {
      const cond: { from?: number; to?: number } = { from, to }
      const parts: string[] = []
      const params: unknown[] = []
      if (cond.from !== undefined) {
        parts.push('ts >= ?')
        params.push(cond.from)
      }
      if (cond.to !== undefined) {
        parts.push('ts < ?')
        params.push(cond.to)
      }
      const where = parts.length ? `WHERE ${parts.join(' AND ')}` : ''
      const stmt = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      const cntStmt = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`)
      const rows = stmt.all(...params, limit, offset) as unknown as AuditRow[]
      const total = (cntStmt.get(...params) as { n: number }).n
      return {
        rows: rows.map((r) => ({
          ...r,
          id: Number(r.id),
          ts: Number(r.ts),
          detail: r.detail === null ? null : safeJson(r.detail),
        })),
        total,
      }
    },
  }
}

function safeJson(raw: string): AuditDetail {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

export function createMonitoringRepo(db: DbLike = getDb()): MonitoringRepo {
  return statements(db as Database)
}
