import Database from 'better-sqlite3'
import { config, ensureDbDir } from '../config.js'

// better-sqlite3 进程内单例；账本（权威）存 <server>/data/v2link.db
// 所有业务访问都经 db/repositories/*（prepared statements），本模块只负责开连接。

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    ensureDbDir()
    db = new Database(config.dbPath)
    // WAL：账本累计与 API 读并发更优；NORMAL 同步级别在可接受持久性下性能更好
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

// 测试注入：用内存库/临时库替代单例（见 __tests__/helpers.ts）
export function setDbForTest(d: Database.Database | null): void {
  db = d
}
