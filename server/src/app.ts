import fs from 'node:fs'
import path from 'node:path'
import express, { type Express } from 'express'
import { config } from './config.js'
import { createAuthMiddleware } from './middleware/auth.js'
import { createLinksRouter } from './routes/links.js'
import { createAuditRouter } from './routes/audit.js'
import { createHealthRouter } from './routes/health.js'
import { createRegionsRouter } from './routes/regions.js'
import type { MonitoringRepo } from './db/monitoringRepo.js'
import type { LinkService } from './services/linkService.js'
import type { RegionProbeService } from './services/regionProbe.js'

// Express app 组装：JSON 解析 → 静态托管 → /api/healthz（无鉴权）→ /api（探针鉴权）。
// 生产拓扑：nginx 把 /api/* 走 auth-check 探针后反代到本服务并注入 X-Auth-User；
// 本服务自身 auth 中间件做第二道防线（见 middleware/auth.ts）。
// 静态资源：前端 build 产物（npm run build -w frontend → server/../frontend/dist），
// 生产由本服务 express.static 托管（QuotaHub/需求 §7.5 模式）。

function resolveFrontendDist(): string | null {
  // 相对本文件（dist/app.js 或 src/app.ts）向上两层 = server/；兄弟目录 frontend/dist
  const serverRoot = config.serverRoot
  const candidates = [
    path.join(serverRoot, '..', 'frontend', 'dist'),
    path.join(process.cwd(), 'frontend', 'dist'),
    path.join(process.cwd(), '..', 'frontend', 'dist'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir
  }
  return null
}

export function createApp(service: LinkService, monitor: MonitoringRepo, probe?: RegionProbeService): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '64kb' }))

  // 健康检查放最前（无鉴权）
  app.use('/api/healthz', createHealthRouter())

  // 业务 API：SSO 探针鉴权
  app.use(
    '/api',
    createAuthMiddleware({ verifyUrl: config.authVerifyUrl, devToken: config.devToken }),
    (req, res, next) => {
      // 路由装配在闭包内，req 上记录当前用户（供审计扩展预留）
      void req.authUser
      next()
    },
  )
  app.use('/api/links', createLinksRouter(service, monitor))
  app.use('/api/audit', createAuditRouter(monitor))
  // 地区连通性探测（TASK-extend-regions.md 需求 2；regionProbe 缺省时 404 兜底）
  if (probe) app.use('/api/regions', createRegionsRouter(probe))

  // 静态托管（带 SPA 回退；assets 走一年缓存，html 不缓存）
  const staticDir = resolveFrontendDist()
  if (staticDir) {
    app.use(
      express.static(staticDir, {
        index: 'index.html',
        setHeaders(res, filePath) {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache')
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          }
        },
      }),
    )
    // SPA 回退（非 /api 路径）
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'))
    })
  }

  // 404 兜底（无静态目录时也返回 JSON 风格）
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ ok: false, error: `接口不存在: ${req.method} ${req.path}` })
    } else {
      res.status(404).send('Not Found')
    }
  })

  // 统一错误处理
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ ok: false, error: err.message || '服务器内部错误' })
    },
  )

  return app
}
