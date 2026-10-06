[简体中文](README.md) ｜ [English](README.en.md)

# v2link

临时 VLESS 链接的生成与分发：签发一条带有效期的 `vless://` 链接，扫码或复制即可用，到期自动失效。

## 它能做什么

- 生成 `vless://` 链接与二维码。有效期以绝对到期时刻为主输入（前端 `datetime-local`，默认 now+24h），另有 1h / 6h / 24h / 3d / 7d 快捷档；也可设为永久有效。
- 生命周期：到期由调度器自动吊销；可手动吊销；可编辑到期时刻（延长或提前），限时与永久可互转。
- 流量账本：每链接上下行字节独立累计，SQLite 持久化，重启不丢；每 30s 从 xray 统计接口拉取增量。
- 流量曲线：每 30s 采样写入 `traffic_samples`，保留近 30 天，前端按小时 / 天分桶渲染 SVG 折线。
- 连接追溯：解析 xray access log 的连接建立事件，记录「何时连过哪个目标」，保留 7 天。
- 操作审计：生成 / 吊销 / 延长 / 转永久均留痕，操作人取当前登录身份，缺省 `dev`。
- 地区连通性：每 5 分钟直连美国 / 欧洲 / 日本 / 新加坡的 HTTPS 端点测 RTT，底部状态条按延迟着色。
- 数据面热管理：经 `xray api` 子命令（adu / rmu / statsquery）增删用户与读取计数，不 reload、不断存量连接。
- 兼容 v2rayN、Shadowrocket、Clash、sing-box 等标准 `vless://` + WebSocket 客户端。

## 架构

```text
客户端 ── vless://<uuid>@<host>:443?encryption=none&security=tls&type=ws&path=/v2ws ──▶ nginx（TLS 终结）
   ├── /v2ws  → xray  127.0.0.1:7895（VLESS + WS inbound，出口 freedom 直连）
   ├── /api/  → 控制面 127.0.0.1:7897（builtin）或 Auth Gateway（sso，见「认证与安全」）
   └── /      → 前端静态（控制面用 express.static 托管 frontend/dist）

控制面（Node/TS）: SQLite 权威账本 ⇄ xray api（adu / rmu / statsquery）
  定时器: 过期扫描 15s / 流量账本与采样 30s / xray 一致性同步 60s / 连接清理 1h / 采样清理 1d / 地区探测 5min
  access log 采集: ACCESS_LOG_PATH → connections（2s 轮询，处理 copytruncate 与文件重建）
```

- 数据面：xray-core，一个 VLESS + WS inbound 承载多用户，每个用户一个 UUID，email 作为账本主键。
- 控制面：Node/TS + Express + better-sqlite3，经 `xray api` 子命令动态管理用户，零 gRPC、零 reload。
- 一致性：写操作先落 SQLite，再调 xray；xray 失败则回滚 SQLite 并返回 502（create / revoke）。
- 账本：每 30s 拉取 xray 计数器增量并累计；进程启动后首拉只读不 reset，避免漏计停机窗口流量。

## 监控 / 追溯 / 审计

| 层 | 数据源 | 落库 | 保留 | 前端 |
|---|---|---|---|---|
| A 流量曲线 | 30s statsquery 增量 | `traffic_samples` | 30 天滚动 | 链接详情 → 流量趋势 |
| B 连接追溯 | xray access log（仅连接建立事件） | `connections` | 7 天滚动 | 链接详情 → 连接记录 |
| C 操作审计 | linkService 写操作 | `audit_log` | 不裁剪 | 顶部「审计」 |

xray access log 是纯文本，每连接一行，只有连接建立事件、没有字节数：`connections` 的 up/down/duration 恒为空，流量以 `traffic_samples` 为准。日志含 `email` 字段可关联 links，库中无匹配时 `link_id` 为空、仅记 email。轮转由系统 logrotate 负责（`deploy/xray-logrotate`，保留 7 天）。

## 快速开始

依赖：Node.js ≥ 20、xray-core（含 `xray api` 子命令）。

```bash
# 1. 数据面：xray（见 deploy/xray.config.json，监听 127.0.0.1:7895，管理 API 127.0.0.1:8081）
mkdir -p /var/log/xray
xray run -c deploy/xray.config.json
cp deploy/xray-logrotate /etc/logrotate.d/xray-access   # access log 轮转（保留 7 天）
# 2. 控制面 + 前端（根目录 npm workspaces）
npm install
cp server/.env.example server/.env       # 端口、xray 地址、认证模式等
npm run build                            # server tsc + frontend vite build
npm start                                # node server/dist/index.js，监听 127.0.0.1:7897
```

前端构建产物在 `frontend/dist`，由控制面托管，无需单独部署。

## 配置

`server/.env`（模板与注释见 `server/.env.example`）：

| 名称 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `7897` | 控制面监听端口 |
| `HOST` | `127.0.0.1` | 监听地址，生产由 nginx 反代 |
| `XRAY_API` | `127.0.0.1:8081` | xray 管理 API 地址 |
| `XRAY_BIN` | `xray` | xray 可执行文件 |
| `XRAY_INBOUND_TAG` | `vless-in` | 受管 inbound 的 tag |
| `XRAY_API_TIMEOUT_S` | `3` | 单次 xray api 调用超时（秒） |
| `XRAY_API_RETRIES` | `2` | 调用失败重试次数（指数退避） |
| `DEFAULT_HOURS` | `24` | 未指定有效期时的默认时长（小时） |
| `MAX_HOURS` | `720` | `hours` 档上限（小时） |
| `EXPIRE_SCAN_INTERVAL_S` | `15` | 过期扫描周期（秒） |
| `LEDGER_INTERVAL_S` | `30` | 流量账本与采样周期（秒） |
| `XRAY_RECONCILE_INTERVAL_S` | `60` | xray 用户与账本一致性同步周期（秒）；`0` 表示只在启动时同步一次、不做周期自愈 |
| `ACCESS_LOG_PATH` | `/var/log/xray/access.log` | xray access log 路径 |
| `CONN_RETENTION_S` | `604800` | `connections` 保留秒数（7 天），清理周期 `CONN_CLEANUP_INTERVAL_S=3600` |
| `SAMPLE_RETENTION_S` | `2592000` | `traffic_samples` 保留秒数（30 天），清理周期 `SAMPLE_CLEANUP_INTERVAL_S=86400` |
| `REGION_PROBE_INTERVAL_S` | `300` | 地区探测周期（秒，最小 60） |
| `REGION_PROBES` | 空 | 地区端点 JSON 覆盖；留空用内置美国 / 欧洲 / 日本 / 新加坡 |
| `DB_PATH` | `server/data/v2link.db` | SQLite 文件路径（`data/` 已 gitignore） |
| `AUTH_MODE` | `builtin` | `builtin` 自带账号 / `sso` 只认 `X-Auth-User` |
| `V2LINK_ADMIN_USER` | `admin` | 首次启动创建的管理员用户名 |
| `V2LINK_ADMIN_PASSWORD` | 空 | 留空则首次启动随机生成并只打印一次 |
| `SESSION_TTL_HOURS` | `12` | 会话有效期（小时，命中滑动续期） |
| `TRUST_PROXY` | `loopback` | Express trust proxy，反代下用于登录限速取真实 IP |

`frontend/.env`（构建时注入，模板见 `frontend/.env.example`）：

| 名称 | 默认值 | 说明 |
|---|---|---|
| `VITE_API_PROXY_TARGET` | `http://127.0.0.1:7897` | dev server 的 `/api` 代理目标 |
| `VITE_PUBLIC_HOST` | `v2.example.com` | 生成链接的主机名（地址，可为 IP） |
| `VITE_PUBLIC_SNI` | 空（回退 `VITE_PUBLIC_HOST`） | 生成链接的 TLS SNI / WS Host（域名）；地址用 IP 时单独填写 |
| `VITE_PUBLIC_PATH` | `/v2ws` | 生成链接的 WebSocket 路径 |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/links` | 全部链接 + 状态 + 上下行流量 |
| POST | `/api/links` | 生成链接，body `{ note?, alias?, expiresAt?, hours?, permanent? }`（后三者互斥） |
| POST | `/api/links/:id/revoke` | 吊销（从 xray 摘除用户，写审计） |
| POST | `/api/links/:id/extend` | 三选一 `{ hours }` / `{ expiresAt }`（epoch ms）/ `{ permanent: true }` |
| GET | `/api/links/:id/traffic?from=&to=&bucket=hour\|day` | 流量曲线分桶（默认近 24h、hour 桶） |
| GET | `/api/links/:id/connections?q=&from=&to=&limit=&offset=` | 连接记录分页（`q` 为 host 前缀搜索） |
| GET | `/api/audit?limit=&offset=` | 操作审计分页 |
| GET | `/api/regions/probes` | 地区连通性快照 + 最近 12 轮历史（内存态） |
| GET | `/api/healthz` | 健康检查（无鉴权） |
| GET | `/api/auth-mode` | 当前认证模式（无鉴权） |
| POST | `/api/auth/login` | builtin：校验口令、下发会话 cookie（按 IP 限速） |
| POST | `/api/auth/logout` | builtin：删除会话（幂等） |
| GET | `/api/auth/me` | builtin：返回当前用户名，未登录 401 |

`expiresAt` 须为 epoch 毫秒整数，晚于当前时刻且不超过未来 365 天；`extend` 的 `{ expiresAt }` 允许提前缩短有效期，永久链接没有基准时刻，转限时只能用 `expiresAt`。

## 认证与安全

- `builtin`（默认）：控制面自带账号。口令以 `node:crypto` scrypt 哈希入库（`scrypt$<salt>$<hash>`，只存哈希）；登录成功下发 HttpOnly cookie `v2link_session`，请求也接受 `Authorization: Bearer <token>`；会话默认 12 小时并滑动续期；同一 IP 15 分钟内失败 10 次后返回 429（内存计数，重启清零）。
- `sso`：关闭自带口令，身份只认前置认证注入的 `X-Auth-User`；`/api/auth/login|logout|me` 一律 404。两种模式下凭证缺失均返回 401，不 302、不 500。
- 首次启动（users 表为空）按 `V2LINK_ADMIN_USER` 创建管理员；未提供口令时随机生成并只打印一次。
- 免鉴权路径：`/`、`/v2ws`、`/api/healthz`、`/api/auth-mode`。
- 私有信息零硬编码：域名经 `VITE_*` 构建注入与 nginx 配置，口令只存 `.env`（已 gitignore）。日志与审计不额外输出完整 `vless://` 链接。

## 部署

- 构建：`npm run build`，产物为 `server/dist`（控制面）与 `frontend/dist`（前端静态）。
- systemd：控制面 `v2link.service`、数据面 `xray.service`（单元文件不在本仓库）。改控制面后 `systemctl restart v2link`；仅改 `deploy/xray.config.json` 时才需 `systemctl restart xray`。
- nginx：以 `deploy/v2link.conf.example` 为模板（示例为 sso 部署，`/api/` 与 `/_auth/` 转 Auth Gateway；用 `builtin` 时把 `/api/` 直连控制面）。`/v2ws` 转 xray，`/` 转控制面静态，`server_name` 用占位符替换；配置中不再有 `auth_request` / `/auth-check`。
- 数据面：`deploy/xray.config.json` 提供 access / error log 与 `api.listen`；日志轮转见 `deploy/xray-logrotate`。

## 开发

```bash
npm install
npm run dev            # concurrently: server（tsx watch）+ frontend（vite）
npm test               # vitest（server + frontend）
npm run typecheck
npm run build
npm run lint           # / npm run format
```

单独跑某个包：`npm run dev -w server`、`npm run dev -w frontend`。

## 许可证

MIT，见 `LICENSE`。
