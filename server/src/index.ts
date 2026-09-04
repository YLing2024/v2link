import { config } from './config.js'
import { parseRegionProbes } from './config.js'
import { getDb, closeDb } from './db/connection.js'
import { initSchema } from './db/init.js'
import { createLinksRepo } from './db/linksRepo.js'
import { createMonitoringRepo } from './db/monitoringRepo.js'
import { createApp } from './app.js'
import { xrayClient } from './services/xrayClient.js'
import { createLinkService } from './services/linkService.js'
import { Scheduler } from './services/scheduler.js'
import { createRegionProbeService } from './services/regionProbe.js'
import { AccessLogTailer } from './lib/accessLogTailer.js'

// 入口：config → DB schema → repo/service → scheduler → tailer → app/listen
// 后台任务在 listen 成功后 start（首拉预热见 Scheduler 类头；tailer 基线见类头）。

const db = getDb()
initSchema(db)
const repo = createLinksRepo(db)
const monitor = createMonitoringRepo(db)
const service = createLinkService({
  db,
  repo,
  monitor,
  xray: xrayClient,
  limits: {
    defaultHours: config.defaultHours,
    maxHours: config.maxHours,
  },
})

// 地区连通性监控（TASK-extend-regions.md 需求 2）：端点来自配置（默认内置 / REGION_PROBES 覆盖）
const regionProbe = createRegionProbeService({ probes: parseRegionProbes(config.regionProbes) })

const scheduler = new Scheduler({
  db,
  repo,
  monitor,
  xray: xrayClient,
  regionProbe,
  regionProbeIntervalMs: config.regionProbeIntervalMs,
  expireIntervalMs: config.expireScanIntervalMs,
  ledgerIntervalMs: config.ledgerIntervalMs,
  connCleanupIntervalMs: config.connCleanupIntervalMs,
  sampleCleanupIntervalMs: config.sampleCleanupIntervalMs,
  connRetentionMs: config.connRetentionMs,
  sampleRetentionMs: config.sampleRetentionMs,
})

// access log 采集器：email → links.id 关联；落库攒批在 tailer 内部做（一事务 100 行）
const tailer = new AccessLogTailer({
  path: config.accessLogPath,
  intervalMs: 2000,
  resolveLinkId: (email) => {
    const row = repo.byId(email) ?? repo.findActiveByEmail(email)
    return row ? row.id : null
  },
  sink: (rows) => monitor.insertConnections(rows),
})

const app = createApp(service, monitor, regionProbe)
const server = app.listen(config.port, config.host, () => {
  console.log(`v2link 控制面已启动: http://${config.host}:${config.port}`)
  console.log(
    `xray api: ${config.xrayApi} (tag=${config.inboundTag}, 超时 ${config.xrayTimeoutMs}ms, 重试 ${config.xrayRetries})`,
  )
  console.log(
    `定时器: 过期扫描 ${config.expireScanIntervalMs}ms / 流量账本 ${config.ledgerIntervalMs}ms` +
      ` / 连接清理 ${config.connCleanupIntervalMs}ms / 采样清理 ${config.sampleCleanupIntervalMs}ms` +
      ` / 地区探测 ${config.regionProbeIntervalMs}ms`,
  )
  console.log(`access log 采集: ${config.accessLogPath}（保留 ${config.connRetentionMs}ms 内）`)
  void scheduler.start()
  tailer.start()
})

// 优雅退出：停调度 → 停 tailer → 关 server → 关 DB
function shutdown(signal: string): void {
  console.log(`收到 ${signal}, 正在退出...`)
  scheduler.stop()
  tailer.stop()
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
