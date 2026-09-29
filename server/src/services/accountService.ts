import crypto from 'node:crypto'
import { config } from '../config.js'
import { getDb } from '../db/connection.js'
import type { DbLike } from '../types.js'

// 自带账号体系（AUTH_MODE=builtin，默认）。
// 口令哈希一律走 node:crypto 的 scrypt（零新依赖），格式 `scrypt$<saltHex>$<hashHex>`；
// 会话 token 为 32 字节随机十六进制，TTL 由 config.sessionTtlMs 决定，命中滑动续期。
// SQL 只在本文件出现，路由/中间件不直接碰表。

const HASH_PREFIX = 'scrypt'
const SALT_BYTES = 16
const KEY_BYTES = 64
const TOKEN_BYTES = 32

/** 口令 → `scrypt$<saltHex>$<hashHex>`（每次随机 salt，绝不存明文） */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES)
  const hash = crypto.scryptSync(password, salt, KEY_BYTES)
  return `${HASH_PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`
}

/** 恒定时间比较；格式非法 / 长度不符一律 false（不抛异常） */
export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== HASH_PREFIX) return false
  const saltHex = parts[1]
  const hashHex = parts[2]
  if (!saltHex || !hashHex) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltHex, 'hex')
    expected = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  const actual = crypto.scryptSync(password, salt, expected.length)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

/** 随机初始口令：16 个 URL 安全字符（12 字节 base64url） */
export function randomPassword(): string {
  return crypto.randomBytes(12).toString('base64url')
}

export interface UserRow {
  id: number
  username: string
  password_hash: string
  created_at: string
}

export interface AccountService {
  /** users 表当前行数（首启引导判据） */
  userCount(): number
  /** 新增用户（username 冲突抛错；调用方自行保证幂等） */
  createUser(username: string, password: string): void
  /** 首启引导：users 为空才建管理员；已有用户不覆盖口令。password 缺省则随机 */
  bootstrapAdmin(username: string, password?: string): { created: boolean; password?: string }
  /** 校验账号口令（用户不存在 / 口令错均为 false） */
  verifyPassword(username: string, password: string): boolean
  /** 建会话，返回 token */
  createSession(username: string): string
  /** 校验会话；命中滑动续期，返回用户名，未命中/过期返回 null（过期行顺带删除） */
  verifySession(token: string): string | null
  /** 删会话（幂等） */
  destroySession(token: string): void
  /** 清理已过期会话，返回删除行数 */
  cleanupExpiredSessions(now?: number): number
}

export interface AccountServiceOptions {
  /** 会话 TTL（毫秒） */
  sessionTtlMs: number
}

export function createAccountService(db: DbLike, opts: AccountServiceOptions): AccountService {
  const userCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n

  const createUser = (username: string, password: string): void => {
    db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(
      username,
      hashPassword(password),
      new Date().toISOString(),
    )
  }

  const bootstrapAdmin = (
    username: string,
    password?: string,
  ): { created: boolean; password?: string } => {
    if (userCount() > 0) return { created: false }
    const provided = password && password.trim() ? password.trim() : undefined
    const initial = provided ?? randomPassword()
    createUser(username, initial)
    return { created: true, password: provided ? undefined : initial }
  }

  const verifyPassword = (username: string, password: string): boolean => {
    const row = db
      .prepare('SELECT password_hash FROM users WHERE username = ?')
      .get(username) as { password_hash: string } | undefined
    if (!row) return false
    return verifyPasswordHash(password, row.password_hash)
  }

  const createSession = (username: string): string => {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex')
    const now = Date.now()
    db.prepare('INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      token,
      username,
      new Date(now).toISOString(),
      new Date(now + opts.sessionTtlMs).toISOString(),
    )
    return token
  }

  const verifySession = (token: string): string | null => {
    const row = db.prepare('SELECT username, expires_at FROM sessions WHERE token = ?').get(token) as
      | { username: string; expires_at: string }
      | undefined
    if (!row) return null
    const now = Date.now()
    if (Date.parse(row.expires_at) <= now) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
      return null
    }
    // 命中滑动续期：把到期时刻推后一个 TTL
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(
      new Date(now + opts.sessionTtlMs).toISOString(),
      token,
    )
    return row.username
  }

  const destroySession = (token: string): void => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
  }

  const cleanupExpiredSessions = (now: number = Date.now()): number => {
    return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString())
      .changes
  }

  return {
    userCount,
    createUser,
    bootstrapAdmin,
    verifyPassword,
    createSession,
    verifySession,
    destroySession,
    cleanupExpiredSessions,
  }
}

// 进程内单例（生产/启动路径用；测试请直接 createAccountService 注入临时库）
let singleton: AccountService | null = null

export function getAccountService(): AccountService {
  if (!singleton) {
    singleton = createAccountService(getDb(), { sessionTtlMs: config.sessionTtlMs })
  }
  return singleton
}
