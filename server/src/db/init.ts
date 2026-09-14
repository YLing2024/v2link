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
      alias       TEXT NOT NULL DEFAULT '',
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

  // 安全迁移：别名列（用户 2026-09-14 需求，vless 链接 #fragment = 客户端节点名）。
  // ALTER TABLE ADD COLUMN 带默认值，SQLite 为 O(1)，老库数据保留，值默认 ''。
  addAliasColumn(db)

  // 监控/追溯/审计三张表（TASK-monitoring.md A/B/C）：
  //   traffic_samples：流量采样（30s 粒度 delta，近 30 天，scheduler 每天清理）
  //   connections：xray access log 采集（连接建立事件，近 7 天，scheduler 每小时清理）
  //   audit_log：后台操作留痕（create/revoke/extend，仅管理员，不做保留裁剪）
  db.exec(`
    CREATE TABLE IF NOT EXISTS traffic_samples (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id     TEXT NOT NULL REFERENCES links(id),
      ts          INTEGER NOT NULL,
      up_delta    INTEGER NOT NULL DEFAULT 0,
      down_delta  INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_samples_link_ts ON traffic_samples(link_id, ts)')

  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id      TEXT,
      email        TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      host         TEXT,
      port         INTEGER,
      up_bytes     INTEGER,
      down_bytes   INTEGER,
      duration_ms  INTEGER
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_conn_link_ts ON connections(link_id, ts)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_conn_ts ON connections(ts)')

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      actor    TEXT NOT NULL,
      action   TEXT NOT NULL,
      link_id  TEXT,
      detail   TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)')
}

// 检测旧列存在（SQLite 3.35+ 语法）；兼容老库无列的情况
function hasSpeedColumn(db: DbLike): boolean {
  const rows = db
    .prepare("SELECT name FROM pragma_table_info('links')")
    .all() as { name: string }[]
  return rows.some((r) => r.name === 'speed_mbps')
}

function hasAliasColumn(db: DbLike): boolean {
  const rows = db
    .prepare("SELECT name FROM pragma_table_info('links')")
    .all() as { name: string }[]
  return rows.some((r) => r.name === 'alias')
}

/** 别名列补齐（老库升级路径）；已是新库则直接跳过 */
function addAliasColumn(db: DbLike): void {
  if (hasAliasColumn(db)) return
  db.exec("ALTER TABLE links ADD COLUMN alias TEXT NOT NULL DEFAULT ''")
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
