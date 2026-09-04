import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import Modal from './Modal'
import { vlessLink } from '../lib/vless'

// 复制链接 & 二维码弹窗（点「复制」也顺带展示二维码便于扫码）
export function CopyModal({ uuid, onClose }: { uuid: string; onClose: () => void }) {
  const uri = vlessLink(uuid)
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    QRCode.toDataURL(uri, { margin: 1, width: 260 })
      .then((url) => setQr(url))
      .catch(() => setQr(''))
  }, [uri])

  async function copy() {
    try {
      await navigator.clipboard.writeText(uri)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用（非 https 等）：回退提示手动复制
      window.prompt('复制链接', uri)
    }
  }

  return (
    <Modal title="链接详情" onClose={onClose} width={340}>
      <div className="qr-wrap">
        {qr ? <img src={qr} alt="二维码" className="qr" /> : <div className="qr qr-empty">…</div>}
        <div className="vless-uri">{uri}</div>
        <button type="button" className="btn btn-primary btn-block" onClick={copy}>
          {copied ? '已复制' : '复制链接'}
        </button>
      </div>
    </Modal>
  )
}
