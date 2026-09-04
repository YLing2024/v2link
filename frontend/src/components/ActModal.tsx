import { useState } from 'react'
import Modal from './Modal'
import { changeSpeed, extendLink } from '../api'
import type { Link } from '../types'

// 通用操作弹窗：延长（hours）/ 改速（speedMbps）。按 type 渲染对应字段与提交函数。
export function ActModal({
  type,
  link,
  onClose,
  onDone,
}: {
  type: 'extend' | 'speed'
  link: Link
  onClose: () => void
  onDone: (updated: Link) => void
}) {
  const [value, setValue] = useState<string>(type === 'extend' ? '' : String(link.speedMbps))
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const isExtend = type === 'extend'
  const title = isExtend ? '延长链接' : '修改限速'

  async function submit() {
    const v = Number(value)
    setErr('')
    if (!Number.isInteger(v)) {
      setErr(isExtend ? '请输入整数小时' : '请输入整数 Mbps')
      return
    }
    if (isExtend && (v < 1 || v > 720)) {
      setErr('时长须为 1~720 小时')
      return
    }
    if (!isExtend && (v < 0 || v > 100)) {
      setErr('限速须为 0~100 Mbps')
      return
    }
    setSubmitting(true)
    try {
      const updated = isExtend ? await extendLink(link.id, v) : await changeSpeed(link.id, v)
      onDone(updated)
      onClose()
    } catch (e) {
      setErr((e as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="form">
        <label className="field">
          <span className="field-label">{isExtend ? '延长（小时）' : '限速（Mbps）'}</span>
          <input
            type="number"
            className="input"
            min={isExtend ? 1 : 0}
            max={isExtend ? 720 : 100}
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          {!isExtend && <span className="field-hint">0 = 不限速；服务器总带宽约 30Mbps</span>}
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
