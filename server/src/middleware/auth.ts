import type { NextFunction, Request, Response } from 'express'

// SSO 探针鉴权（对齐 admin-server authRequired + homepage.conf auth-check 设计）：
//   主鉴权 —— 信任 nginx auth_request 探针注入的 X-Auth-User 头（认证中心已验，内网可信）。
//   独立验 token —— 当 X-Auth-User 缺失时（如绕过 nginx 直连 7897），
//     后端自行调认证中心 /api/verify?token=xxx 校验（Bearer 或 ?token=）。
// 两层配置由部署方决定：生产 = 探针注入 X-Auth-User；直连调试 = 仅独立验 token。
// 健康检查 /api/healthz 不经本中间件（无鉴权，systemd/探活用）。

export interface AuthConfig {
  /** 认证中心验 token 地址（独立验证用） */
  verifyUrl: string
  /** 开发直连令牌：设为非空时额外接受 Authorization: Bearer <devToken>（直连 nginx 场景）。
   *  生产置空（由探针兜底）。见 server/.env.example ENABLE_DEV_TOKEN 说明。 */
  devToken: string
}

// 内网探针注入头：仅信任该头名（nginx auth_request_set 写入），
// 外部直接请求伪造本头不可达（除非本服务对外裸奔——生产禁止）。
export const AUTH_USER_HEADER = 'x-auth-user'

export function createAuthMiddleware(cfg: AuthConfig) {
  return async function authRequired(req: Request, res: Response, next: NextFunction): Promise<void> {
    // ① 探针注入头
    const xUser = req.get(AUTH_USER_HEADER)
    if (xUser && xUser.trim()) {
      req.authUser = xUser.trim()
      return next()
    }
    // ② 独立验证：Bearer 或 ?token=
    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : ''
    const token = bearer || queryToken
    if (token) {
      if (cfg.devToken && token === cfg.devToken) {
        req.authUser = 'dev'
        return next()
      }
      try {
        const ok = await verifyAgainstAuthCenter(cfg.verifyUrl, token)
        if (ok) {
          req.authUser = 'sso'
          return next()
        }
      } catch (e) {
        res.status(502).json({ error: `认证中心不可达: ${(e as Error).message}` })
        return
      }
      res.status(401).json({ error: '未登录或登录已过期' })
      return
    }
    res.status(401).json({ error: '未登录' })
  }
}

async function verifyAgainstAuthCenter(verifyUrl: string, token: string): Promise<boolean> {
  const sep = verifyUrl.includes('?') ? '&' : '?'
  const url = `${verifyUrl}${sep}token=${encodeURIComponent(token)}`
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
  return res.ok
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: string
    }
  }
}
