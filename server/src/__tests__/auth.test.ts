import express from 'express'
import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { makeTestDb } from './helpers.js'
import { createAccountService, type AccountService } from '../services/accountService.js'
import { createAuthRouter } from '../routes/auth.js'
import { createAuthMiddleware } from '../middleware/auth.js'
import type { AuthDeps } from '../middleware/auth.js'
import type { AuthMode } from '../config.js'

// 认证模式（AUTH_MODE）契约：
//   builtin：自带账号会话（cookie / Bearer），忽略 X-Auth-User；
//   sso：只认 X-Auth-User，自带账号接口 404。
// 用内存库 + 显式注入 deps，不依赖全局 config 单例。

const ADMIN = 'admin'
const PASSWORD = 'correct-horse-battery'
const TTL_MS = 12 * 3600 * 1000

function makeAccounts(): AccountService {
  const accounts = createAccountService(makeTestDb(), { sessionTtlMs: TTL_MS })
  accounts.bootstrapAdmin(ADMIN, PASSWORD)
  return accounts
}

function buildApp(mode: AuthMode, accounts: AccountService) {
  const deps: AuthDeps = { mode, accounts }
  const app = express()
  app.use(express.json())
  app.use('/api', createAuthRouter(deps))
  app.use('/api', createAuthMiddleware(deps))
  app.use('/api/ping', (req, res) => {
    res.json({ ok: true, user: req.authUser })
  })
  return app
}

/** 从 Set-Cookie 里取出 v2link_session 的 `name=value` 片段 */
function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined
  const cookie = (raw ?? []).find((c) => c.startsWith('v2link_session='))
  expect(cookie).toBeTruthy()
  return cookie!.split(';')[0]
}

function tokenOf(cookie: string): string {
  return cookie.slice('v2link_session='.length)
}

describe('builtin：自带账号会话', () => {
  it('GET /api/auth-mode → builtin；未登录访问业务接口 → 401', async () => {
    const app = buildApp('builtin', makeAccounts())
    const mode = await request(app).get('/api/auth-mode')
    expect(mode.status).toBe(200)
    expect(mode.body).toEqual({ authMode: 'builtin' })

    const res = await request(app).get('/api/ping')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('未登录')
  })

  it('builtin 忽略 X-Auth-User（不因外部头提权）', async () => {
    const app = buildApp('builtin', makeAccounts())
    const res = await request(app).get('/api/ping').set('X-Auth-User', 'hacker')
    expect(res.status).toBe(401)
  })

  it('错口令 → 401 且不种 cookie', async () => {
    const app = buildApp('builtin', makeAccounts())
    const res = await request(app).post('/api/auth/login').send({ username: ADMIN, password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('账号或密码错误')
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('登录成功 → 200 + HttpOnly cookie；带 cookie 访问业务接口 200', async () => {
    const app = buildApp('builtin', makeAccounts())
    const login = await request(app).post('/api/auth/login').send({ username: ADMIN, password: PASSWORD })
    expect(login.status).toBe(200)
    expect(login.body).toMatchObject({ ok: true, user: { name: ADMIN } })
    const raw = (login.headers['set-cookie'] as unknown as string[]) ?? []
    expect(raw.some((c) => /HttpOnly/i.test(c))).toBe(true)
    expect(raw.some((c) => /Max-Age=\d+/i.test(c))).toBe(true)

    const cookie = sessionCookie(login)
    const res = await request(app).get('/api/ping').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, user: ADMIN })
  })

  it('Bearer token 与 cookie 等价；GET /api/auth/me → 200 name', async () => {
    const app = buildApp('builtin', makeAccounts())
    const login = await request(app).post('/api/auth/login').send({ username: ADMIN, password: PASSWORD })
    const token = tokenOf(sessionCookie(login))

    const byBearer = await request(app).get('/api/ping').set('Authorization', `Bearer ${token}`)
    expect(byBearer.status).toBe(200)

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ ok: true, name: ADMIN })

    const anon = await request(app).get('/api/auth/me')
    expect(anon.status).toBe(401)
  })

  it('登出后旧 cookie / 旧 Bearer 立即 401；登出幂等', async () => {
    const app = buildApp('builtin', makeAccounts())
    const login = await request(app).post('/api/auth/login').send({ username: ADMIN, password: PASSWORD })
    const cookie = sessionCookie(login)
    const token = tokenOf(cookie)

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie)
    expect(out.status).toBe(200)
    const again = await request(app).post('/api/auth/logout')
    expect(again.status).toBe(200)

    expect((await request(app).get('/api/ping').set('Cookie', cookie)).status).toBe(401)
    expect((await request(app).get('/api/ping').set('Authorization', `Bearer ${token}`)).status).toBe(401)
  })
})

describe('sso：只认 X-Auth-User', () => {
  it('auth-mode=sso；无头 401、带 X-Auth-User 200；auth/login 404', async () => {
    const app = buildApp('sso', makeAccounts())
    expect((await request(app).get('/api/auth-mode')).body).toEqual({ authMode: 'sso' })

    expect((await request(app).get('/api/ping')).status).toBe(401)
    const ok = await request(app).get('/api/ping').set('X-Auth-User', 'test')
    expect(ok.status).toBe(200)
    expect(ok.body.user).toBe('test')

    expect((await request(app).post('/api/auth/login').send({ username: ADMIN, password: PASSWORD })).status).toBe(404)
    expect((await request(app).post('/api/auth/logout')).status).toBe(404)
    expect((await request(app).get('/api/auth/me')).status).toBe(404)
  })
})

describe('口令哈希', () => {
  it('scrypt 格式 + timingSafeEqual：正确口令通过、错误口令拒绝、异构哈希拒绝', async () => {
    const { hashPassword, verifyPasswordHash } = await import('../services/accountService.js')
    const stored = hashPassword(PASSWORD)
    expect(stored).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/)
    expect(verifyPasswordHash(PASSWORD, stored)).toBe(true)
    expect(verifyPasswordHash('nope', stored)).toBe(false)
    expect(verifyPasswordHash(PASSWORD, 'plaintext')).toBe(false)
  })
})
