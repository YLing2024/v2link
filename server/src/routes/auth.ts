import { Router, type Request, type Response } from 'express'
import { config } from '../config.js'
import {
  SESSION_COOKIE,
  defaultAuthDeps,
  readSessionToken,
  type AuthDeps,
} from '../middleware/auth.js'

// /api 认证入口（前缀 /api）：
//   GET  /api/auth-mode   免鉴权，返回当前模式（只此一个字段）
//   POST /api/auth/login  builtin：校验口令 → 建会话 + 写 HttpOnly cookie（按 IP 限速）
//   POST /api/auth/logout builtin：删会话 + 清 cookie（幂等）
//   GET  /api/auth/me     builtin：返回当前用户名，未登录 401
//   sso 模式下 login/logout/me 一律 404（身份交给前置认证）。
// 注意：本路由不读写 users/sessions 表，账号逻辑全在 services/accountService。

// 登录限速：按 IP 记录失败次数，窗口内超限返回 429（内存计数，进程重启清零）
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 10
const loginFailures = new Map<string, { count: number; resetAt: number }>()

function clientIp(req: Request): string {
  return req.ip?.trim() || req.socket.remoteAddress || 'unknown'
}

/** 返回剩余封禁秒数；0 表示未封禁（并顺带清理过期窗口） */
function blockedSeconds(ip: string, now: number): number {
  const entry = loginFailures.get(ip)
  if (!entry) return 0
  if (entry.resetAt <= now) {
    loginFailures.delete(ip)
    return 0
  }
  if (entry.count < LOGIN_MAX_FAILURES) return 0
  return Math.ceil((entry.resetAt - now) / 1000)
}

function recordFailure(ip: string, now: number): void {
  const entry = loginFailures.get(ip)
  if (!entry || entry.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return
  }
  entry.count += 1
}

function isSecureRequest(req: Request): boolean {
  return req.secure || req.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
}

export function createAuthRouter(deps: AuthDeps = defaultAuthDeps()): Router {
  const router = Router()

  // 免鉴权：前端启动先探测模式，据此决定登录/401 行为
  router.get('/auth-mode', (_req, res) => {
    res.json({ authMode: deps.mode })
  })

  // sso：自带账号接口一律 404（不解析 cookie/JWT，也不做 OIDC 跳转）
  if (deps.mode === 'sso') {
    const notFound = (_req: Request, res: Response): void => {
      res.status(404).json({ ok: false, error: '接口不存在' })
    }
    router.post('/auth/login', notFound)
    router.post('/auth/logout', notFound)
    router.get('/auth/me', notFound)
    return router
  }

  router.post('/auth/login', (req, res) => {
    const ip = clientIp(req)
    const now = Date.now()
    const wait = blockedSeconds(ip, now)
    if (wait > 0) {
      res.status(429).json({ ok: false, error: '尝试过于频繁，请稍后再试', retryAfter: wait })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username || !password || !deps.accounts.verifyPassword(username, password)) {
      recordFailure(ip, now)
      res.status(401).json({ ok: false, error: '账号或密码错误' })
      return
    }

    loginFailures.delete(ip)
    const token = deps.accounts.createSession(username)
    res.cookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureRequest(req),
      maxAge: config.sessionTtlMs,
    })
    res.json({ ok: true, user: { name: username } })
  })

  router.post('/auth/logout', (req, res) => {
    const token = readSessionToken(req)
    if (token) deps.accounts.destroySession(token)
    res.clearCookie(SESSION_COOKIE, { path: '/' })
    res.json({ ok: true })
  })

  router.get('/auth/me', (req, res) => {
    const token = readSessionToken(req)
    const user = token ? deps.accounts.verifySession(token) : null
    if (!user) {
      res.status(401).json({ ok: false, error: '未登录' })
      return
    }
    res.json({ ok: true, name: user })
  })

  return router
}
