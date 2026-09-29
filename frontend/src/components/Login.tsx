import { useEffect, useState } from 'react'
import { ApiError, login } from '../api'

// 本地登录页（AUTH_MODE=builtin）：账号 + 口令 → 本地会话。
// 跟随 styles/style.css 设计令牌（Swiss、直角、发丝线、单琥珀点缀）。
export default function Login({ onSuccess }: { onSuccess: (name: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown((s) => (s > 0 ? s - 1 : 0)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (loading || cooldown > 0) return
    setError('')
    setLoading(true)
    try {
      const user = await login(username.trim(), password)
      onSuccess(user.name)
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setCooldown(err.retryAfter && err.retryAfter > 0 ? err.retryAfter : 60)
        setError('尝试过于频繁')
      } else {
        setError((err as Error).message || '登录失败')
      }
    } finally {
      setLoading(false)
    }
  }

  const blocked = loading || cooldown > 0

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">v2link</div>
        <div>临时 VLESS 链接</div>
        <form className="login-form" onSubmit={submit}>
          {error && (
            <div className="form-error">
              {cooldown > 0 ? `尝试过于频繁，请 ${cooldown} 秒后再试` : error}
            </div>
          )}
          <label className="field">
            <span className="field-label">账号</span>
            <input
              className="input"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={blocked}
            />
          </label>
          <label className="field">
            <span className="field-label">口令</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={blocked}
            />
          </label>
          <button
            className="btn btn-primary btn-block"
            type="submit"
            disabled={blocked || !username.trim() || !password}
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  )
}
