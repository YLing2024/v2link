import type { LinksRepo } from '../db/linksRepo.js'
import { isPermanentExpiry } from '../lib/expiry.js'
import type { LinkRow } from '../types.js'
import type { XrayClient } from './xrayClient.js'

// xray 用户与账本的一致性同步（需求文档 R1-R5）。
//
// 背景：xray 的动态用户只存在进程内存里，xray 一重启（改配置 / 崩溃 / 重启机器）全部丢失，
//   而账本仍显示 active —— 控制面没有任何补偿，导致历史链接静默失效。本服务做「账本 → xray」
//   的单向收敛：账本为权威，xray 为镜像，周期性地把应有效的补回、不应有效的清掉。
//
// 权威与副作用边界（重要）：
//   · 本服务**只读账本、不改账本**。xray 调用失败只记日志，绝不因此改/删链接
//     （否则一次 xray 抖动会误伤账本），下一轮重试即可收敛。
//   · 热管理只走 adu/rmu（不 reload、不断存量连接）。
//
// 幂等与日志洪水：addUser 对「已存在」返回 false（见 xrayClient），只有真正补回才计入动作；
//   rmu 对不存在返回 0。因此稳态每轮无动作、不产日志（R4），只在真正补/清时打一行摘要。

/** 一轮 reconcile 的结果（测试与调用方用） */
export interface ReconcileResult {
  /** 本轮检查的账本行数 */
  checked: number
  /** 实际补回 xray 的链接 id */
  added: string[]
  /** 实际从 xray 清理的链接 id */
  removed: string[]
  /** xray 调用失败（账本未改，下轮重试）的链接 id */
  failures: string[]
}

/** /api/healthz 暴露的数据面快照（内存态，不做 DB/xray 往返） */
export interface XrayReconcileStatus {
  /** 账本中应当有效的链接数（上一轮） */
  activeLinks: number
  /** 上一轮完成时间（epoch ms；0 = 尚未跑过） */
  reconciledAt: number
  /** 上一轮实际补回 / 清理数量 */
  lastFix: { added: number; removed: number }
}

export interface ReconcileDeps {
  repo: Pick<LinksRepo, 'listAll'>
  xray: XrayClient
  logger?: (msg: string, meta?: Record<string, unknown>) => void
  /** 默认系统时钟；测试注入固定值 */
  now?: () => number
}

/** 账本判定「应当有效」：active 且未吊销 且（永久哨兵 或 尚未到期）。 */
export function shouldBeActive(row: LinkRow, now: number): boolean {
  return (
    row.status === 'active' &&
    row.revoked_at === null &&
    (isPermanentExpiry(row.expires_at) || Number(row.expires_at) > now)
  )
}

function defaultLogger(msg: string, meta?: Record<string, unknown>): void {
  if (meta) console.log(msg, meta)
  else console.log(msg)
}

export class ReconcileService {
  private readonly repo: Pick<LinksRepo, 'listAll'>
  private readonly xray: XrayClient
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void
  private readonly now: () => number
  private status: XrayReconcileStatus = {
    activeLinks: 0,
    reconciledAt: 0,
    lastFix: { added: 0, removed: 0 },
  }

  constructor(deps: ReconcileDeps) {
    this.repo = deps.repo
    this.xray = deps.xray
    this.log = deps.logger ?? defaultLogger
    this.now = deps.now ?? (() => Date.now())
  }

  /** 内存态快照（/api/healthz 用）。返回副本，调用方改不动内部状态。 */
  snapshot(): XrayReconcileStatus {
    return { ...this.status, lastFix: { ...this.status.lastFix } }
  }

  /**
   * 跑一轮收敛。逐行处理，任一 xray 调用失败只记入 failures 并继续，绝不改账本、绝不抛出
   * （除 repo 读失败等意外）。返回本轮结果。
   */
  async run(): Promise<ReconcileResult> {
    const now = this.now()
    const rows = this.repo.listAll()
    const added: string[] = []
    const removed: string[] = []
    const failures: string[] = []
    let activeLinks = 0

    for (const row of rows) {
      if (shouldBeActive(row, now)) {
        activeLinks++
        try {
          // 真正新增才算补回；`already exists` 返回 false（幂等），不计动作
          const created = await this.xray.addUser({ email: row.email, uuid: row.uuid })
          if (created) added.push(row.id)
        } catch {
          // 账本未改：链接不能被误删/误改，下轮重试
          failures.push(row.id)
        }
      } else {
        try {
          // rmu 幂等：不存在返回 0，只有真删了才算清理动作
          const n = await this.xray.removeUser(row.email)
          if (n > 0) removed.push(row.id)
        } catch {
          failures.push(row.id)
        }
      }
    }

    this.status = {
      activeLinks,
      reconciledAt: this.now(),
      lastFix: { added: added.length, removed: removed.length },
    }

    // 失败必须有可观测路径（AGENTS.md 已知坑：xray 失败不能吞），但压成一行避免洪水
    if (failures.length) {
      this.log(`[reconcile] xray 调用失败 ${failures.length} 条（账本未改，下轮重试）`, {
        ids: failures,
      })
    }
    // 无动作不打日志（R4）；有动作才打一行摘要
    if (added.length || removed.length) {
      this.log(
        `[reconcile] 检查 ${rows.length} / 补回 ${added.length}（${added.join(',')}）` +
          ` / 清理 ${removed.length}（${removed.join(',')}）`,
      )
    }

    return { checked: rows.length, added, removed, failures }
  }
}
