import { describe, expect, it, vi } from 'vitest'
import { createRegionProbeService } from '../services/regionProbe.js'

// regionProbe 单测（TASK-extend-regions.md 需求 2）：内存快照 + 历史、超时/HTTP 失败语义。
// fetch 全 mock：成功带响应头（ResizeObserver 无关）、超时用 AbortError、非 2xx 记状态码。

function okFetch(): typeof fetch {
  return vi.fn(async () => {
    return {
      ok: true,
      status: 204,
    } as unknown as Response
  }) as unknown as typeof fetch
}

function timeoutFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new DOMException('aborted', 'AbortError')
  }) as unknown as typeof fetch
}

function rejectingFetch(err: Error): typeof fetch {
  return vi.fn(async () => {
    throw err
  }) as unknown as typeof fetch
}

const PROBES = [
  { key: 'us', name: '美国', flag: '🇺🇸', url: 'https://us.example/generate_204' },
  { key: 'jp', name: '日本', flag: '🇯🇵', url: 'https://jp.example/' },
]

function makeSvc(opts?: { fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number }) {
  return createRegionProbeService({
    probes: PROBES,
    fetchFn: opts?.fetchFn ?? okFetch(),
    now: opts?.now ?? (() => 1_800_000_000_000),
    timeoutMs: opts?.timeoutMs ?? 5000,
    logger: () => undefined,
  })
}

describe('runRound', () => {
  it('全部可达 → ok=true，rttMs 为时长（now 推移模拟），error=null', async () => {
    let t = 1_000
    const svc = makeSvc({
      now: () => {
        t += 50
        return t
      },
    })
    const round = await svc.runRound()
    expect(round.results).toHaveLength(2)
    expect(round.results.every((r) => r.ok)).toBe(true)
    expect(round.results.every((r) => (r.rttMs as number) > 0)).toBe(true)
    expect(round.results.every((r) => r.error === null)).toBe(true)
    expect(round.results[0]!.key).toBe('us')
    expect(round.results[1]!.key).toBe('jp')
  })

  it('HTTP 非 2xx → ok=false 记状态码（rtt 仍可能测得）', async () => {
    const fetchFn = vi.fn(async () => {
      return { ok: false, status: 503 } as unknown as Response
    }) as unknown as typeof fetch
    const svc = makeSvc({ fetchFn })
    const round = await svc.runRound()
    expect(round.results.every((r) => r.ok === false)).toBe(true)
    expect(round.results[0]!.error).toBe('HTTP 503')
  })

  it('超时（AbortError）→ ok=false error=timeout，rtt=null，不抛', async () => {
    const svc = makeSvc({ fetchFn: timeoutFetch() })
    const round = await svc.runRound()
    expect(round.results.every((r) => !r.ok && r.error === 'timeout' && r.rttMs === null)).toBe(true)
  })

  it('网络错误（DNS/拒绝）→ ok=false error=原因', async () => {
    const svc = makeSvc({ fetchFn: rejectingFetch(new Error('ENOTFOUND example.com')) })
    const round = await svc.runRound()
    expect(round.results.every((r) => !r.ok)).toBe(true)
    expect(round.results[0]!.error).toContain('ENOTFOUND')
  })

  it('单个地区 fetch 抛异常 → 整轮不抛，其余照常', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 204 } as unknown as Response)
      .mockRejectedValueOnce(new Error('boom')) as unknown as typeof fetch
    const svc = makeSvc({ fetchFn })
    const round = await svc.runRound()
    expect(round.results[0]!.ok).toBe(true)
    expect(round.results[1]!.ok).toBe(false)
  })
})

describe('snapshot / history', () => {
  it('未跑过 → updatedAt=0、probes=[]、history=[]', () => {
    const svc = makeSvc()
    expect(svc.snapshot()).toEqual({ updatedAt: 0, probes: [] })
    expect(svc.history()).toEqual([])
  })

  it('跑一轮后 snapshot 返回全部地区（含新配置占位）；最新在前', async () => {
    let t = 1_000
    const svc = makeSvc({
      now: () => {
        t += 50
        return t
      },
    })
    await svc.runRound()
    const snap = svc.snapshot()
    expect(snap.updatedAt).toBeGreaterThan(0)
    expect(snap.probes).toHaveLength(2)
    expect(snap.probes.map((p) => p.key)).toEqual(['us', 'jp'])
    expect(svc.history()).toHaveLength(1)
  })

  it('只保留最近 N 轮（默认 12）', async () => {
    let t = 1_000
    const svc = makeSvc({
      now: () => {
        t += 50
        return t
      },
    })
    for (let i = 0; i < 15; i++) await svc.runRound()
    expect(svc.history()).toHaveLength(12)
    expect(svc.snapshot().updatedAt).toBeGreaterThan(0)
  })

  it('running 时并发调用不叠加轮次（复用进行中轮）', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchFn = vi.fn(async () => {
      await gate
      return { ok: true, status: 204 } as unknown as Response
    }) as unknown as typeof fetch
    let t = 1_000
    const svc = makeSvc({
      fetchFn,
      now: () => {
        t += 50
        return t
      },
    })
    const p1 = svc.runRound()
    const p2 = svc.runRound() // running=true → 跳过
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.results).toHaveLength(2)
    expect(r2.results).toHaveLength(2)
    expect(svc.history()).toHaveLength(1)
  })
})
