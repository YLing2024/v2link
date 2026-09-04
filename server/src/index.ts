import { config } from './config.js'
import { getDb, closeDb } from './db/connection.js'
import { initSchema } from './db/init.js'
import { createLinksRepo } from './db/linksRepo.js'
import { createApp } from './app.js'
import { xrayClient } from './services/xrayClient.js'
import { createLinkService } from './services/linkService.js'
import { Scheduler } from './services/scheduler.js'

// 入口：config → DB schema → repo/service → scheduler → app/listen
// 后台调度器（15s 过期扫描 + 30s 流量账本）在 listen 成功后 start（首拉预热见 Scheduler 类头）。

const db = getDb()
initSchema(db)
const repo = createLinksRepo(db)
const service = createLinkService({
  db,
  repo,
  xray: xrayClient,
  limits: {
    defaultHours: config.defaultHours,
    maxHours: config.maxHours,
  },
})

const scheduler = new Scheduler({
  db,
  repo,
  xray: xrayClient,
  expireIntervalMs: config.expireScanIntervalMs,
  ledgerIntervalMs: config.ledgerIntervalMs,
})

const app = createApp(service)
const server = app.listen(config.port, config.host, () => {
  console.log(`v2link 控制面已启动: http://${config.host}:${config.port}`)
  console.log(
    `xray api: ${config.xrayApi} (tag=${config.inboundTag}, 超时 ${config.xrayTimeoutMs}ms, 重试 ${config.xrayRetries})`,
  )
  console.log(
    `定时器: 过期扫描 ${config.expireScanIntervalMs}ms / 流量账本 ${config.ledgerIntervalMs}ms`,
  )
  void scheduler.start()
})

// 优雅退出：停调度 → 关 server → 关 DB
function shutdown(signal: string): void {
  console.log(`收到 ${signal}, 正在退出...`)
  scheduler.stop()
  server.close(() => {
    closeDb()
    process.exit(0)
  })
  setTimeout(() => {
    closeDb()
    process.exit(0)
  }, 3000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
