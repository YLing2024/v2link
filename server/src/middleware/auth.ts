import type { NextFunction, Request, Response } from 'express'
import { config, type AuthMode } from '../config.js'
import { getAccountService, type AccountService } from '../services/accountService.js'

// 业务侧唯一鉴权入口，按 AUTH_MODE 分支：
//   builtin（默认）：自带账号会话。接受 `Authorization: Bearer <token>` 或 cookie `v2link_session`，
//                    会话表命中即通过；**忽略** X-Auth-User（不因外部头提权）。
//   sso：关掉自带口令，身份只认前置认证注入的 `X-Auth-User`（禁止解析 cookie/JWT）。
// 两种模式下头/会话缺失 → 401，不 302、不 500。
// 公开路径 /、/v2ws 与静态前端不经过本中间件；/api/auth-mode 免鉴权（见 routes/auth.ts）。

// 网关注入头：仅 sso 模式信任该头名。
export const AUTH_USER_HEADER = 'x-auth-user'
// 自带会话 cookie 名
export const SESSION_COOKIE = 'v2link_session'

export interface AuthDeps {
  mode: AuthMode
  accounts: AccountService
}

/** 默认依赖：进程单例（生产 / app.ts 缺省路径用；测试请显式注入） */
export function defaultAuthDeps(): AuthDeps {
  return { mode: config.authMode, accounts: getAccountService() }
}

/** 极简 cookie 解析（不引入 cookie-parser）：只取需要的一层，同名取首个 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    if (!key || key in out) continue
    out[key] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

/** 取请求凭证：优先 `Authorization: Bearer <token>`，其次 cookie `v2link_session` */
export function readSessionToken(req: Request): string | null {
  const header = req.get('authorization')
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim())
    const token = m?.[1]?.trim()
    if (token) return token
  }
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  return cookie && cookie.trim() ? cookie.trim() : null
}

export function createAuthMiddleware(deps: AuthDeps = defaultAuthDeps()) {
  return function authRequired(req: Request, res: Response, next: NextFunction): void {
    if (deps.mode === 'sso') {
      const xUser = req.get(AUTH_USER_HEADER)
      if (xUser && xUser.trim()) {
        req.authUser = xUser.trim()
        return next()
      }
      res.status(401).json({ error: '未登录' })
      return
    }

    const token = readSessionToken(req)
    const user = token ? deps.accounts.verifySession(token) : null
    if (user) {
      req.authUser = user
      return next()
    }
    res.status(401).json({ error: '未登录' })
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: string
    }
  }
}
