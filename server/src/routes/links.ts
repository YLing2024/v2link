import { Router, type Response } from 'express'
import { ZodError } from 'zod'
import type { LinkService } from '../services/linkService.js'
import { HttpError } from '../services/linkService.js'

// /api/links 路由（REST，见 REQUIREMENTS.md §5）。统一响应 { ok, data } / { ok, error }。
// 入参用 zod 做信封校验 + 边界预筛；业务规则（状态机、与数据面一致性）在 linkService。

// 统一错误出口：HttpError(带 status) / zod 校验失败(400) / 兜底 500
function sendError(res: Response, e: unknown): void {
  if (e instanceof HttpError) {
    res.status(e.status).json({ ok: false, error: e.message })
    return
  }
  if (e instanceof ZodError) {
    res.status(400).json({ ok: false, error: '参数非法', issues: e.issues })
    return
  }
  const msg = (e as Error)?.message ?? String(e)
  res.status(500).json({ ok: false, error: msg })
}

export function createLinksRouter(service: LinkService): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.json({ ok: true, data: service.list() })
  })

  router.post('/', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const note = typeof body.note === 'string' ? body.note : ''
      const hours = body.hours === undefined ? undefined : Number(body.hours)
      // 手工边界预筛（zod 的错误结构与此处 ApiError 语义不同，统一走 service 校验更可测）
      const link = await service.create({ note, hours })
      res.status(201).json({ ok: true, data: link })
    } catch (e) {
      sendError(res, e)
    }
  })

  router.post('/:id/revoke', async (req, res) => {
    try {
      const link = await service.revoke(req.params.id)
      res.json({ ok: true, data: link })
    } catch (e) {
      sendError(res, e)
    }
  })

  router.post('/:id/extend', async (req, res) => {
    try {
      const hours = Number((req.body as Record<string, unknown>)?.hours)
      const link = await service.extend(req.params.id, hours)
      res.json({ ok: true, data: link })
    } catch (e) {
      sendError(res, e)
    }
  })

  return router
}
