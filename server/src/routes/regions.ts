import { Router, type Response } from 'express'
import { ZodError } from 'zod'
import type { RegionProbeService } from '../services/regionProbe.js'

// /api/regions/probes 路由（TASK-extend-regions.md 需求 2）：地区连通性快照 + 最近几轮历史。
// 经 /api SSO 鉴权（与 links/audit 一致，见 app.ts）。
// 响应 { ok, data: { updatedAt, probes:[{key,flag,name,ok,rttMs,error,ts}], history:[rounds] } }。
// 数据来自 RegionProbeService 内存快照，不落库、无分页（量小：~4 地区 × 12 轮）。

function sendError(res: Response, e: unknown): void {
  if (e instanceof ZodError) {
    res.status(400).json({ ok: false, error: '参数非法', issues: e.issues })
    return
  }
  res.status(500).json({ ok: false, error: (e as Error)?.message ?? String(e) })
}

export function createRegionsRouter(probe: RegionProbeService): Router {
  const router = Router()

  router.get('/probes', (_req, res) => {
    try {
      const { updatedAt, probes } = probe.snapshot()
      res.json({ ok: true, data: { updatedAt, probes, history: probe.history() } })
    } catch (e) {
      sendError(res, e)
    }
  })

  return router
}
