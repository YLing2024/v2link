import { getDb } from './connection.js'
import type { DbLike } from '../types.js'

// DDL 初始化：links 表 + 索引（schema 与 REQUIREMENTS.md §4 逐字一致）
// 状态机注释：
//   active → (rmu + 标) expired | revoked
//   expired/revoked 不可再延长/改速；revoked 不可逆（MVP 约定，见需求 §4/§5 取舍）

export function initSchema(db: DbLike = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id          TEXT PRIMARY KEY,
      uuid        TEXT NOT NULL UNIQUE,
      email       TEXT NOT NULL UNIQUE,
      note        TEXT NOT NULL DEFAULT '',
      speed_mbps  INTEGER NOT NULL DEFAULT 10,
      up_bytes    INTEGER NOT NULL DEFAULT 0,
      down_bytes  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      revoked_at  INTEGER,
      status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked'))
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_links_status ON links(status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_links_expires ON links(expires_at)')

  // 预留：audit_log（操作审计，MVP 仅留 schema，UI 二期）。
  // 需求 §4/§11 允许 schema 留注释，此处不建表以免空表增加维护噪音；
  // 若启用，设计为记录 generate/revoke/extend/speed 的操作者 + 时间戳（见 README「取舍」）。
}
