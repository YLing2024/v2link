import { Router } from 'express'
import type { XrayReconcileStatus } from '../services/reconcile.js'

// 健康检查（无鉴权，systemd/nacos 探活用）。只报告进程存活；不做 DB/xray 往返探测
// （避免探活本身产生 xray 调用开销/误报）。
// 数据面状态（需求文档 R4）取自 ReconcileService 的内存快照，同样零往返。

/** 健康检查所需的最小数据面快照接口（便于测试注入，不依赖具体类） */
export interface XrayStatusProvider {
  snapshot(): XrayReconcileStatus
}

export function createHealthRouter(xray?: XrayStatusProvider): Router {
  const router = Router()
  router.get('/', (_req, res) => {
    const data: Record<string, unknown> = {
      status: 'ok',
      now: Date.now(),
      uptime: Math.floor(process.uptime()),
    }
    // 未接数据面（如单测直接挂本路由）时不加该字段，保持既有响应形态
    if (xray) data.xray = xray.snapshot()
    res.json({ ok: true, data })
  })
  return router
}
