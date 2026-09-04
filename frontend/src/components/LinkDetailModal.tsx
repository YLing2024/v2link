import { useEffect, useMemo, useState } from 'react'
import { linkConnections, linkTraffic } from '../api'
import type { ConnectionRecord, Link, TrafficPoint } from '../types'
import Modal from './Modal'
import TrafficChart from './TrafficChart'

// 单链接追溯视图（TASK-monitoring.md A §3 + B §3）：
//   顶部「流量趋势」：近 24h / 近 7d / 近 30d 三个快捷档（bucket 随之 hour/day）
//   底部「连接记录」：时间/目标域名/端口/用户搜索，分页
// 数据量大走接口分页；曲线量小一次拉完。

type Range = { label: string; hours: number; bucket: 'hour' | 'day' }

const RANGES: Range[] = [
  { label: '24h', hours: 24, bucket: 'hour' },
  { label: '7d', hours: 24 * 7, bucket: 'day' },
  { label: '30d', hours: 24 * 30, bucket: 'day' },
]

export function LinkDetailModal({
  link,
  onClose,
}: {
  link: Link
  onClose: () => void
}) {
  const [range, setRange] = useState<Range>(RANGES[0]!)
  const [points, setPoints] = useState<TrafficPoint[] | null>(null)
  const [chartErr, setChartErr] = useState('')

  const [conns, setConns] = useState<ConnectionRecord[]>([])
  const [connTotal, setConnTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [q, setQ] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [connLoading, setConnLoading] = useState(false)
  const [connErr, setConnErr] = useState('')
  const PAGE = 30

  useEffect(() => {
    let alive = true
    setPoints(null)
    setChartErr('')
    const to = Date.now()
    const from = to - range.hours * 3600_000
    linkTraffic(link.id, range.bucket, from, to)
      .then((d) => alive && setPoints(d))
      .catch((e) => alive && setChartErr((e as Error).message))
    return () => {
      alive = false
    }
  }, [link.id, range])

  useEffect(() => {
    let alive = true
    setConnLoading(true)
    setConnErr('')
    linkConnections(link.id, { q, offset, limit: PAGE })
      .then((p) => {
        if (!alive) return
        setConns(p.rows)
        setConnTotal(p.total)
      })
      .catch((e) => alive && setConnErr((e as Error).message))
      .finally(() => alive && setConnLoading(false))
    return () => {
      alive = false
    }
  }, [link.id, q, offset])

  const totalPages = Math.max(1, Math.ceil(connTotal / PAGE))
  const curPage = Math.floor(offset / PAGE) + 1

  const pageButtons = useMemo(() => {
    const lo = Math.max(1, curPage - 2)
    const hi = Math.min(totalPages, curPage + 2)
    const out: number[] = []
    for (let p = lo; p <= hi; p++) out.push(p)
    return out
  }, [curPage, totalPages])

  return (
    <Modal title={`链接详情 · ${link.note || link.id}`} onClose={onClose} width={760}>
      {/* A. 流量趋势 */}
      <div className="detail-block">
        <div className="detail-head">
          <span className="detail-title">流量趋势</span>
          <div className="chips">
            {RANGES.map((r) => (
              <button
                key={r.label}
                type="button"
                className={range.label === r.label ? 'chip chip-on' : 'chip'}
                onClick={() => {
                  setRange(r)
                  setPoints(null)
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {chartErr ? (
          <div className="form-error">{chartErr}</div>
        ) : points === null ? (
          <div className="chart-empty">加载中…</div>
        ) : points.length === 0 ? (
          <div className="chart-empty">该时间段暂无流量数据</div>
        ) : (
          <TrafficChart points={points} />
        )}
      </div>

      {/* B. 连接记录 */}
      <div className="detail-block">
        <div className="detail-head">
          <span className="detail-title">连接记录</span>
          <div className="search-box">
            <input
              className="input input-sm"
              placeholder="按域名搜索（如 google）"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setQ(searchInput.trim())
                  setOffset(0)
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setQ(searchInput.trim())
                setOffset(0)
              }}
            >
              搜索
            </button>
            {q && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setQ('')
                  setSearchInput('')
                  setOffset(0)
                }}
              >
                清除
              </button>
            )}
          </div>
        </div>
        {connErr ? (
          <div className="form-error">{connErr}</div>
        ) : connLoading ? (
          <div className="chart-empty">加载中…</div>
        ) : conns.length === 0 ? (
          <div className="chart-empty">暂无连接记录（access log 采集启用后可见）</div>
        ) : (
          <>
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>目标</th>
                  <th className="num">端口</th>
                  <th>用户</th>
                </tr>
              </thead>
              <tbody>
                {conns.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{formatTs(c.ts)}</td>
                    <td className="mono">{c.host || '—'}</td>
                    <td className="num mono">{c.port ?? '—'}</td>
                    <td className="mono">{c.email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              <button
                type="button"
                className="btn btn-sm"
                disabled={offset <= 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                ← 上一页
              </button>
              <span className="pager-info">
                {connTotal} 条 · 第 {curPage}/{totalPages} 页
              </span>
              {pageButtons.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={p === curPage ? 'btn btn-sm chip-on' : 'btn btn-sm'}
                  onClick={() => setOffset((p - 1) * PAGE)}
                >
                  {p}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-sm"
                disabled={curPage >= totalPages}
                onClick={() => setOffset(offset + PAGE)}
              >
                下一页 →
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
