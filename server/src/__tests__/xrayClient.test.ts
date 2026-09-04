import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { XrayClient } from '../services/xrayClient.js'

// XrayClient 单测：注入 execFn 记录 argv / 返回伪 stdout，校验：
//   · 参数形态（-s、-tag、-pattern、-reset）
//   · "Added N" / "Removed N" 判定（exit code 不可靠，必须解析 stdout）
//   · 临时文件被清理
//   · 重试（exec 抛错时按退避重试）

interface Call {
  args: string[]
  tmpFile: string | null
}

function makeClient(stdout: string | ((call: Call) => string), retries = 0): { c: XrayClient; calls: Call[] } {
  const calls: Call[] = []
  const c = new XrayClient({
    apiAddr: '127.0.0.1:8081',
    inboundTag: 'vless-in',
    retries,
    execFn: async (_file, args) => {
      const out = typeof stdout === 'function' ? stdout({ args, tmpFile: null }) : stdout
      calls.push({ args, tmpFile: null })
      return { stdout: out, stderr: '' }
    },
  })
  return { c, calls }
}

describe('XrayClient argv 与 stdout 判定', () => {
  it('addUser：adu argv = [ -s, adu, <tmp>/user.json ]；Added 1 → 成功且清理临时文件', async () => {
    const argList: string[] = []
    const c = new XrayClient({
      apiAddr: '127.0.0.1:8081',
      inboundTag: 'vless-in',
      execFn: async (_file, args) => {
        argList.push(...args)
        return {
          stdout: 'processing inbound: vless-in\nresult: ok\nAdded 1 user(s) in total.\n',
          stderr: '',
        }
      },
    })
    await c.addUser({ email: 'lk_abc', uuid: '11111111-1111-4111-8111-111111111111', speedMbps: 5 })
    // argv 形态：['api', 'adu', '-s=...', '<tmp>/user.json']
    expect(argList[0]).toBe('api')
    expect(argList[1]).toBe('adu')
    expect(argList[2]).toBe('-s=127.0.0.1:8081')
    const fileArg = argList[3]!
    expect(fileArg.endsWith('user.json')).toBe(true)
    // adu 不接受 -tag（实测 CLI 无该 flag），tag 写在 JSON 片段里 —— 此处不应出现 -tag
    expect(argList.join(' ')).not.toContain('-tag=')
    // 临时文件已被清理
    expect(fs.existsSync(fileArg)).toBe(false)
  })

  it('临时文件内容为完整 inbound 片段（顶层 inbounds 数组）', async () => {
    let content: unknown
    const c = new XrayClient({
      execFn: async (file, args) => {
        content = JSON.parse(fs.readFileSync(args[args.length - 1]!, 'utf8'))
        void file
        return { stdout: 'Added 1 user(s) in total.\n', stderr: '' }
      },
    })
    await c.addUser({ email: 'lk_abc', uuid: 'u', speedMbps: 7 })
    const parsed = content as { inbounds: { tag: string; settings: { clients: unknown[] } }[] }
    expect(Array.isArray(parsed.inbounds)).toBe(true)
    expect(parsed.inbounds[0]!.tag).toBe('vless-in')
    expect(parsed.inbounds[0]!.settings.clients).toHaveLength(1)
  })

  it('addUser：Added 0 + already exists → 抛错（adu 不覆盖）', async () => {
    const { c } = makeClient(
      'rpc error: ... User lk_abc already exists.\nAdded 0 user(s) in total.\n',
    )
    await expect(c.addUser({ email: 'lk_abc', uuid: 'u', speedMbps: 5 })).rejects.toThrow(/已存在/)
  })

  it('addUser：Added 0（结构错）→ 抛错', async () => {
    const { c } = makeClient('Added 0 user(s) in total.\n')
    await expect(c.addUser({ email: 'x', uuid: 'u', speedMbps: 1 })).rejects.toThrow(/未新增/)
  })

  it('removeUser：解析 Removed N 返回数；不存在 → 0 不抛', async () => {
    const { c } = makeClient('Removed 1 user(s) in total.\n')
    await expect(c.removeUser('lk_abc')).resolves.toBe(1)
    const { c: c2 } = makeClient('Removed 0 user(s) in total.\n')
    await expect(c2.removeUser('ghost')).resolves.toBe(0)
  })

  it('queryTraffic：带 -pattern；reset 时追加 -reset', async () => {
    const calls: string[][] = []
    const c = new XrayClient({
      execFn: async (_f, args) => {
        calls.push(args)
        return { stdout: '{}', stderr: '' }
      },
    })
    await c.queryTraffic('user>>>', false)
    expect(calls[0]).toContain('statsquery')
    expect(calls[0]).toContain('-pattern')
    await c.queryTraffic('user>>>', true)
    expect(calls[1]!.join(' ')).toContain('-reset')
  })

  it('exec 抛错 → 重试 retries 次后仍失败则抛出', async () => {
    let n = 0
    const c = new XrayClient({
      retries: 2,
      execFn: async () => {
        n++
        throw new Error('boom')
      },
    })
    await expect(c.queryTraffic('user>>>', false)).rejects.toThrow('xray api statsquery 调用失败')
    expect(n).toBe(3) // 1 + 2 retries
  })
})
