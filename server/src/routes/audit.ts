import { Router, type Response } from 'express'
import { ZodError } from 'zod'
import type { MonitoringRepo } from '../db/monitoringRepo.js'
import { HttpError } from '../services/linkService.js'

// /api/audit 路由（TASK-monitoring.md C §3）：后台操作审计分页查询。
// 统一响应 { ok, data:{rows,total,limit,offset} }。

function sendError(res: Response, e: unknown): void {
  if (e instanceof HttpError) {
    res.status(e.status).json({ ok: false, error: e.message })
    return
  }
  if (e instanceof ZodError) {
    res.status(400).json({ ok: false, error: '参数非法', issues: e.issues })
    return
  }
  res.status(500).json({ ok: false, error: (e as Error)?.message ?? String(e) })
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function createAuditRouter(monitor: MonitoringRepo): Router {
  const router = Router()

  router.get('/', (req, res) => {
    try {
      const q = req.query
      const limit = clampInt(q.limit, 50, 1, 200)
      const offset = Math.max(0, clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER))
      const from = q.from === undefined ? undefined : clampInt(q.from, 0, 0, Number.MAX_SAFE_INTEGER)
      const to = q.to === undefined ? undefined : clampInt(q.to, 0, 0, Number.MAX_SAFE_INTEGER)
      const page = monitor.listAudit({ from, to, limit, offset })
      res.json({ ok: true, data: { rows: page.rows, total: page.total, limit, offset } })
    } catch (e) {
      sendError(res, e)
    }
  })

  return router
}
