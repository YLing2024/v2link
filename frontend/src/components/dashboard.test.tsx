import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Dashboard 多选：未选禁用、勾选计数、全选/清空、生成订阅按勾选顺序传 linkIds。

const { listLinksMock, createClashSubscriptionMock } = vi.hoisted(() => ({
  listLinksMock: vi.fn(),
  createClashSubscriptionMock: vi.fn(),
}))

vi.mock('../api', () => ({
  listLinks: listLinksMock,
  logout: vi.fn(),
  revokeLink: vi.fn(),
  createLink: vi.fn(),
  extendLink: vi.fn(),
  linkTraffic: vi.fn(),
  linkConnections: vi.fn(),
  auditLog: vi.fn(),
  createClashSubscription: createClashSubscriptionMock,
  regionProbes: vi.fn(async () => ({ updatedAt: 0, probes: [], history: [] })),
}))
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,AAA') },
}))

import Dashboard from './Dashboard'
import type { ClashSubResult, Link } from '../types'

function link(id: string, note: string): Link {
  return {
    id,
    uuid: `uuid-${id}`,
    note,
    alias: '',
    upBytes: 0,
    downBytes: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    permanent: false,
    revokedAt: null,
    status: 'active',
  }
}

function subResult(): ClashSubResult {
  return {
    token: 'tok',
    url: 'https://v2.example.com/api/clash/subscriptions/tok',
    importUrl: 'clash://install-config?url=x&name=v2link',
    expiresAt: Date.now() + 600_000,
    ttlSeconds: 600,
    count: 2,
    skipped: [],
    nodes: [],
  }
}

beforeEach(() => {
  listLinksMock.mockReset()
  createClashSubscriptionMock.mockReset()
})

describe('Dashboard 多选 → Clash 订阅', () => {
  it('未选时按钮禁用；勾选/全选/清空更新计数', async () => {
    listLinksMock.mockResolvedValue([link('lk_a', '节点甲'), link('lk_b', '节点乙')])
    render(<Dashboard />)
    await screen.findByText('节点甲')

    const gen = screen.getByRole('button', { name: '生成 Clash 订阅' })
    expect(gen).toBeDisabled()
    expect(screen.getByText('已选 0 项')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('选择 节点甲'))
    expect(screen.getByText('已选 1 项')).toBeInTheDocument()
    expect(gen).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(screen.getByText('已选 2 项')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(screen.getByText('已选 0 项')).toBeInTheDocument()
    expect(gen).toBeDisabled()
  })

  it('生成订阅按勾选顺序传 linkIds', async () => {
    listLinksMock.mockResolvedValue([link('lk_a', '节点甲'), link('lk_b', '节点乙')])
    createClashSubscriptionMock.mockResolvedValue(subResult())
    render(<Dashboard />)
    await screen.findByText('节点甲')

    fireEvent.click(screen.getByLabelText('选择 节点乙'))
    fireEvent.click(screen.getByLabelText('选择 节点甲'))
    fireEvent.click(screen.getByRole('button', { name: '生成 Clash 订阅' }))
    await waitFor(() =>
      expect(createClashSubscriptionMock).toHaveBeenCalledWith(['lk_b', 'lk_a']),
    )
  })
})
