import { Router } from 'express'

// 健康检查（无鉴权，systemd/nacos 探活用）。只报告进程存活；不做 DB/xray 往返探测
// （避免探活本身产生 xray 调用开销/误报）。
export function createHealthRouter(): Router {
  const router = Router()
  router.get('/', (_req, res) => {
    res.json({
      ok: true,
      data: { status: 'ok', now: Date.now(), uptime: Math.floor(process.uptime()) },
    })
  })
  return router
}
