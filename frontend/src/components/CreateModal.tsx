import { useState } from 'react'
import { createLink } from '../api'
import Modal from './Modal'

// 「生成链接」弹窗：时长快捷 + 自定义 + 限速 + 备注
// 需求 §6：时长快捷 1h/6h/24h/3d/7d + 自定义 hours；限速默认 10（提示约 30Mbps 总带宽）

export const QUICK_HOURS: { label: string; hours: number }[] = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
]

export function CreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [hours, setHours] = useState<number>(24)
  const [customHours, setCustomHours] = useState('')
  const [custom, setCustom] = useState(false)
  const [speed, setSpeed] = useState<number>(10)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const selectedHours = custom ? Number(customHours) : hours

  async function submit() {
    setErr('')
    const h = selectedHours
    if (!Number.isInteger(h) || h < 1 || h > 720) {
      setErr('时长须为 1~720 小时的整数')
      return
    }
    if (!Number.isInteger(speed) || speed < 0 || speed > 100) {
      setErr('限速须为 0~100 Mbps 的整数')
      return
    }
    setSubmitting(true)
    try {
      await createLink({ note: note || undefined, hours: h, speed_mbps: speed })
      onCreated()
      onClose()
    } catch (e) {
      setErr((e as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <Modal title="生成链接" onClose={onClose}>
      <div className="form">
        <div className="field">
          <span className="field-label">时长</span>
          <div className="chips">
            {QUICK_HOURS.map((q) => (
              <button
                key={q.hours}
                type="button"
                className={!custom && hours === q.hours ? 'chip chip-on' : 'chip'}
                onClick={() => {
                  setCustom(false)
                  setHours(q.hours)
                }}
              >
                {q.label}
              </button>
            ))}
            <button
              type="button"
              className={custom ? 'chip chip-on' : 'chip'}
              onClick={() => setCustom(true)}
            >
              自定义
            </button>
          </div>
          {custom && (
            <input
              type="number"
              min={1}
              max={720}
              className="input"
              placeholder="小时数（1~720）"
              value={customHours}
              onChange={(e) => setCustomHours(e.target.value)}
            />
          )}
        </div>

        <label className="field">
          <span className="field-label">限速（Mbps）</span>
          <input
            type="number"
            min={0}
            max={100}
            className="input"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
          <span className="field-hint">0 = 不限速；服务器总带宽约 30Mbps</span>
        </label>

        <label className="field">
          <span className="field-label">备注</span>
          <input
            type="text"
            className="input"
            maxLength={200}
            placeholder="给谁用 / 用途（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        {err && <div className="form-error">{err}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? '生成中…' : '生成'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
