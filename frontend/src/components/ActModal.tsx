import { useMemo, useState } from 'react'
import Modal from './Modal'
import { extendLink } from '../api'
import type { Link } from '../types'

// 延长链接弹窗：三模式
//   · 「相对」：输入小时数（沿用 1~720 上限，向后平移当前到期时刻）
//   · 「绝对」：datetime-local 选未来某个具体时刻 → 转 epoch ms 提交
//   · 「转为永久」：expires_at 置哨兵 0，之后不再自动过期（二次 confirm）
// 永久链接（link.permanent）没有基准时刻：只提供「绝对」模式（选到期时刻 = 转限时）。
// 绝对模式允许提前（缩短有效期）：提交前 window.confirm 二次确认。
// datetime-local 值为本地时区 → 校验 > now 即「未来」，与后端 epoch 语义一致。

type Mode = 'hours' | 'absolute' | 'permanent'

/** datetime-local 输入 → epoch ms（输入为空/非法返回 null） */
export function toEpochMs(dtLocal: string): number | null {
  if (!dtLocal) return null
  const d = new Date(dtLocal)
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

/** epoch ms → datetime-local 可见字符串（本地时区，无秒） */
export function toDateTimeLocal(ms: number): string {
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// 到期时间附近的建议档位（绝对模式默认值：当前到期 ± 若干小时）
const ABSOLUTE_STEPS: { label: string; diffMs: number }[] = [
  { label: '延 24h', diffMs: 24 * 3600 * 1000 },
  { label: '延 7d', diffMs: 7 * 24 * 3600 * 1000 },
  { label: '提前 1h', diffMs: -3600 * 1000 },
]

export function ActModal({
  link,
  onClose,
  onDone,
}: {
  link: Link
  onClose: () => void
  onDone: (updated: Link) => void
}) {
  const [mode, setMode] = useState<Mode>(link.permanent ? 'absolute' : 'hours')
  const [value, setValue] = useState<string>('')
  const [absInput, setAbsInput] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const futureHint = useMemo(() => {
    const ms = toEpochMs(absInput)
    if (ms === null) return ''
    const diff = ms - Date.now()
    const hours = Math.round(diff / 3600_000)
    if (diff <= 0) return '该时刻已过去，请选择未来时间'
    return `距现在约 ${hours} 小时${diff < link.expiresAt - Date.now() ? '（将提前到期）' : ''}`
  }, [absInput, link.expiresAt])

  function switchMode(m: Mode) {
    setMode(m)
    setErr('')
    // 切到绝对模式：预填当前到期时刻（保留其日间参考）；永久链接无基准 → 留空由用户选
    if (m === 'absolute') setAbsInput(link.permanent ? '' : toDateTimeLocal(link.expiresAt))
    if (m === 'hours') setValue('')
  }

  async function submit() {
    setErr('')
    if (mode === 'hours') {
      const v = Number(value)
      if (!Number.isInteger(v)) {
        setErr('请输入整数小时')
        return
      }
      if (v < 1 || v > 720) {
        setErr('时长须为 1~720 小时')
        return
      }
      await doSubmit({ hours: v })
      return
    }
    if (mode === 'permanent') {
      const ok = window.confirm('转为永久有效后不再自动过期，只能手动吊销。确认？')
      if (!ok) return
      await doSubmit({ permanent: true })
      return
    }
    const ms = toEpochMs(absInput)
    if (ms === null) {
      setErr('请选择到期日期与时间')
      return
    }
    if (ms <= Date.now()) {
      setErr('到期时刻须晚于当前时间')
      return
    }
    // 绝对模式允许提前（缩短有效期）——提示语二次确认
    if (ms < link.expiresAt) {
      const ok = window.confirm('新到期时刻早于当前到期时间，将缩短有效期。确认？')
      if (!ok) return
    }
    await doSubmit({ expiresAt: ms })
  }

  async function doSubmit(body: { expiresAt?: number; hours?: number; permanent?: boolean }) {
    setSubmitting(true)
    try {
      const updated = await extendLink(link.id, body)
      onDone(updated)
      onClose()
    } catch (e) {
      setErr((e as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <Modal title="延长链接" onClose={onClose}>
      <div className="form">
        <div className="field">
          <span className="field-label">方式</span>
          <div className="chips">
            {!link.permanent && (
              <button
                type="button"
                className={mode === 'hours' ? 'chip chip-on' : 'chip'}
                onClick={() => switchMode('hours')}
              >
                相对
              </button>
            )}
            <button
              type="button"
              className={mode === 'absolute' ? 'chip chip-on' : 'chip'}
              onClick={() => switchMode('absolute')}
            >
              绝对
            </button>
            {!link.permanent && (
              <button
                type="button"
                className={mode === 'permanent' ? 'chip chip-on' : 'chip'}
                onClick={() => switchMode('permanent')}
              >
                转为永久
              </button>
            )}
          </div>
          {link.permanent && (
            <span className="field-hint">当前为永久有效：选择到期时刻即转为限时。</span>
          )}
        </div>

        {mode === 'hours' ? (
          <label className="field">
            <span className="field-label">延长（小时）</span>
            <input
              type="number"
              className="input"
              min={1}
              max={720}
              placeholder="在当前到期基础上延长"
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>
        ) : mode === 'absolute' ? (
          <>
            <label className="field">
              <span className="field-label">到期时刻（本地时间）</span>
              <input
                type="datetime-local"
                className="input"
                value={absInput}
                onChange={(e) => setAbsInput(e.target.value)}
              />
              {futureHint && <span className="field-hint">{futureHint}</span>}
            </label>
            <div className="field">
              {!link.permanent && (
                <div className="chips">
                  {ABSOLUTE_STEPS.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      className="chip"
                      onClick={() => setAbsInput(toDateTimeLocal(link.expiresAt + s.diffMs))}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <span className="field-hint">
            转为永久后不再自动过期，需手动吊销；之后可用「绝对」模式随时设回到期时间。
          </span>
        )}

        {err && <div className="form-error">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? '提交中…' : '确定'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
