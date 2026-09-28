import Dashboard from './components/Dashboard'

// 登录由 Auth Gateway 负责：页面（/、/v2ws）公开，直接渲染；
// 只有 /api/* 需要登录，未登录时由统一 client 整页跳 /_auth/login。
export default function App() {
  return <Dashboard />
}
