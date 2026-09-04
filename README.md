# v2link

临时 VLESS 链接生成与分发管理系统——快速生成一条带有效期的 `vless://` 链接，扫码/复制即可用，全程在你的管理后台掌控之中。

## 它能做什么

- **一键生成临时链接**：指定时长（1 小时 ~ 30 天），生成 `vless://` 链接 + 二维码
- **全客户端兼容**：v2rayN / Shadowrocket / Clash / sing-box 等主流客户端开箱即用
- **生命周期管理**：到期自动失效；随时吊销、延长（支持小时相对延长 / 自定义绝对到期时刻）
- **精确流量账本**：每链接上下行流量独立统计（SQLite 持久化，重启不丢）
- **SSO 保护的管理后台**：接入自建认证中心，只有你能管理
- **数据面热管理**：基于 xray 官方管理 API，加删用户**无需重启、不断存量连接**
- **底部全球连通性监控**：服务器每 5 分钟直连美国/欧洲/日本/新加坡等主流地区 HTTPS 端点测延迟，底部固定状态条实时展示
- **历史流量曲线**：每 30s 采样一次，Dashboard 单链接查看近 24h / 7d / 30d 用量趋势（轻量 SVG）
- **连接记录追溯**：消费 xray access log，追溯“谁、何时、连过哪个目标”；保留 7 天
- **操作审计**：后台生成 / 吊销 / 延长全部留痕（操作人 = SSO 用户名 / dev）

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
   └── 定时器: 过期扫描 15s / 流量账本+采样 30s / 连接清理 1h / 采样清理 1d / 地区探测 5min
   └── access log 采集器: /var/log/xray/access.log → connections（2s 轮询 + logrotate 自愈）
```

**数据面**：xray-core（VLESS+WS），多用户由一个 inbound 承载，每个用户 = 一个 UUID/email。
**控制面**：Node/TS + Express + better-sqlite3，通过 `xray api` 子命令（非 gRPC、非 reload）动态加删用户与采集流量。
**账本**：控制面 SQLite 为权威——每 30s 拉取 xray 计数并累计，重启不丢；首拉语义已处理（不重复计停机窗口流量）。

### 监控 / 追溯 / 审计（数据流）

| 层 | 数据源 | 落库 | 保留 | 前端 |
|---|---|---|---|---|
| A 流量曲线 | scheduler 30s statsquery delta | `traffic_samples`（link_id/ts/delta） | 30 天滚动（每日清理） | 链接「详情 → 流量趋势」（SVG 折线） |
| B 连接追溯 | xray access log（accepted 事件） | `connections`（email/link_id/ts/host/port） | 7 天滚动（每小时清理） | 链接「详情 → 连接记录」（表格 + 域名搜索） |
| C 操作审计 | linkService create/revoke/extend | `audit_log`（actor/action/link_id/detail） | 不裁剪（管理类数据量小） | 顶部「审计」（分页列表） |

关键语义（均为实测结论，xray 26.3.27）：
- xray access log 是**纯文本**、每连接一行、**只含连接建立（accepted）事件，无字节数**。故 `connections` 无 up/down/duration（恒 NULL）；“用了多少流量”走 `traffic_samples`（stats 聚合）。两者经 link_id/email 关联。
- access log 含 `email:` 字段，可直连 links（email=id）；库中无匹配（残留/已吊销）时 `link_id=NULL` 仅记 email，仍可追溯。
- 日志轮转由系统 **logrotate** 负责（保留 7 天，`deploy/xray-logrotate`）；控制面 tailer 按 file offset 增量读，处理 copytruncate（size 变小 → 归零重读）与 rename+新建（inode 变化 → 重开并按指纹去重），文件缺失自愈。

## 快速开始

### 依赖

- Node.js ≥ 20
- [xray-core](https://github.com/XTLS/Xray-core) ≥ 26.3（含 `xray api` 子命令；`xray version` 验证）
- 一个认证中心（`/api/verify?token=` 协议，参考本项目 `deploy/v2link.conf.example` 的 nginx auth_request 探针）

### 1. 数据面：xray

```bash
# xray 配置见 deploy/xray.config.json（监听 127.0.0.1:7895 + 管理 API 127.0.0.1:8081 + access log）
# 用 systemd 或你习惯的方式常驻：
mkdir -p /var/log/xray          # access/error log 目录（xray 以 root 跑）
xray run -c deploy/xray.config.json
# access log 轮转（保留 7 天，与控制面 connections 保留期对齐）：
cp deploy/xray-logrotate /etc/logrotate.d/xray-access
```

### 2. 控制面

```bash
cd server
cp .env.example .env    # 按需修改（端口、xray 地址、认证中心 URL、ACCESS_LOG_PATH/保留期）
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
| POST | `/api/links` | 生成 `{ note?, hours? }`（写审计） |
| POST | `/api/links/:id/revoke` | 吊销（立即从 xray 摘除，写审计） |
| POST | `/api/links/:id/extend` | 延长：`{ hours }` 相对 或 `{ expiresAt }` 绝对（epoch ms，二选一，写审计） |
| GET | `/api/regions/probes` | 地区连通性快照 + 最近 12 轮历史（需求 2，内存态） |
| GET | `/api/links/:id/traffic?from=&to=&bucket=hour\|day` | 流量曲线桶（A；默认近 24h hour 桶） |
| GET | `/api/links/:id/connections?q=&from=&to=&limit=&offset=` | 连接记录分页（B；q=域名前缀搜索） |
| GET | `/api/audit?limit=&offset=` | 操作审计分页（C） |
| GET | `/api/healthz` | 健康检查（无鉴权） |

全部 API（除 healthz）经 SSO 鉴权：生产环境由 nginx `auth_request` 注入 `X-Auth-User`；直连调试可用 `ENABLE_DEV_TOKEN`（仅限本地，生产务必关闭）。审计 `actor` 取 `X-Auth-User`，dev token 场景记 `dev`。

> `extend` 的 `expiresAt`：epoch 毫秒整数；须晚于当前时间、且不早于当前时刻起 365 天（显式绝对时刻不设小时上限，允许提前缩短有效期）。`hours` 沿用 1~720 上限，在当前到期时刻基础上向后平移。

## 地区连通性监控（需求 2）

- **探测**：服务器直连（无代理）各主流地区知名 HTTPS 端点测 RTT（HTTP 探测非 ICMP）。默认 4 地：🇺🇸 美国 `gstatic.com/generate_204`、🇪🇺 欧洲 `bbc.com`、🇯🇵 日本 `yahoo.co.jp`、🇸🇬 新加坡 `cloudflare.com`；`.env` 的 `REGION_PROBES`（JSON）可整体覆盖，`REGION_PROBE_INTERVAL_S` 改周期（默认 300s）。
- **数据流**：scheduler 每 5 分钟跑一轮，结果**只存内存**（最新快照 + 最近 12 轮历史，不落库）；启动即跑首轮。前端经 `GET /api/regions/probes` 拉取，底部固定状态条按延迟着色：绿 <300ms / 黄 300~800ms / 红 不可达。
- **语义**：单次探测 5s 超时；拿到响应头即记 RTT（HEAD/提前断流，不下载 body）。失败地区仅标红，不影响其余地区与控制面。
- **范围外**：不做历史图表（只快照 + 最近几轮）、不做 ICMP ping、不做代理链路测速。

## 配置（server/.env）

见 `server/.env.example`（含每项注释）。监控相关关键项：`ACCESS_LOG_PATH`（默认 `/var/log/xray/access.log`）、`CONN_RETENTION_S`（连接记录保留秒数，默认 7 天）、`SAMPLE_RETENTION_S`（采样保留秒数，默认 30 天）、`CONN_CLEANUP_INTERVAL_S` / `SAMPLE_CLEANUP_INTERVAL_S`（清理周期）、`REGION_PROBE_INTERVAL_S`（地区探测周期）与 `REGION_PROBES`（地区端点覆盖）。

### 磁盘与性能预算（小服务器）

- `traffic_samples`：1 链接 × 2880 行/天，30 天 ≈ 8.6 万行——SQLite 无压力
- `connections`：保留 7 天；高峰期每分钟数千行 → 攒批 100 行/事务插入，查询全走 `(link_id, ts)` 索引；按天 logrotate 压缩控制磁盘
- `audit_log`：管理操作频率极低，不裁剪
- 列表接口全部分页；曲线聚合在内存做（30 天采样量级很小）

## 开发

```bash
npm install          # 根目录 workspaces
npm run dev -w server     # tsx watch
npm run dev -w frontend   # vite
npm test            # vitest 单测（server+frontend）
```

## License

MIT © v2link contributors
