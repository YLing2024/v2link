import { Router, type Request, type RequestHandler, type Response } from 'express'
import type { ClashService } from '../services/clashService.js'
import { HttpError } from '../services/linkService.js'

// /api/clash 路由：
//   POST /subscriptions          需鉴权（复用业务鉴权中间件），创建临时订阅
//   GET  /subscriptions/:token   免鉴权（token 即凭据；Clash 抓取不带 cookie）
// 本路由整体挂在业务鉴权中间件**之前**；POST 单独带 authRequired，GET 不放鉴权。
// GET 的错误按需求返回**纯文本中文**（不是 JSON、不是 401），并禁用缓存。

export function createClashRouter(service: ClashService, authRequired: RequestHandler): Router {
  const router = Router()

  router.get('/subscriptions/:token', (req: Request, res: Response) => {
    const token = req.params.token
    if (!token) {
      res.status(404).type('text/plain; charset=utf-8').send('订阅不存在')
      return
    }
    try {
      const sub = service.get(token)
      res.setHeader('Content-Type', 'text/yaml; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="v2link.yaml"')
      res.setHeader('Cache-Control', 'no-store')
      if (sub.userinfo) res.setHeader('subscription-userinfo', sub.userinfo)
      res.status(200).send(sub.yaml)
    } catch (e) {
      if (e instanceof HttpError) {
        res.status(e.status).type('text/plain; charset=utf-8').send(e.message)
        return
      }
      res.status(500).type('text/plain; charset=utf-8').send('服务器内部错误')
    }
  })

  router.post('/subscriptions', authRequired, (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const data = service.create(body.linkIds, req.authUser)
      res.status(201).json({ ok: true, data })
    } catch (e) {
      if (e instanceof HttpError) {
        res.status(e.status).json({ ok: false, error: e.message })
        return
      }
      res.status(500).json({ ok: false, error: (e as Error)?.message ?? String(e) })
    }
  })

  return router
}
