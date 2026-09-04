# v2link

临时 VLESS 链接生成与分发管理系统——快速生成一条带有效期、限速与流量统计的 `vless://` 链接，扫码/复制即可用，全程在你的管理后台掌控之中。

## 它能做什么

- **一键生成临时链接**：指定时长（1 小时 ~ 30 天）与限速，生成 `vless://` 链接 + 二维码
- **全客户端兼容**：v2rayN / Shadowrocket / Clash / sing-box 等主流客户端开箱即用
- **生命周期管理**：到期自动失效；随时吊销、延长、改速
- **精确流量账本**：每链接上下行流量独立统计（SQLite 持久化，重启不丢）
- **SSO 保护的管理后台**：接入自建认证中心，只有你能管理
- **数据面热管理**：基于 xray 官方管理 API，加删用户**无需重启、不断存量连接**

## 架构

```
客户端 (v2rayN/Shadowrocket/Clash/sing-box)
   │  vless://<uuid>@<your-domain>:443?security=tls&type=ws&path=/v2ws
   ▼
nginx :443  (TLS 终结)
   ├── /v2ws   → xray (VLESS+WS inbound, 出口 freedom 直连)
   ├── /api/*  → 控制面 (Express + SQLite, nginx auth_request SSO 保护)
   └── /       → 前端静态(控制面托管 build 产物)

控制面(Node/TS): SQLite(权威账本) ⇄ xray api CLI (adu/rmu/statsquery 热管理)
   └── 定时器: 过期扫描 15s / 流量账本 30s
```

**数据面**：xray-core（VLESS+WS），多用户由一个 inbound 承载，每个用户 = 一个 UUID/email。
**控制面**：Node/TS + Express + better-sqlite3，通过 `xray api` 子命令（非 gRPC、非 reload）动态加删用户与采集流量。
**账本**：控制面 SQLite 为权威——每 30s 拉取 xray 计数并累计，重启不丢；首拉语义已处理（不重复计停机窗口流量）。

## 快速开始

### 依赖

- Node.js ≥ 20
- [xray-core](https://github.com/XTLS/Xray-core) ≥ 26.3（含 `xray api` 子命令；`xray version` 验证）
- 一个认证中心（`/api/verify?token=` 协议，参考本项目 `deploy/v2link.conf.example` 的 nginx auth_request 探针）

### 1. 数据面：xray

```bash
# xray 配置见 deploy/xray.config.json（监听 127.0.0.1:7895 + 管理 API 127.0.0.1:8081）
# 用 systemd 或你习惯的方式常驻：
xray run -c deploy/xray.config.json
```

### 2. 控制面

```bash
cd server
cp .env.example .env    # 按需修改（端口、xray 地址、认证中心 URL）
npm install
npm run build && npm start
```

### 3. 前端

```bash
cd frontend
cp .env.example .env
npm install && npm run build   # 产物由控制面自动托管（server/../frontend/dist）
```

### 4. nginx

复制 `deploy/v2link.conf.example` 为你的站点配置，替换 `<YOUR_DOMAIN>` / `<AUTH_SERVER_PORT>` 后 `nginx -t && systemctl reload nginx`。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/links` | 全部链接 + 状态 + 上下行流量 |
| POST | `/api/links` | 生成 `{ note?, hours?, speed_mbps? }` |
| POST | `/api/links/:id/revoke` | 吊销（立即从 xray 摘除） |
| POST | `/api/links/:id/extend` | 延长 `{ hours }` |
| POST | `/api/links/:id/speed` | 改速 `{ speed_mbps }` |
| GET | `/api/healthz` | 健康检查（无鉴权） |

全部 API（除 healthz）经 SSO 鉴权：生产环境由 nginx `auth_request` 注入 `X-Auth-User`；直连调试可用 `ENABLE_DEV_TOKEN`（仅限本地，生产务必关闭）。

## 配置（server/.env）

见 `server/.env.example`（含每项注释）。关键项：`XRAY_API`（xray 管理地址）、`XRAY_INBOUND_TAG`、`AUTH_CENTER_VERIFY_URL`、`DEFAULT_HOURS/DEFAULT_SPEED`、`EXPIRE_SCAN_INTERVAL_S/LEDGER_INTERVAL_S`。

## 开发

```bash
npm install          # 根目录 workspaces
npm run dev -w server     # tsx watch
npm run dev -w frontend   # vite
npm test            # vitest 单测（server+frontend）
```

## License

MIT © v2link contributors
