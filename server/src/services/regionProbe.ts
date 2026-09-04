import { REGION_PROBES } from '../config.js'

// 地区连通性监控（TASK-extend-regions.md 需求 2）：
//   · 服务器**直连**各主流地区知名 HTTPS 端点（无代理）测 RTT，HTTP(S) 探测（非 ICMP）
//   · 结果**只存内存**（最新快照 + 最近 N 轮历史），不落库（实时状态即可）
//   · scheduler 每 5min 触发一轮 runRound()；服务启动后首轮立即跑（见 Scheduler.start）
//
// 单次探测语义：GET 直连目标，带 5s 超时；拿到响应头即记录 RTT（随即中止 body 下载，
// 避免大头页面拖慢/浪费带宽；204/200 类端点优先）。res.ok（2xx/3xx）= ok=true。

export interface RegionProbeSpec {
  key: string
  name: string
  flag: string
  url: string
}

export interface RegionResult {
  key: string
  ok: boolean
  /** 首包/响应头往返延迟（ms）；失败为 null */
  rttMs: number | null
  /** 失败原因（timeout / DNS / 连接被拒 / HTTP 状态等）；成功为 null */
  error: string | null
  ts: number
}

export interface RegionRound {
  ts: number
  results: RegionResult[]
}

export interface RegionProbeDeps {
  /** 探测端点（按需注入；默认 REGION_PROBES） */
  probes?: RegionProbeSpec[]
  /** 单次探测超时（默认 5000ms） */
  timeoutMs?: number
  /** fetch 注入（测试用 mock）；默认全局 fetch */
  fetchFn?: typeof fetch
  /** 内存保留轮数（默认 12） */
  maxRounds?: number
  now?: () => number
  logger?: (msg: string, meta?: Record<string, unknown>) => void
}

export class RegionProbeService {
  private readonly probes: RegionProbeSpec[]
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void
  /** 最近 N 轮（newest first；默认 12 轮） */
  private readonly maxRounds: number
  private rounds: RegionRound[] = []
  /** 进行中的一轮（防重入：并发调用复用同一轮，避免叠加探测） */
  private inFlight: Promise<RegionRound> | null = null

  constructor(deps: RegionProbeDeps = {}) {
    this.probes = deps.probes ?? REGION_PROBES
    this.timeoutMs = deps.timeoutMs ?? 5000
    this.fetchFn = deps.fetchFn ?? fetch
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.logger ?? ((msg) => console.log(`[region-probe] ${msg}`))
    this.maxRounds = deps.maxRounds ?? 12
  }

  /** 当前最新快照（每地区最近一次结果；从未跑过 → updatedAt=0、空列表）。
   *  结果带端点元信息（flag/name），前端直接渲染，无需另行对照配置。 */
  snapshot(): { updatedAt: number; probes: (RegionResult & { flag: string; name: string })[] } {
    const latest = this.rounds[0]
    if (!latest) return { updatedAt: 0, probes: [] }
    // 与端点配置同序返回（含本轮缺失地区以未跑过占位，避免前端错位）
    const byKey = new Map(latest.results.map((r) => [r.key, r]))
    const probes = this.probes.map((p) => {
      const hit = byKey.get(p.key)
      const base: RegionResult =
        hit ?? { key: p.key, ok: false, rttMs: null, error: '尚未探测', ts: latest.ts }
      return { ...base, flag: p.flag, name: p.name }
    })
    return { updatedAt: latest.ts, probes }
  }

  /** 最近 N 轮历史（newest first；最多 maxRounds 轮） */
  history(): RegionRound[] {
    return this.rounds
  }

  /** 探测一轮（并发测全部地区，单次 5s 超时 → 一轮最坏 ~5s）。失败单个地区不抛。
   *  防重入：已有进行中的一轮时直接返回该轮结果（scheduler 定时与手动重叠时不会叠加探测）。 */
  runRound(): Promise<RegionRound> {
    if (this.inFlight) return this.inFlight
    const p = this.doTick().finally(() => {
      if (this.inFlight === p) this.inFlight = null
    })
    this.inFlight = p
    return p
  }

  private async doTick(): Promise<RegionRound> {
    const ts = this.now()
    const settled = await Promise.allSettled(this.probes.map((p) => this.probeOne(p, ts)))
    const results: RegionResult[] = settled.map((s, i) =>
      s.status === 'fulfilled' ? s.value : { key: this.probes[i]!.key, ok: false, rttMs: null, error: '探测异常', ts },
    )
    const round: RegionRound = { ts, results }
    this.rounds = [round, ...this.rounds].slice(0, this.maxRounds)
    const okCount = results.filter((r) => r.ok).length
    this.log(`探测完成 ${okCount}/${results.length}`, {
      ts,
      detail: results.map((r) => `${r.key}:${r.ok ? r.rttMs + 'ms' : (r.error ?? 'err')}`).join(', '),
    })
    return round
  }

  private async probeOne(p: RegionProbeSpec, ts: number): Promise<RegionResult> {
    const started = this.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      // GET + 收到响应头即记录 RTT（res 决议即头已到），随即 abort 跳过 body
      const res = await this.fetchFn(p.url, { signal: controller.signal, redirect: 'follow' })
      const rttMs = this.now() - started
      if (res.ok) {
        return { key: p.key, ok: true, rttMs, error: null, ts }
      }
      return { key: p.key, ok: false, rttMs, error: `HTTP ${res.status}`, ts }
    } catch (e) {
      const err = e as Error
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError'
      return { key: p.key, ok: false, rttMs: null, error: isTimeout ? 'timeout' : (err.message || 'error'), ts }
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
}

/** 构造（探测列表通常来自 config.parseRegionProbes；测试直接注入 probes） */
export function createRegionProbeService(deps: RegionProbeDeps = {}): RegionProbeService {
  return new RegionProbeService(deps)
}
