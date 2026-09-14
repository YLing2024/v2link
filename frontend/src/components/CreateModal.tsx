import { useMemo, useState } from 'react'
import { createLink } from '../api'
import Modal from './Modal'
import { defaultExpiry, toDateTimeLocal, toEpochMs } from '../lib/datetime'
import { humanDuration } from '../lib/format'

// 「生成链接」弹窗：**过期时刻（分钟精度）是唯一输入**；小时档只是「一键把时刻设到此刻 + N」的便捷键，
// 选定后仍可在日期框里手改。剩余时长以提示形式在旁边显示（用户 2026-09-14 反馈）。
// 需求 §6：时长快捷 1h/6h/24h/3d/7d + 自定义 hours；用户 2026-09-14 追加「永久有效」档位。

export const QUICK_EXPIRY: { label: string; hours: number }[] = [
  { label: '1 小时', hours: 1 },
  { label: '6 小时', hours: 6 },
  { label: '24 小时', hours: 24 },
  { label: '3 天', hours: 72 },
  { label: '7 天', hours: 168 },
]

/** 绝对时刻上限（与后端 MAX_EXPIRE_ABS_DAYS 一致） */
const MAX_EXPIRE_DAYS = 365

export function CreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [expiryInput, setExpiryInput] = useState(() => toDateTimeLocal(defaultExpiry()))
  // 高亮的便捷档（手改时刻后清空）——唯一状态，避免和输入框内容互相推导
  const [quickHours, setQuickHours] = useState<number | null>(24)
  const [permanent, setPermanent] = useState(false)
  const [note, setNote] = useState('')
  const [alias, setAlias] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const expiryMs = toEpochMs(expiryInput)

  const hint = useMemo(() => {
    if (permanent) return '永久链接不会自动过期，需手动吊销。'
    if (expiryMs === null) return ''
    const diff = expiryMs - Date.now()
    if (diff <= 0) return '该时刻已过去，请选择未来时间'
    if (diff > MAX_EXPIRE_DAYS * 24 * 3600 * 1000) return `不能超过 ${MAX_EXPIRE_DAYS} 天`
    return `距现在约 ${humanDuration(diff)}`
  }, [expiryMs, permanent])

  function pickQuick(hours: number) {
    setPermanent(false)
    setQuickHours(hours)
    setExpiryInput(toDateTimeLocal(Date.now() + hours * 3600 * 1000))
  }

  async function submit() {
    setErr('')
    let expiresAt: number | undefined
    if (!permanent) {
      const ms = toEpochMs(expiryInput)
      if (ms === null) {
        setErr('请选择过期时间')
        return
      }
      if (ms <= Date.now()) {
        setErr('过期时间须晚于当前时间')
        return
      }
      if (ms - Date.now() > MAX_EXPIRE_DAYS * 24 * 3600 * 1000) {
        setErr(`过期时间不能超过 ${MAX_EXPIRE_DAYS} 天`)
        return
      }
      expiresAt = ms
    }
    setSubmitting(true)
    try {
      await createLink(
        permanent
          ? { note: note || undefined, alias: alias || undefined, permanent: true }
          : { note: note || undefined, alias: alias || undefined, expiresAt },
      )
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
          <span className="field-label">过期时间</span>
          <div className="chips">
            {QUICK_EXPIRY.map((q) => (
              <button
                key={q.hours}
                type="button"
                className={!permanent && quickHours === q.hours ? 'chip chip-on' : 'chip'}
                onClick={() => pickQuick(q.hours)}
              >
                {q.label}
              </button>
            ))}
            <button
              type="button"
              className={permanent ? 'chip chip-on' : 'chip'}
              onClick={() => setPermanent(true)}
            >
              永久
            </button>
          </div>
          {!permanent && (
            <input
              type="datetime-local"
              className="input"
              value={expiryInput}
              onChange={(e) => {
                setExpiryInput(e.target.value)
                setQuickHours(null)
              }}
            />
          )}
          {hint && <span className="field-hint">{hint}</span>}
        </div>

        <label className="field">
          <span className="field-label">别名</span>
          <input
            type="text"
            className="input"
            maxLength={100}
            placeholder="客户端里显示的节点名（留空用备注）"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          />
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
