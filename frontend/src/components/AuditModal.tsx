import { useEffect, useState } from 'react'
import { auditLog } from '../api'
import type { AuditRecord } from '../types'
import Modal from './Modal'

// 操作审计（TASK-monitoring.md C）：后台 create/revoke/extend 留痕列表（分页）。
// 入口放 Dashboard 顶部栏「审计」；Swiss 极简列表。

const ACTION_LABEL: Record<AuditRecord['action'], string> = {
  create: '生成',
  revoke: '吊销',
  extend: '延长',
}

export function AuditModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<AuditRecord[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const PAGE = 30

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr('')
    auditLog({ limit: PAGE, offset })
      .then((p) => {
        if (!alive) return
        setRows(p.rows)
        setTotal(p.total)
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [offset])

  const totalPages = Math.max(1, Math.ceil(total / PAGE))
  const curPage = Math.floor(offset / PAGE) + 1

  return (
    <Modal title="操作审计" onClose={onClose} width={760}>
      {err ? (
        <div className="form-error">{err}</div>
      ) : loading ? (
        <div className="chart-empty">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="chart-empty">暂无审计记录</div>
      ) : (
        <>
          <table className="table table-dense">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>动作</th>
                <th>链接</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{formatTs(r.ts)}</td>
                  <td>{r.actor}</td>
                  <td>
                    <span className={`audit-tag audit-${r.action}`}>{ACTION_LABEL[r.action]}</span>
                  </td>
                  <td className="mono">{r.link_id || '—'}</td>
                  <td className="audit-detail mono">{formatDetail(r)}</td>
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
              {total} 条 · 第 {curPage}/{totalPages} 页
            </span>
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
    </Modal>
  )
}

function formatDetail(r: AuditRecord): string {
  if (!r.detail) return ''
  const d = r.detail
  const parts: string[] = []
  if (d.hours !== undefined) parts.push(`${d.hours}h`)
  if (d.note) parts.push(String(d.note))
  if (d.expires_at !== undefined) parts.push(`到期 ${formatTs(Number(d.expires_at))}`)
  return parts.join(' · ')
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
