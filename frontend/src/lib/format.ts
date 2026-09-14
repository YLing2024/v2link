// 展示格式化工具（人类可读流量/时间）

// 字节 → KB/MB/GB（二进制 1024 进制，保留一位小数）
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

const DAY = 24 * 3600 * 1000

// 相对时间（中文）：刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期
export function formatRelative(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts)) return '—'
  const diff = ts - now
  const abs = Math.abs(diff)
  if (abs < 60_000) return '刚刚'
  if (abs < 3600_000) return `${Math.floor(abs / 60_000)} 分钟${diff >= 0 ? '后' : '前'}`
  if (abs < DAY) return `${Math.floor(abs / 3600_000)} 小时${diff >= 0 ? '后' : '前'}`
  if (abs < 30 * DAY) return `${Math.floor(abs / DAY)} 天${diff >= 0 ? '后' : '前'}`
  return formatDateTime(ts)
}

// epoch ms → 本地日期时间字符串 YYYY-MM-DD HH:mm
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 永久链接哨兵值：expires_at === 0（与后端 lib/expiry.ts 对应） */
export const PERMANENT_EXPIRES_AT = 0

export function isPermanentExpiry(ts: number): boolean {
  return ts === PERMANENT_EXPIRES_AT
}

/** 到期展示：永久 → 「永久」，否则本地日期时间 */
export function formatExpiry(ts: number): string {
  return isPermanentExpiry(ts) ? '永久' : formatDateTime(ts)
}
