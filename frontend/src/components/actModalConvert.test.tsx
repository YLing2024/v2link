import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Link } from '../types'

// 延长弹窗的双向转换（用户 2026-09-14 需求 ②）：
//   · 限时链接 → 「转为永久」提交 { permanent: true }（二次 confirm）
//   · 永久链接 → 只给「绝对」模式（选到期时刻 = 转限时），不提供相对/转永久
const { extendLinkMock } = vi.hoisted(() => ({
  extendLinkMock: vi.fn((_id: string, _body: Record<string, unknown>) => Promise.resolve({} as never)),
}))
vi.mock('../api', () => ({ extendLink: extendLinkMock }))

import { ActModal } from './ActModal'

function makeLink(over: Partial<Link> = {}): Link {
  return {
    id: 'lk_test',
    uuid: '00000000-0000-0000-0000-000000000000',
    note: '',
    upBytes: 0,
    downBytes: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    permanent: false,
    revokedAt: null,
    status: 'active',
    ...over,
  }
}

function setup(link: Link) {
  const onDone = vi.fn()
  const onClose = vi.fn()
  render(<ActModal link={link} onClose={onClose} onDone={onDone} />)
  return { onDone, onClose }
}

const chipLabels = () =>
  [...document.querySelectorAll('.modal .chip')].map((c) => c.textContent?.trim())

describe('ActModal 限时 → 永久', () => {
  it('提供三种方式，选「转为永久」确认后提交 permanent: true', async () => {
    extendLinkMock.mockClear()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    setup(makeLink())
    expect(chipLabels()).toEqual(['相对', '绝对', '转为永久'])

    fireEvent.click(screen.getByText('转为永久'))
    expect(screen.getByText(/转为永久后不再自动过期/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('确定'))
    await waitFor(() => expect(extendLinkMock).toHaveBeenCalledTimes(1))
    expect(extendLinkMock.mock.calls[0]![1]).toMatchObject({ permanent: true })
  })

  it('confirm 取消 → 不提交', async () => {
    extendLinkMock.mockClear()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    setup(makeLink())
    fireEvent.click(screen.getByText('转为永久'))
    fireEvent.click(screen.getByText('确定'))
    await new Promise((r) => setTimeout(r, 30))
    expect(extendLinkMock).not.toHaveBeenCalled()
  })
})

describe('ActModal 永久 → 限时', () => {
  it('永久链接只有「绝对」方式，并提示当前为永久', () => {
    setup(makeLink({ permanent: true, expiresAt: 0 }))
    expect(chipLabels()).toEqual(['绝对'])
    expect(screen.getByText(/当前为永久有效/)).toBeInTheDocument()
    expect(screen.queryByText('转为永久')).toBeNull()
  })

  it('选到期时刻提交 → { expiresAt }（转限时）', async () => {
    extendLinkMock.mockClear()
    setup(makeLink({ permanent: true, expiresAt: 0 }))
    const input = document.querySelector('.modal input[type="datetime-local"]') as HTMLInputElement
    const future = new Date(Date.now() + 3 * 3600_000)
    const p = (x: number) => String(x).padStart(2, '0')
    const local = `${future.getFullYear()}-${p(future.getMonth() + 1)}-${p(future.getDate())}T${p(future.getHours())}:${p(future.getMinutes())}`
    fireEvent.change(input, { target: { value: local } })
    fireEvent.click(screen.getByText('确定'))
    await waitFor(() => expect(extendLinkMock).toHaveBeenCalledTimes(1))
    const body = extendLinkMock.mock.calls[0]![1] as Record<string, unknown>
    expect(typeof body.expiresAt).toBe('number')
    expect(body.permanent).toBeUndefined()
  })
})
