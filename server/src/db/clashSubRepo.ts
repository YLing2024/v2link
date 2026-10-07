import type { Database } from 'better-sqlite3'
import { getDb } from './connection.js'
import type { ClashSubRow, DbLike } from '../types.js'

// clash_subs 数据访问：全部 prepared statement。
// 订阅是「指针」不是快照 —— link_ids 只存 id 列表，正文每次抓取时按链接当前状态重新生成。

export interface ClashSubRepo {
  insert(row: ClashSubRow): void
  byToken(token: string): ClashSubRow | undefined
  /** 删除已过期订阅，返回删除行数（scheduler 定期清理） */
  deleteExpired(now: number): number
}

function statements(db: Database): ClashSubRepo {
  const stmtInsert = db.prepare(
    `INSERT INTO clash_subs (token, link_ids, created_at, expires_at, created_by)
     VALUES (@token, @link_ids, @created_at, @expires_at, @created_by)`,
  )
  const stmtByToken = db.prepare('SELECT * FROM clash_subs WHERE token = ?')
  const stmtDeleteExpired = db.prepare('DELETE FROM clash_subs WHERE expires_at <= ?')

  return {
    insert(row) {
      stmtInsert.run({ ...row })
    },
    byToken(token) {
      return stmtByToken.get(token) as unknown as ClashSubRow | undefined
    },
    deleteExpired(now) {
      return stmtDeleteExpired.run(now).changes
    },
  }
}

export function createClashSubRepo(db: DbLike = getDb()): ClashSubRepo {
  return statements(db as Database)
}
