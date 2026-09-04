import { useEffect, useState } from 'react'
import { regionProbes } from '../api'
import { formatRelative } from '../lib/format'
import { probeLabel, toneLabel, toneOf } from '../lib/regionProbe'
import type { RegionProbeSnapshot } from '../types'

// 底部全球连通性监控条（TASK-extend-regions.md 需求 2）：
//   · 数据来自后端 GET /api/regions/probes（scheduler 每 5min 一轮 + 启动即首轮）
//   · 横向一排地区徽标：🇺🇸 120ms ✓ / ✗ timeout；色 = 延迟/失败
//   · 展示挂载时拉取一次（页面停留期间不主动轮询——数据源 5min 才更新，刷新页面即见最新）
//   · 附带「N 分钟前更新」时间戳

const TICK_MS = 60_000 // 页面停留时每分钟刷新一次「N 分钟前」显示

export function RegionProbeBar() {
  const [snap, setSnap] = useState<RegionProbeSnapshot | null>(null)
  const [err, setErr] = useState('')
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let alive = true
    setErr('')
    regionProbes()
      .then((d) => alive && setSnap(d))
      .catch((e) => alive && setErr((e as Error).message))
    const t = setInterval(() => alive && setNow(Date.now()), TICK_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const probes = snap?.probes ?? []
  const updatedAt = snap?.updatedAt ?? 0

  return (
    <footer className="regionbar">
      <span className="regionbar-title">地区连通性</span>
      {err ? (
        <span className="regionbar-err">{err}</span>
      ) : probes.length === 0 ? (
        <span className="regionbar-empty">加载中…</span>
      ) : (
        <div className="regionbar-row">
          {probes.map((p) => {
            const tone = toneOf(p)
            return (
              <span
                key={p.key}
                className={`region-tag region-${tone}`}
                title={`${p.flag} ${p.name} · ${toneLabel(tone)}${p.rttMs !== null ? ` · ${p.rttMs}ms` : ''}${p.error ? ` · ${p.error}` : ''}`}
              >
                <span className="region-flag">{p.flag}</span>
                <span className="region-name">{p.name}</span>
                <span className="region-metric mono">{probeLabel(p)}</span>
              </span>
            )
          })}
        </div>
      )}
      <span className="regionbar-ts">
        {updatedAt ? `${formatRelative(updatedAt, now)}更新` : '尚未探测'}
      </span>
    </footer>
  )
}
