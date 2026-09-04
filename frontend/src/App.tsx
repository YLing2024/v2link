import { useEffect, useState } from 'react'
import { captureTokenFromLocation, getToken, redirectToAuth } from './lib/sso'
import Dashboard from './components/Dashboard'

// 顶层：捕获 SSO 回跳 token → 有 token 进主界面；无 token 跳认证中心。
export default function App() {
  const [ready, setReady] = useState(false)
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    const captured = captureTokenFromLocation()
    const has = captured !== null || !!getToken()
    setAuthed(has)
    setReady(true)
    if (!has) {
      // 无凭证：跳认证中心（带回跳当前页）
      redirectToAuth(window.location.href)
    }
  }, [])

  if (!ready) return null
  if (!authed) {
    // 跳转期间的过渡态（redirectToAuth 同步设置 location）
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-logo">v2link</div>
          <p>正在跳转认证中心…</p>
        </div>
      </div>
    )
  }
  return <Dashboard />
}
