import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// 「生成链接」弹窗：默认按 hours 提交；选「永久」后按 permanent 提交（用户 2026-09-14 需求）。
// 断言落在 API 调用参数上（组件行为契约），不依赖后端。
const { createLinkMock } = vi.hoisted(() => ({
  createLinkMock: vi.fn((_body: Record<string, unknown>) => Promise.resolve({} as never)),
}))
vi.mock('../api', () => ({ createLink: createLinkMock }))

import { CreateModal } from './CreateModal'

function setup() {
  const onCreated = vi.fn()
  const onClose = vi.fn()
  render(<CreateModal onClose={onClose} onCreated={onCreated} />)
  return { onCreated, onClose }
}

describe('CreateModal', () => {
  it('默认提交 hours=24', async () => {
    createLinkMock.mockClear()
    const { onCreated } = setup()
    fireEvent.click(screen.getByText('生成'))
    await waitFor(() => expect(createLinkMock).toHaveBeenCalledTimes(1))
    expect(createLinkMock.mock.calls[0]![0]).toMatchObject({ hours: 24 })
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
  })

  it('选「永久」→ 提交 permanent: true（不带 hours）', async () => {
    createLinkMock.mockClear()
    const { onCreated } = setup()
    fireEvent.click(screen.getByText('永久'))
    expect(screen.getByText(/永久链接不会自动过期/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('生成'))
    await waitFor(() => expect(createLinkMock).toHaveBeenCalledTimes(1))
    const body = createLinkMock.mock.calls[0]![0] as Record<string, unknown>
    expect(body.permanent).toBe(true)
    expect(body.hours).toBeUndefined()
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
  })

  it('从「永久」切回小时档 → 恢复按 hours 提交', async () => {
    createLinkMock.mockClear()
    setup()
    fireEvent.click(screen.getByText('永久'))
    fireEvent.click(screen.getByText('1h'))
    fireEvent.click(screen.getByText('生成'))
    await waitFor(() => expect(createLinkMock).toHaveBeenCalledTimes(1))
    const body = createLinkMock.mock.calls[0]![0] as Record<string, unknown>
    expect(body.hours).toBe(1)
    expect(body.permanent).toBeUndefined()
  })
})
