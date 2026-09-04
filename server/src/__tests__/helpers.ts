import Database from 'better-sqlite3'
import { initSchema } from '../db/init.js'
import { createLinksRepo, type LinksRepo } from '../db/linksRepo.js'
import { createMonitoringRepo, type MonitoringRepo } from '../db/monitoringRepo.js'

// 测试工具：内存 SQLite + schema + repo；统一供各服务测试使用
export function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  initSchema(db)
  return db
}

export function makeRepo(db: Database.Database): LinksRepo {
  return createLinksRepo(db)
}

export function makeMonitor(db: Database.Database): MonitoringRepo {
  return createMonitoringRepo(db)
}
