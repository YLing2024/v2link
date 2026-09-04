import { describe, expect, it } from 'vitest'
import { formatBytes, formatDateTime, formatRelative } from './format'

describe('formatBytes', () => {
  it('B 级', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })
  it('KB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
  })
  it('MB', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
  it('GB', () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB')
  })
  it('非法值容错', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(NaN)).toBe('0 B')
  })
})

describe('formatRelative', () => {
  const now = 1_800_000_000_000
  it('刚刚', () => {
    expect(formatRelative(now - 1000, now)).toBe('刚刚')
  })
  it('分钟/小时/天', () => {
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelative(now - 3 * 3600_000, now)).toBe('3 小时前')
    expect(formatRelative(now - 2 * 86400_000, now)).toBe('2 天前')
  })
  it('未来', () => {
    expect(formatRelative(now + 2 * 3600_000, now)).toBe('2 小时后')
  })
})

describe('formatDateTime', () => {
  it('格式 YYYY-MM-DD HH:mm（本地时区）', () => {
    const ts = new Date(2024, 0, 5, 9, 8).getTime()
    expect(formatDateTime(ts)).toBe('2024-01-05 09:08')
  })
})
