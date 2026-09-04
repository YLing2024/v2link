import { useEffect, useRef } from 'react'

// 通用 Modal：Esc/遮罩关闭；内容区滚动
export default function Modal({
  title,
  onClose,
  children,
  width = 420,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === ref.current && onClose()}>
      <div className="modal" ref={ref} style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
