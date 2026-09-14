import { Router, type Response } from 'express'
import { ZodError } from 'zod'
import type { LinkService } from '../services/linkService.js'
import { HttpError } from '../services/linkService.js'
import type { MonitoringRepo } from '../db/monitoringRepo.js'
import { aggregateTraffic, toTrafficSeries } from '../lib/trafficAgg.js'

// /api/links 路由（REST，见 REQUIREMENTS.md §5 + TASK-monitoring.md A/B）。
// 统一响应 { ok, data } / { ok, error }；入参用 zod 信封校验 + 边界预筛。
// 追溯两个子资源：
//   GET /:id/traffic?from=&to=&bucket=hour|day → 流量曲线（30s 采样聚合，A 层）
//   GET /:id/connections?from=&to=&q=&limit=&offset= → 连接记录分页（B 层）
// actor 透传：中间件已把认证用户挂到 req.authUser（直连 dev token 场景 = 'dev'）。

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

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 简单分页解析：offset 默认 0；limit 默认 50，上限 200 */
function parsePage(query: Record<string, unknown>): { limit: number; offset: number } {
  return {
    limit: clampInt(query.limit, 50, 1, 200),
    offset: Math.max(0, clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER)),
  }
}

export function createLinksRouter(
  service: LinkService,
  monitor: MonitoringRepo,
): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.json({ ok: true, data: service.list() })
  })

  router.post('/', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const note = typeof body.note === 'string' ? body.note : ''
      const hours = body.hours === undefined ? undefined : Number(body.hours)
      // permanent 只透传原始值，类型/互斥校验在 service（可测）
      const permanent = body.permanent as boolean | undefined
      // 手工边界预筛（zod 的错误结构与此处 ApiError 语义不同，统一走 service 校验更可测）
      const link = await service.create({ note, hours, permanent }, req.authUser)
      res.status(201).json({ ok: true, data: link })
    } catch (e) {
      sendError(res, e)
    }
  })

  router.post('/:id/revoke', async (req, res) => {
    try {
      const link = await service.revoke(req.params.id, req.authUser)
      res.json({ ok: true, data: link })
    } catch (e) {
      sendError(res, e)
    }
  })

  router.post('/:id/extend', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      // 入参收窄：只透传可识别字段（忽略多余键）；未提供即 undefined（服务层判定二选一）
      const hours = body.hours === undefined ? undefined : Number(body.hours)
      const expiresAt = body.expiresAt === undefined ? undefined : Number(body.expiresAt)
      const link = await service.extend(req.params.id, { hours, expiresAt }, req.authUser)
      res.json({ ok: true, data: link })
    } catch (e) {
      sendError(res, e)
    }
  })

  // ---- A. 流量曲线聚合 ----
  router.get('/:id/traffic', (req, res) => {
    try {
      const id = req.params.id
      const q = req.query
      const now = Date.now()
      const bucket = q.bucket === 'day' ? 'day' : 'hour'
      const to = clampInt(q.to, now, 1, Number.MAX_SAFE_INTEGER)
      const from = clampInt(q.from, to - 24 * 3600 * 1000, 1, to)
      const samples = monitor.listSamples({ id, from, to })
      const data = toTrafficSeries(aggregateTraffic(samples, bucket), from, to, bucket)
      res.json({ ok: true, data })
    } catch (e) {
      sendError(res, e)
    }
  })

  // ---- B. 连接记录追溯（分页 + host 前缀搜索）----
  router.get('/:id/connections', (req, res) => {
    try {
      const q = req.query
      const { limit, offset } = parsePage(q)
      const page = monitor.listConnections({
        link_id: req.params.id,
        from: q.from === undefined ? undefined : clampInt(q.from, 0, 0, Number.MAX_SAFE_INTEGER),
        to: q.to === undefined ? undefined : clampInt(q.to, 0, 0, Number.MAX_SAFE_INTEGER),
        hostPrefix: typeof q.q === 'string' && q.q.trim() ? q.q.trim().slice(0, 200) : undefined,
        limit,
        offset,
      })
      res.json({ ok: true, data: { rows: page.rows, total: page.total, limit, offset } })
    } catch (e) {
      sendError(res, e)
    }
  })

  return router
}
