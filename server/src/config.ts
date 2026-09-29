import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import dotenv from 'dotenv'

// 环境变量读取 + 校验。真实 .env 已 gitignore，仓库只提交 .env.example（占位值）。

// 加载 server/.env（存在时）。tsx/dev 由 workdir 决定 CWD；dist 启动时需保证
// CWD=server（根 README 部署命令已约定 npm --prefix server start）。此处显式以
// 本文件位置推导 server 目录，兜底相对 CWD 找 .env。
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const serverRoot =
  // src/ 下运行时（tsx: …/server/src/config.ts）或 dist/ 下运行时（…/server/dist/config.js）
  // 本文件固定位于 <serverRoot>/src 或 <serverRoot>/dist 两层。
  fs.existsSync(path.resolve(moduleDir, '..', '.env'))
    ? path.resolve(moduleDir, '..')
    : path.resolve(moduleDir, '..', '..')
dotenv.config({ path: path.join(serverRoot, '.env'), quiet: true })

// ---- schema：全部有默认值，缺省不炸 ----
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(7897),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  XRAY_API: z.string().trim().default('127.0.0.1:8081'),
  XRAY_BIN: z.string().trim().default('xray'),
  XRAY_INBOUND_TAG: z.string().trim().default('vless-in'),
  XRAY_API_TIMEOUT_S: z.coerce.number().int().min(1).max(30).default(3),
  XRAY_API_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  DEFAULT_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
  MAX_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(720),
  EXPIRE_SCAN_INTERVAL_S: z.coerce.number().int().min(3).max(3600).default(15),
  LEDGER_INTERVAL_S: z.coerce.number().int().min(5).max(3600).default(30),
  ACCESS_LOG_PATH: z.string().trim().default('/var/log/xray/access.log'),
  CONN_CLEANUP_INTERVAL_S: z.coerce.number().int().min(60).max(3600 * 24).default(3600),
  CONN_RETENTION_S: z.coerce.number().int().min(3600).max(3600 * 24 * 30).default(3600 * 24 * 7),
  SAMPLE_CLEANUP_INTERVAL_S: z.coerce.number().int().min(60).max(3600 * 24).default(3600 * 24),
  SAMPLE_RETENTION_S: z.coerce.number().int().min(3600).max(3600 * 24 * 365).default(3600 * 24 * 30),
  // 地区连通性探测（地区连通性监控）：端点列表 JSON（见 REGION_PROBES 常量）。
  // 留空 = 用内置默认列表；探测失败不致命（状态条标红即可）。
  REGION_PROBES: z.string().trim().optional(),
  // 探测周期（秒，默认 300 = 每 5 分钟一轮）
  REGION_PROBE_INTERVAL_S: z.coerce.number().int().min(60).max(3600).default(300),
  DB_PATH: z.string().trim().optional(),
  // ---- 管理端认证模式 ----
  //   builtin（默认）：自带账号 + 会话；sso：关掉自带口令，身份只看 X-Auth-User。
  //   未设置 / 取值非法 → 一律按 builtin（catch 兜底）。
  AUTH_MODE: z.enum(['builtin', 'sso']).catch('builtin').default('builtin'),
  // 首次启动（users 为空）创建的管理员用户名；已有用户时不覆盖口令。
  V2LINK_ADMIN_USER: z.string().trim().min(1).default('admin'),
  // 初始管理员口令；未设置则随机 16 位并在首次启动时 stdout 打印一次。
  V2LINK_ADMIN_PASSWORD: z.string().optional(),
  // 会话 TTL（小时，默认 12；命中滑动续期）。
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  // 反代信任范围（Express trust proxy）。默认 loopback：只信本机反代（nginx 在本机时
  // req.ip 才是真实访客 IP；否则登录限速会把所有访客算成同一个 IP，一人失败十次锁死全体）。
  // 'false' = 不信任任何转发头；'true' = 信任全部（仅当服务不直接对外时使用）。
  TRUST_PROXY: z.string().trim().default('loopback'),
})

// 数据目录/库文件定位：
//   DB_PATH 显式给出 → 直接使用；
//   否则默认 <仓库 server 目录>/data/v2link.db（server/data，data/ 整目录 gitignore）。
function resolveDbPath(raw: string | undefined): string {
  if (raw) return path.resolve(process.cwd(), raw)
  return path.join(serverRoot, 'data', 'v2link.db')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const p = envSchema.parse(env)
  const dbPath = resolveDbPath(p.DB_PATH)
  return {
    port: p.PORT,
    host: p.HOST,
    xrayApi: p.XRAY_API,
    xrayBin: p.XRAY_BIN,
    inboundTag: p.XRAY_INBOUND_TAG,
    xrayTimeoutMs: p.XRAY_API_TIMEOUT_S * 1000,
    xrayRetries: p.XRAY_API_RETRIES,
    defaultHours: p.DEFAULT_HOURS,
    maxHours: p.MAX_HOURS,
    expireScanIntervalMs: p.EXPIRE_SCAN_INTERVAL_S * 1000,
    ledgerIntervalMs: p.LEDGER_INTERVAL_S * 1000,
    accessLogPath: p.ACCESS_LOG_PATH,
    connCleanupIntervalMs: p.CONN_CLEANUP_INTERVAL_S * 1000,
    connRetentionMs: p.CONN_RETENTION_S * 1000,
    sampleCleanupIntervalMs: p.SAMPLE_CLEANUP_INTERVAL_S * 1000,
    sampleRetentionMs: p.SAMPLE_RETENTION_S * 1000,
    dbPath,
    serverRoot,
    regionProbes: p.REGION_PROBES,
    regionProbeIntervalMs: p.REGION_PROBE_INTERVAL_S * 1000,
    authMode: p.AUTH_MODE,
    adminUser: p.V2LINK_ADMIN_USER,
    adminPassword: p.V2LINK_ADMIN_PASSWORD,
    sessionTtlMs: p.SESSION_TTL_HOURS * 3600 * 1000,
    trustProxy: parseTrustProxy(p.TRUST_PROXY),
  }
}

// trust proxy 取值解析：Express 接受 boolean / number / string（预设名或子网列表）。
function parseTrustProxy(raw: string): boolean | number | string {
  const v = raw.trim().toLowerCase()
  if (v === 'false' || v === '0' || v === 'off') return false
  if (v === 'true' || v === '1' || v === 'on') return true
  if (/^\d+$/.test(v)) return Number(v)
  return v || 'loopback'
}

// 地区连通性探测默认端点（服务器直连各地区知名稳定 HTTPS 端点，HTTP(S) 测 RTT）。
//   US: gstatic generate_204（Google 全球 anycast，实测就近美国；204 快速端点）
//   EU: bbc.com（英国 BBC 首页，欧洲稳定长连接端点）
//   JP: yahoo.co.jp 首页（日本本土稳定端点，y 首字母 keep-alive 快）
//   SG: cloudflare.com（亚太 anycast，新加坡通常就近可达；同域用于亚太基准）
// 私有地址零硬编码：端点一律走 HTTPS 公网域名，杜绝把机房/用户地址写入仓库。
// 可在 .env 用 REGION_PROBES 覆盖（JSON: [{key,name,flag,url}]；key 为唯一标识）。
export const REGION_PROBES: { key: string; name: string; flag: string; url: string }[] = [
  { key: 'us', name: '美国', flag: '🇺🇸', url: 'https://www.gstatic.com/generate_204' },
  { key: 'eu', name: '欧洲', flag: '🇪🇺', url: 'https://www.bbc.com/' },
  { key: 'jp', name: '日本', flag: '🇯🇵', url: 'https://www.yahoo.co.jp/' },
  { key: 'sg', name: '新加坡', flag: '🇸🇬', url: 'https://www.cloudflare.com/' },
]

/** 解析 REGION_PROBES env（JSON）。格式非法 → 忽略并回落内置列表（探测是增强功能，不因配错炸服务）。 */
export function parseRegionProbes(raw: string | undefined): typeof REGION_PROBES {
  if (!raw || !raw.trim()) return REGION_PROBES
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr) || arr.length === 0) return REGION_PROBES
    const out: typeof REGION_PROBES = []
    for (const item of arr) {
      const r = item as { key?: unknown; name?: unknown; flag?: unknown; url?: unknown }
      if (
        typeof r.key === 'string' &&
        r.key.trim() &&
        typeof r.name === 'string' &&
        r.name.trim() &&
        typeof r.url === 'string' &&
        r.url.startsWith('https://')
      ) {
        out.push({
          key: r.key.trim(),
          name: r.name.trim(),
          flag: typeof r.flag === 'string' ? r.flag : '',
          url: r.url,
        })
      }
    }
    return out.length ? out : REGION_PROBES
  } catch {
    return REGION_PROBES
  }
}

export interface Config {
  port: number
  host: string
  xrayApi: string
  xrayBin: string
  inboundTag: string
  xrayTimeoutMs: number
  xrayRetries: number
  defaultHours: number
  maxHours: number
  expireScanIntervalMs: number
  ledgerIntervalMs: number
  /** xray access log 文件路径（log.access，logrotate copytruncate 管理） */
  accessLogPath: string
  /** connections 过期清理周期（默认 1h） */
  connCleanupIntervalMs: number
  /** connections 保留时长（默认 7 天滚动） */
  connRetentionMs: number
  /** traffic_samples 过期清理周期（默认 1 天） */
  sampleCleanupIntervalMs: number
  /** traffic_samples 保留时长（默认 30 天） */
  sampleRetentionMs: number
  dbPath: string
  serverRoot: string
  /** 地区连通性探测端点（.env REGION_PROBES 可覆盖；默认见 REGION_PROBES 常量） */
  regionProbes: string | undefined
  /** 探测周期（默认 300s = 每 5 分钟一轮） */
  regionProbeIntervalMs: number
  /** 认证模式：builtin（自带账号，默认）/ sso（身份只看 X-Auth-User） */
  authMode: AuthMode
  /** 首次启动创建的管理员用户名 */
  adminUser: string
  /** 管理员初始口令（未设置则随机生成并打印一次） */
  adminPassword: string | undefined
  /** 会话 TTL（毫秒，命中滑动续期） */
  sessionTtlMs: number
  /** Express trust proxy 取值（见 envSchema.TRUST_PROXY 注释） */
  trustProxy: boolean | number | string
}

/** 管理端认证模式：builtin = 自带账号会话；sso = 只认 X-Auth-User（前置认证层） */
export type AuthMode = 'builtin' | 'sso'

// 全局单例：进程启动时解析一次（测试请用 loadConfig 注入自定义 env，勿依赖本单例）
export const config: Config = loadConfig()

export function ensureDbDir(dbPath: string = config.dbPath): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
}
