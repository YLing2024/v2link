import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initSchema } from '../db/init.js'

// links 表迁移：alias 列（用户 2026-09-14 需求）。
// 老库（无 alias）上线后必须补列且保留数据；新库直接建全；重复执行幂等。

function columns(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM pragma_table_info('links')").all() as { name: string }[]).map(
    (r) => r.name,
  )
}

describe('initSchema：alias 列迁移', () => {
  it('新库：即刻含 alias 列，默认空串', () => {
    const db = new Database(':memory:')
    initSchema(db)
    expect(columns(db)).toContain('alias')
    db.exec(
      "INSERT INTO links (id,uuid,email,note,created_at,expires_at,status) VALUES ('lk_1','u1','lk_1','',1,2,'active')",
    )
    const row = db.prepare('SELECT alias FROM links WHERE id=?').get('lk_1') as { alias: string }
    expect(row.alias).toBe('')
    db.close()
  })

  it('老库（无 alias 列）：补齐列且保留原有数据', () => {
    const db = new Database(':memory:')
    // 模拟 v0.1 老库：无 alias、无 speed_mbps
    db.exec(`
      CREATE TABLE links (
        id          TEXT PRIMARY KEY,
        uuid        TEXT NOT NULL UNIQUE,
        email       TEXT NOT NULL UNIQUE,
        note        TEXT NOT NULL DEFAULT '',
        up_bytes    INTEGER NOT NULL DEFAULT 0,
        down_bytes  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        revoked_at  INTEGER,
        status      TEXT NOT NULL DEFAULT 'active'
      )
    `)
    db.exec(
      "INSERT INTO links (id,uuid,email,note,created_at,expires_at,status) VALUES ('lk_old','u','lk_old','老数据',1,2,'active')",
    )
    expect(columns(db)).not.toContain('alias')

    initSchema(db)

    expect(columns(db)).toContain('alias')
    const row = db.prepare('SELECT note, alias FROM links WHERE id=?').get('lk_old') as {
      note: string
      alias: string
    }
    expect(row.note).toBe('老数据')
    expect(row.alias).toBe('')
    db.close()
  })

  it('幂等：重复 initSchema 不报错、列不重复', () => {
    const db = new Database(':memory:')
    initSchema(db)
    initSchema(db)
    expect(columns(db).filter((c) => c === 'alias')).toHaveLength(1)
    db.close()
  })
})
