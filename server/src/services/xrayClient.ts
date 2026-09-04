import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { config } from '../config.js'
import type { XrayUserSpec } from '../lib/vless.js'
import { buildInboundFragment } from '../lib/vless.js'

// 控制面访问数据面的唯一通道（REQUIREMENTS.md §3.1/§3 约束：禁散落 shell 调用）。
// 全部经 `xray api <sub>` 子命令完成 adu / rmu / statsquery，零 gRPC、零 reload。
//
// 实测 CLI 语义（2026-09-04 本地验证，含踩坑结论）：
//  - adu：输入必须为「顶层含 inbounds 数组」的完整配置片段（写成临时文件传参），
//    inbound tag 写在片段 inbounds[0].tag（**adu 命令行无 -tag flag，加了会报错**）。
//    返回 "Added N user(s)"；**退出码对业务失败不敏感**：
//      · 重复 email 不覆盖更新 —— stdout 报 "already exists" 且 Added 0，exit 仍 0
//      · 结构错误（缺 inbounds 包装）—— 只打 "Added 0 user(s)"，exit 仍 0
//    因此必须以 stdout 里 "Added N" 判定成功，不能只看 exit code。
//  - rmu：-tag 后跟 email；删不存在的用户 exit 0（"Removed 0 user(s)"），幂等无害。
//  - statsquery -reset：返回的是「reset 前」的累计值；reset 后同名 stat 的 value 字段消失
//    （实测再次查询只剩 name 无 value）。解析见 lib/xrayStats.ts。
//  - 失败重试：execFile 抛错（超时/进程非零码）时按指数退避重试 XRAY_API_RETRIES 次。
//
// adu 临时文件：写进系统临时目录，每次调用后删除；不落 data/（不污染账本目录）。

const execFileP = promisify(execFile)

export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>

const realExec: ExecFn = async (file, args, opts) => {
  const { stdout, stderr } = await execFileP(file, args, {
    timeout: opts.timeout,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  return { stdout, stderr }
}

export class XrayClient {
  private readonly apiAddr: string
  private readonly bin: string
  private readonly inboundTag: string
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly execFn: ExecFn

  constructor(opts?: {
    apiAddr?: string
    bin?: string
    inboundTag?: string
    timeoutMs?: number
    retries?: number
    execFn?: ExecFn
  }) {
    this.apiAddr = opts?.apiAddr ?? config.xrayApi
    this.bin = opts?.bin ?? config.xrayBin
    this.inboundTag = opts?.inboundTag ?? config.inboundTag
    this.timeoutMs = opts?.timeoutMs ?? config.xrayTimeoutMs
    this.retries = opts?.retries ?? config.xrayRetries
    this.execFn = opts?.execFn ?? realExec
  }

  // ---- 底层调用：统一 -s、超时、重试 ----
  private async run(sub: string, args: string[]): Promise<string> {
    const fullArgs = [`-s=${this.apiAddr}`, ...args]
    let lastErr: Error | null = null
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const { stdout } = await this.execFn(this.bin, ['api', sub, ...fullArgs], {
          timeout: this.timeoutMs,
        })
        return stdout
      } catch (e) {
        lastErr = e as Error
        if (attempt < this.retries) {
          // 指数退避：200ms * 2^attempt
          await sleep(200 * 2 ** attempt)
        }
      }
    }
    throw new Error(`xray api ${sub} 调用失败: ${lastErr?.message ?? '未知错误'}`)
  }

  /** 加用户。xray 以 stdout "Added N user(s)" 判定成功（exit code 不可靠，见文件头注释）。
   *  注意：adu 不接受 -tag 参数，inbound tag 写在 JSON 片段的 inbounds[0].tag 里。 */
  async addUser(spec: XrayUserSpec): Promise<void> {
    const file = writeTempFragment(spec, this.inboundTag)
    try {
      const out = await this.run('adu', [file])
      const m = /Added\s+(\d+)\s+user/i.exec(out)
      const added = m ? Number(m[1]) : 0
      if (added < 1) {
        const reason = /already exists/i.test(out)
          ? 'xray 用户已存在（adu 不覆盖，需先 rmu）'
          : `adu 未新增用户(可能结构/上游问题): ${out.trim().slice(0, 200)}`
        throw new Error(reason)
      }
    } finally {
      fs.rmSync(file, { force: true })
    }
  }

  /** 删用户。幂等：对不存在的 email 返回 0 不抛。返回实际删除数。 */
  async removeUser(email: string): Promise<number> {
    const out = await this.run('rmu', ['-tag=' + this.inboundTag, email])
    const m = /Removed\s+(\d+)\s+user/i.exec(out)
    return m ? Number(m[1]) : 0
  }

  /** 查询流量。reset=false 只读；reset=true 返回并清零（账本轮询用）。 */
  async queryTraffic(pattern: string, reset: boolean): Promise<string> {
    const args = ['-pattern', pattern]
    if (reset) args.push('-reset')
    return this.run('statsquery', args)
  }
}

function writeTempFragment(spec: XrayUserSpec, inboundTag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2link-adu-'))
  const file = path.join(dir, 'user.json')
  fs.writeFileSync(file, JSON.stringify(buildInboundFragment(spec, inboundTag)))
  return file
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const xrayClient = new XrayClient()
