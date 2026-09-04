import { getDb } from './connection.js'
import type { DbLike } from '../types.js'

// DDL 初始化：links 表 + 索引（schema 与 REQUIREMENTS.md §4 逐字一致，不含 speed_mbps 列）
// 状态机注释：
//   active → (rmu + 标) expired | revoked
//   expired/revoked 不可再延长；revoked 不可逆（MVP 约定，见需求 §4/§5 取舍）

export function initSchema(db: DbLike = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id          TEXT PRIMARY KEY,
      uuid        TEXT NOT NULL UNIQUE,
      email       TEXT NOT NULL UNIQUE,
      note        TEXT NOT NULL DEFAULT '',
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

  // 安全迁移：老库（v0.1）links 表含 speed_mbps 列（限速字段，xray 无原生支持已弃用）。
  // 优先 ALTER TABLE DROP COLUMN（SQLite ≥ 3.35，运行时 better-sqlite3 均为新版本）；
  // 兜底（老 SQLite 不支持）走「建新表 → 搬迁 → 换名」。
  dropSpeedColumn(db)

  // 预留：audit_log（操作审计，MVP 仅留 schema，UI 二期）。
  // 需求 §4/§11 允许 schema 留注释，此处不建表以免空表增加维护噪音；
  // 若启用，设计为记录 generate/revoke/extend 的操作者 + 时间戳（见 README「取舍」）。
}

// 检测旧列存在（SQLite 3.35+ 语法）；兼容老库无列的情况
function hasSpeedColumn(db: DbLike): boolean {
  const rows = db
    .prepare("SELECT name FROM pragma_table_info('links')")
    .all() as { name: string }[]
  return rows.some((r) => r.name === 'speed_mbps')
}

function dropSpeedColumn(db: DbLike): void {
  if (!hasSpeedColumn(db)) return
  const tx = db.transaction(() => {
    try {
      db.exec('ALTER TABLE links DROP COLUMN speed_mbps')
    } catch {
      // SQLite < 3.35 不支持 DROP COLUMN：重建表并搬迁数据（保留索引重建）
      db.exec(`
        CREATE TABLE links_new (
          id          TEXT PRIMARY KEY,
          uuid        TEXT NOT NULL UNIQUE,
          email       TEXT NOT NULL UNIQUE,
          note        TEXT NOT NULL DEFAULT '',
          up_bytes    INTEGER NOT NULL DEFAULT 0,
          down_bytes  INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          revoked_at  INTEGER,
          status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked'))
        )
      `)
      db.exec(
        `INSERT INTO links_new (id, uuid, email, note, up_bytes, down_bytes, created_at, expires_at, revoked_at, status)
         SELECT id, uuid, email, note, up_bytes, down_bytes, created_at, expires_at, revoked_at, status FROM links`,
      )
      db.exec('DROP TABLE links')
      db.exec('ALTER TABLE links_new RENAME TO links')
      db.exec('CREATE INDEX IF NOT EXISTS idx_links_status ON links(status)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_links_expires ON links(expires_at)')
    }
  })
  tx()
}
