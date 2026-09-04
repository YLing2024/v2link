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
  DEFAULT_SPEED: z.coerce.number().int().min(0).default(10),
  MAX_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(720),
  MAX_SPEED: z.coerce.number().int().min(1).default(100),
  EXPIRE_SCAN_INTERVAL_S: z.coerce.number().int().min(3).max(3600).default(15),
  LEDGER_INTERVAL_S: z.coerce.number().int().min(5).max(3600).default(30),
  AUTH_CENTER_VERIFY_URL: z
    .string()
    .trim()
    .url()
    .default('http://127.0.0.1:8080/api/verify'),
  DB_PATH: z.string().trim().optional(),
  ENABLE_DEV_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : '')),
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
    defaultSpeed: p.DEFAULT_SPEED,
    maxHours: p.MAX_HOURS,
    maxSpeed: p.MAX_SPEED,
    expireScanIntervalMs: p.EXPIRE_SCAN_INTERVAL_S * 1000,
    ledgerIntervalMs: p.LEDGER_INTERVAL_S * 1000,
    authVerifyUrl: p.AUTH_CENTER_VERIFY_URL,
    dbPath,
    devToken: p.ENABLE_DEV_TOKEN,
    serverRoot,
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
  defaultSpeed: number
  maxHours: number
  maxSpeed: number
  expireScanIntervalMs: number
  ledgerIntervalMs: number
  authVerifyUrl: string
  dbPath: string
  /** 本地无 nginx 直连调试令牌（空 = 关闭）。生产由 nginx 探针注入 X-Auth-User。 */
  devToken: string
  serverRoot: string
}

// 全局单例：进程启动时解析一次（测试请用 loadConfig 注入自定义 env，勿依赖本单例）
export const config: Config = loadConfig()

export function ensureDbDir(dbPath: string = config.dbPath): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
}
