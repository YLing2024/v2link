import type { NextFunction, Request, Response } from 'express'

// 业务侧唯一鉴权：用户身份由 Auth Gateway 注入请求头 `X-Auth-User`
// （网关会先剥掉客户端伪造的同名头，见 NEW-AUTH-CONVENTION）。
// 头缺失或为空 → 401，不 302、不 500。
// 健康检查 /api/healthz 不经本中间件（无鉴权，systemd/探活用）。
// 公开路径 /、/v2ws 不经过本中间件：只有 /api/* 需要登录。

// 网关注入头：仅信任该头名。
export const AUTH_USER_HEADER = 'x-auth-user'

export function createAuthMiddleware() {
  return function authRequired(req: Request, res: Response, next: NextFunction): void {
    const xUser = req.get(AUTH_USER_HEADER)
    if (xUser && xUser.trim()) {
      req.authUser = xUser.trim()
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
