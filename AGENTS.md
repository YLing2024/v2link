# AGENTS.md — v2link（临时 VLESS 链接管理系统）

> AI 编码代理进入本仓库先读本文件。README.md 与 REQUIREMENTS.md 是面向人的文档；冲突时以本文件为准。

## 这个项目是什么

临时 VLESS 链接的生成与分发管理：一键生成带有效期的 `vless://` 链接（二维码/复制即用），到期自动失效，可吊销/延长，带流量账本、连接追溯、操作审计和底部全球连通性监控。

**控制面 / 数据面分离**：

| 层 | 技术 | 位置 |
|---|---|---|
| 控制面 | Node 24 + TS + Express 4 + SQLite（better-sqlite3） | `127.0.0.1:7897`，systemd `v2link.service` |
| 数据面 | xray-core（VLESS + WS inbound，官方 gRPC API 热管理） | `127.0.0.1:7895`，systemd `xray.service` |
| 前端 | React 18 + Vite + TS | 构建到 `frontend/dist`，由控制面 `express.static` 托管 |

对外：`v2.<自建域名>`（nginx `/v2ws` → xray，`/api/` → 控制面走 SSO 探针，`/` → 静态前端）。

## 目录结构

```
server/src/
├── app.ts / index.ts / config.ts / types.ts
├── db/{connection,init,linksRepo,monitoringRepo}.ts
├── lib/{vless,id,expiry,xrayStats,accessLogParse,accessLogTailer,trafficAgg}.ts
├── middleware/auth.ts
├── routes/{links,health,regions,audit}.ts
├── services/{linkService,xrayClient,scheduler,regionProbe}.ts
└── __tests__/                      # vitest 用例（server 12 个 + frontend 8 个测试文件）
frontend/src/
├── api.ts / App.tsx / types.ts
├── lib/{sso,vless,format,datetime,trafficChart,regionProbe}.ts
├── components/{Dashboard,CreateModal,CopyModal,ActModal,LinkDetailModal,AuditModal,TrafficChart,RegionProbeBar,Modal}.tsx
└── styles/style.css                # 唯一 CSS（设计令牌 + 全站）
deploy/
├── xray.config.json                # xray 侧配置（api.listen 127.0.0.1:8081）
├── v2link.conf(.example)           # nginx 参考配置
└── xray-logrotate                  # access log 轮转（保留 7 天）
```

## 命令

```bash
npm install                # 根 workspaces
npm run dev                # concurrently：server(tsx watch) + frontend(vite)
npm run build              # server tsc + frontend tsc -b && vite build
npm start                  # node server/dist/index.js
npm test                   # vitest（server + frontend）
npm run typecheck / lint / format
```

**改完必须跑：`npm test` + `npm run typecheck` + `npm run build`。**

## 部署

```bash
npm run build
systemctl restart v2link        # 控制面
systemctl restart xray          # 只在改 deploy/xray.config.json 时需要
```

- nginx：`v2.<自建域名>`（`deploy/v2link.conf` 是参考），`/api/` 走 `auth_request` 探针 → 认证中心 `127.0.0.1:3200/api/verify`。
- xray access log → `/var/log/xray/access.log`，轮转见 `deploy/xray-logrotate`（与控制面 7 天保留期对齐）。
- 若配置了镜像域名，改 nginx 时几个域名体系要同步。

## 环境变量

真实值只存 `server/.env` / `frontend/.env`（均被 `.gitignore` 拦截），仓库只提交 `.env.example`。

**server**：`PORT`(7897)、`HOST`(127.0.0.1)、`XRAY_API`(127.0.0.1:8081)、`XRAY_BIN`、`XRAY_INBOUND_TAG`(vless-in)、`XRAY_API_TIMEOUT_S`、`XRAY_API_RETRIES`、`DEFAULT_HOURS`(24)、`MAX_HOURS`(720)、`EXPIRE_SCAN_INTERVAL_S`(15)、`LEDGER_INTERVAL_S`(30)、`ACCESS_LOG_PATH`、`CONN_RETENTION_S`(7 天)、`SAMPLE_RETENTION_S`(30 天)、`REGION_PROBE_INTERVAL_S`(300)、`AUTH_CENTER_VERIFY_URL`、`DB_PATH`。

**frontend**（构建时注入）：`VITE_AUTH_CENTER_URL`、`VITE_API_PROXY_TARGET`、`VITE_PUBLIC_HOST`、`VITE_PUBLIC_PATH`。

## 架构要点

- **热管理**：加删用户走 xray 官方 `xray api adu/rmu`，**不 reload、不断存量连接**。`xrayClient.ts` 封装调用（超时 + 重试退避）。
- **调度器**（`scheduler.ts`）：过期扫描（15s）、流量账本累计（30s）、连接/采样清理、地区探测（300s）。新增定时任务挂在这里，别在 `index.ts` 里裸起 `setInterval`。
- **连接追溯**：`accessLogTailer` 增量读 xray access log → `accessLogParse` 解析 → 写 `connections` 表（默认保留 7 天）。
- **流量曲线**：每 30s 采样写 `traffic_samples`（保留 30 天），前端 `TrafficChart` 用轻量 SVG 渲染，`trafficChart.ts` 是纯函数（有单测）。
- **鉴权**：生产主路径 = 信任 nginx 探针注入的 `X-Auth-User`；`AUTH_CENTER_VERIFY_URL` 仅用于无探针的直连场景（两层都配则任一通过）。

## 安全与仓库红线

- 私有地址（真实部署域名、服务器 IP、认证中心域名）**不得硬编码**：前端走 `VITE_*` 构建时注入，后端走 `.env`；缺省值只能是占位（`v2.example.com` / `auth.example.com`）。
- `.env`、`data/`（SQLite 账本含真实 UUID 与流量）、`dist/`、`*.log` 一律不入库。
- 推送到公开仓库前自检：`grep -rn "<你的域名>\|<你的公网IP>\|vless://" --exclude-dir=node_modules src */src` 不应命中真实值。
- 生成的 `vless://` 链接含 UUID，日志与审计里不要额外泄漏完整链接。

## 设计系统（与 homepage / admin-web / quotahub 同一套）

```
--bg #f7f6f3  --surface #fbfaf8  --fg #171512  --muted #6f6a63  --accent #a05b0c
--danger #dc2626  --ok #15803d  --warn #d97706（+ 各自的 -soft / -border）
深色 --bg #13110f；--radius 0（全站直角）；发丝线 --border rgba(23,21,18,.16)
字体 Inter Tight / Inter / JetBrains Mono（frontend/public/fonts 自托管）
```

- 折线图颜色走 CSS 类（`chart-line-down/up`、`chart-area`），**不要写回 TS 常量**——写死会破深浅色。
- 文案唯美克制，**禁 emoji / 鸡汤 / 网络热词**。

## 已知坑

- **xray 是外部依赖**：控制面调 `xray api` 失败时不要吞异常（链路里每个 failure 都要有可观测路径），否则会静默丢用户。
- 地区探测是 **HTTP 探测**（不是 ICMP），走服务器本机出口；出站被墙的端点会显示超时，属预期。
- `db/init.ts` 负责建表/迁移，改 schema 要在这里加迁移，别假设旧库会自动升级。
- 前端 dev 需要后端在 7897；`/api` 代理目标由 `VITE_API_PROXY_TARGET` 控制。
- 账号流量统计来自 xray 的 stats API，采样周期与账本周期不同步时曲线会有台阶，属正常。

## 项目记忆（PROJECT_MEMORY.md · 自迭代 · 不入库）

仓库根目录的 `PROJECT_MEMORY.md` 是**只存在于本机的项目记忆**，跨会话累积。与本文档分工：**AGENTS.md 记「当前事实与铁律」，PROJECT_MEMORY.md 记「过程与理由」**。

**它自迭代——你随时可以写进去，不必请示，也不需要用户批准：**

- 用户/维护者在本项目新立的规矩（命名、文案口径、设计令牌、流程约束）
- 排查确认的结论与有效验证命令（「这个报错其实是 X 导致的」）
- 决策背景：为什么选 A 不选 B、哪个方案被否决过及原因
- AGENTS.md 里没有、但下次会省时间的一切

**约束：**

- 已在 `.gitignore` 中忽略，**不提交、不推送**（`git status` 里也不该出现）。因此可以放心写内部信息（真实域名、绝对路径、内部地址），但**禁止写入密钥 / token 明文**
- 追加式记录、**最新在上**、每条带日期；不要回头改写或删除历史条目
- 文件不存在时按此骨架创建：

```markdown
# PROJECT_MEMORY — <项目名>
> 本机项目记忆，已被 .gitignore 忽略，不提交。

## 用户/维护者立下的规矩
## 决策与理由
## 踩坑与验证配方
```
