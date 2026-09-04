import { useState } from 'react'
import Modal from './Modal'
import { extendLink } from '../api'
import type { Link } from '../types'

// 延长链接弹窗（输入小时数；随链接时长上限 720h 校验）。
export function ActModal({
  link,
  onClose,
  onDone,
}: {
  link: Link
  onClose: () => void
  onDone: (updated: Link) => void
}) {
  const [value, setValue] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  async function submit() {
    const v = Number(value)
    setErr('')
    if (!Number.isInteger(v)) {
      setErr('请输入整数小时')
      return
    }
    if (v < 1 || v > 720) {
      setErr('时长须为 1~720 小时')
      return
    }
    setSubmitting(true)
    try {
      const updated = await extendLink(link.id, v)
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
        <label className="field">
          <span className="field-label">延长（小时）</span>
          <input
            type="number"
            className="input"
            min={1}
            max={720}
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>
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
