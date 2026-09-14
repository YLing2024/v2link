import { useMemo, useState } from 'react'
import Modal from './Modal'
import { extendLink } from '../api'
import { toDateTimeLocal, toEpochMs } from '../lib/datetime'
import { humanDuration } from '../lib/format'
import type { Link } from '../types'

// 「编辑过期时间」弹窗（用户 2026-09-14 反馈：这不是「延长/延时」，而是直接改过期时刻）。
//   · 主输入 = 过期时刻（datetime-local，分钟精度），预填当前到期时刻
//   · 限时链接可「转为永久」；永久链接无到期时刻，填时刻即转回限时
//   · 提前（缩短有效期）提交前二次确认；剩余时长以提示形式显示在旁边

type Mode = 'finite' | 'permanent'

export function ActModal({
  link,
  onClose,
  onDone,
}: {
  link: Link
  onClose: () => void
  onDone: (updated: Link) => void
}) {
  const [mode, setMode] = useState<Mode>('finite')
  const [absInput, setAbsInput] = useState<string>(
    link.permanent ? '' : toDateTimeLocal(link.expiresAt),
  )
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const hint = useMemo(() => {
    if (mode === 'permanent') {
      return link.permanent
        ? '当前为永久有效，不会自动过期。'
        : '转为永久后不再自动过期，需手动吊销；之后可随时再指定过期时间。'
    }
    const ms = toEpochMs(absInput)
    if (ms === null) {
      return link.permanent ? '当前为永久有效：选择过期时间即转为限时。' : ''
    }
    const diff = ms - Date.now()
    if (diff <= 0) return '该时刻已过去，请选择未来时间'
    const tip = `距现在约 ${humanDuration(diff)}`
    return ms < link.expiresAt ? `${tip}（比当前到期时间早，将缩短有效期）` : tip
  }, [absInput, link.expiresAt, link.permanent, mode])

  async function submit() {
    setErr('')
    if (mode === 'permanent') {
      const ok = window.confirm('转为永久有效后不再自动过期，只能手动吊销。确认？')
      if (!ok) return
      await doSubmit({ permanent: true })
      return
    }
    const ms = toEpochMs(absInput)
    if (ms === null) {
      setErr('请选择过期时间')
      return
    }
    if (ms <= Date.now()) {
      setErr('过期时间须晚于当前时间')
      return
    }
    // 缩短有效期 → 二次确认（编辑语义下这是有意义的操作，但容易误点）
    if (!link.permanent && ms < link.expiresAt) {
      const ok = window.confirm('新的过期时间早于当前，将缩短有效期。确认？')
      if (!ok) return
    }
    await doSubmit({ expiresAt: ms })
  }

  async function doSubmit(body: { expiresAt?: number; permanent?: boolean }) {
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
    <Modal title="编辑过期时间" onClose={onClose}>
      <div className="form">
        {!link.permanent && (
          <div className="field">
            <span className="field-label">方式</span>
            <div className="chips">
              <button
                type="button"
                className={mode === 'finite' ? 'chip chip-on' : 'chip'}
                onClick={() => {
                  setMode('finite')
                  setAbsInput(toDateTimeLocal(link.expiresAt))
                }}
              >
                指定时刻
              </button>
              <button
                type="button"
                className={mode === 'permanent' ? 'chip chip-on' : 'chip'}
                onClick={() => setMode('permanent')}
              >
                转为永久
              </button>
            </div>
          </div>
        )}

        {mode === 'finite' ? (
          <label className="field">
            <span className="field-label">过期时间（本地时间）</span>
            <input
              type="datetime-local"
              className="input"
              value={absInput}
              autoFocus
              onChange={(e) => setAbsInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
            {hint && <span className="field-hint">{hint}</span>}
          </label>
        ) : (
          <span className="field-hint">
            转为永久后不再自动过期，需手动吊销；之后可随时再指定过期时间。
          </span>
        )}

        {err && <div className="form-error">{err}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? '提交中…' : '确定'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
