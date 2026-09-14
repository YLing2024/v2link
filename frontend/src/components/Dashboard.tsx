import { useCallback, useEffect, useState } from 'react'
import { listLinks, revokeLink } from '../api'
import { clearToken } from '../lib/sso'
import { formatBytes, formatDateTime, formatExpiry } from '../lib/format'
import type { Link } from '../types'
import { CreateModal } from './CreateModal'
import { CopyModal } from './CopyModal'
import { ActModal } from './ActModal'
import { LinkDetailModal } from './LinkDetailModal'
import { AuditModal } from './AuditModal'
import { RegionProbeBar } from './RegionProbeBar'

// 主界面（Swiss 极简）：顶部栏 + 表格。
// 状态徽标：active 绿点、expired/revoked 灰。操作按状态禁用。

const STATUS_LABEL: Record<Link['status'], string> = {
  active: '使用中',
  expired: '已过期',
  revoked: '已吊销',
}

type ModalState =
  | { kind: 'create' }
  | { kind: 'copy'; link: Link }
  | { kind: 'extend'; link: Link }
  | { kind: 'detail'; link: Link }
  | { kind: 'audit' }
  | null

export default function Dashboard() {
  const [links, setLinks] = useState<Link[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<ModalState>(null)
  const [busy, setBusy] = useState<string>('') // 正在操作的行 id

  const refresh = useCallback(async () => {
    setError('')
    try {
      const data = await listLinks()
      setLinks(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function applyUpdate(updated: Link) {
    setLinks((prev) => prev.map((l) => (l.id === updated.id ? updated : l)))
  }

  async function doRevoke(link: Link) {
    if (!window.confirm(`吊销 ${link.note || link.id}？吊销后不可恢复。`)) return
    setBusy(link.id)
    try {
      applyUpdate(await revokeLink(link.id))
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  function logout() {
    clearToken()
    window.location.reload()
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">v2link</span>
          <span className="sub">临时 VLESS 链接</span>
        </div>
        <div className="topbar-right">
          <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>
            刷新
          </button>
          <button type="button" className="btn" onClick={() => setModal({ kind: 'audit' })}>
            审计
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: 'create' })}>
            生成链接
          </button>
          <button type="button" className="btn btn-ghost" onClick={logout}>
            退出
          </button>
        </div>
      </header>

      <main className="content">
        {error && <div className="banner banner-error">{error}</div>}

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>备注</th>
                <th>状态</th>
                <th>创建</th>
                <th>到期</th>
                <th className="num">流量 ↓ / ↑</th>
                <th className="ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="empty">
                    加载中…
                  </td>
                </tr>
              ) : links.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    暂无链接
                  </td>
                </tr>
              ) : (
                links.map((l) => {
                  const active = l.status === 'active'
                  const isBusy = busy === l.id
                  return (
                    <tr key={l.id} className={active ? '' : 'dim'}>
                      <td className="note-cell">
                        <span className="note-text">{l.note || '—'}</span>
                        <span className="mono id-sub">{l.id}</span>
                      </td>
                      <td>
                        <span className={`status-dot ${l.status}`} />
                        <span className="status-label">{STATUS_LABEL[l.status]}</span>
                      </td>
                      <td className="mono">{formatDateTime(l.createdAt)}</td>
                      <td className="mono">{formatExpiry(l.expiresAt)}</td>
                      <td className="num mono">
                        <span className="down">↓ {formatBytes(l.downBytes)}</span>{' '}
                        <span className="up">↑ {formatBytes(l.upBytes)}</span>
                      </td>
                      <td className="ops">
                        <div className="ops-btns">
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setModal({ kind: 'detail', link: l })}
                          >
                            详情
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setModal({ kind: 'copy', link: l })}
                          >
                            复制/二维码
                          </button>
                          {active && (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => setModal({ kind: 'extend', link: l })}
                              >
                                延长
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                onClick={() => void doRevoke(l)}
                                disabled={isBusy}
                              >
                                吊销
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </main>

      <RegionProbeBar />

      {modal?.kind === 'create' && (
        <CreateModal onClose={() => setModal(null)} onCreated={() => void refresh()} />
      )}
      {modal?.kind === 'copy' && <CopyModal uuid={modal.link.uuid} onClose={() => setModal(null)} />}
      {modal?.kind === 'extend' && (
        <ActModal
          link={modal.link}
          onClose={() => setModal(null)}
          onDone={applyUpdate}
        />
      )}
      {modal?.kind === 'detail' && (
        <LinkDetailModal link={modal.link} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'audit' && <AuditModal onClose={() => setModal(null)} />}
    </div>
  )
}
