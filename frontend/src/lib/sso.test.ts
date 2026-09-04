import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TOKEN_KEY,
  buildAuthRedirect,
  captureTokenFromLocation,
  clearToken,
  extractToken,
  getToken,
  saveToken,
} from './sso'

// 内存 storage 注入（不触碰真实 localStorage）
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

describe('extractToken', () => {
  it('从 query ?token= 提取', () => {
    expect(extractToken('?token=abc123', '')).toBe('abc123')
  })

  it('从 fragment #token= 提取并 decode', () => {
    expect(extractToken('', '#token=a%2Fb')).toBe('a/b')
  })

  it('无 token → null', () => {
    expect(extractToken('', '')).toBeNull()
  })
})

describe('token 存取', () => {
  it('get/set/clear', () => {
    const s = memoryStorage()
    expect(getToken(s)).toBe('')
    saveToken('t1', s)
    expect(getToken(s)).toBe('t1')
    clearToken(s)
    expect(getToken(s)).toBe('')
  })
})

describe('captureTokenFromLocation', () => {
  it('捕获并存储、清地址栏 token', () => {
    const s = memoryStorage()
    const replaceState = vi.fn()
    vi.stubGlobal('history', { replaceState })
    const loc = { search: '?token=xyz', hash: '', pathname: '/app' }
    const captured = captureTokenFromLocation(loc, s)
    expect(captured).toBe('xyz')
    expect(getToken(s)).toBe('xyz')
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app')
    vi.unstubAllGlobals()
  })

  it('无 token → null 且不存储', () => {
    const s = memoryStorage()
    const captured = captureTokenFromLocation({ search: '', hash: '', pathname: '/app' }, s)
    expect(captured).toBeNull()
    expect(getToken(s)).toBe('')
  })
})

describe('buildAuthRedirect', () => {
  it('带回跳', () => {
    expect(buildAuthRedirect('https://x.example.com/a', 'https://auth.example.com/auth')).toBe(
      'https://auth.example.com/auth?redirect=https%3A%2F%2Fx.example.com%2Fa',
    )
  })
})

describe('TOKEN_KEY 与 localStorage 集成', () => {
  beforeEach(() => localStorage.clear())

  it('默认 storage = localStorage', () => {
    saveToken('real')
    expect(localStorage.getItem(TOKEN_KEY)).toBe('real')
    expect(getToken()).toBe('real')
  })
})
