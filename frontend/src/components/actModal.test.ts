import { describe, expect, it } from 'vitest'
import { toDateTimeLocal, toEpochMs } from '../components/ActModal'

// ActModal 双模式纯函数（TASK-extend-regions.md 需求 1）：
//   toEpochMs：datetime-local 输入（本地时区）→ epoch ms
//   toDateTimeLocal：epoch ms → datetime-local 可见字符串

describe('toDateTimeLocal', () => {
  it('epoch ms → YYYY-MM-DDTHH:mm（本地时区，无秒）', () => {
    // 用本地时区构造，避免跨时区断言漂移
    const d = new Date(2026, 8, 5, 14, 30, 45)
    expect(toDateTimeLocal(d.getTime())).toBe('2026-09-05T14:30')
  })
})

describe('toEpochMs', () => {
  it('datetime-local → epoch ms（同一时刻往返一致）', () => {
    const d = new Date(2026, 8, 5, 14, 30)
    const local = toDateTimeLocal(d.getTime())
    expect(toEpochMs(local)).toBe(d.getTime())
  })

  it('空串 / 非法 → null', () => {
    expect(toEpochMs('')).toBe(null)
    expect(toEpochMs('not-a-date')).toBe(null)
  })
})
