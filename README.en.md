[English](README.en.md) | [简体中文](README.md)

# v2link

Generation and distribution of temporary VLESS links: issue a `vless://` link that expires, usable by scan or copy, and automatically invalid after expiry.

## What it does

- Generate a `vless://` link and QR code. The primary input for validity is an absolute expiry time (frontend `datetime-local`, default now+24h), with 1h / 6h / 24h / 3d / 7d quick options; it can also be made permanent.
- Lifecycle: expiry is revoked automatically by the scheduler; manual revocation is possible; the expiry time can be edited (extended or shortened), and limited and permanent links can convert to each other.
- Traffic ledger: upload and download bytes accumulate independently per link, persisted in SQLite and surviving restarts; increments are pulled from the xray stats API every 30s.
- Traffic chart: samples are written to `traffic_samples` every 30s and kept for about 30 days; the frontend renders an SVG line chart bucketed by hour / day.
- Connection tracing: parses connection-establishment events from the xray access log and records "when which target was connected to", kept for 7 days.
- Operation audit: create / revoke / extend / make-permanent leave a record; the actor is the current logged-in identity, defaulting to `dev`.
- Regional connectivity: direct HTTPS endpoint RTT probes for the US / Europe / Japan / Singapore every 5 minutes; the bottom status bar colors by latency.
- Data-plane hot management: add/remove users and read counters via the `xray api` subcommands (adu / rmu / statsquery), without reload and without dropping existing connections.
- Compatible with standard `vless://` + WebSocket clients such as v2rayN, Shadowrocket, Clash and sing-box.

## Architecture

```text
Client ── vless://<uuid>@<host>:443?encryption=none&security=tls&type=ws&path=/v2ws ──▶ nginx (TLS termination)
   ├── /v2ws  → xray  127.0.0.1:7895 (VLESS + WS inbound, outbound freedom direct)
   ├── /api/  → control plane 127.0.0.1:7897 (builtin) or Auth Gateway (sso, see "Authentication and security")
   └── /      → frontend static (the control plane serves frontend/dist via express.static)

Control plane (Node/TS): SQLite authoritative ledger ⇄ xray api (adu / rmu / statsquery)
  Timers: expiry scan 15s / traffic ledger and sampling 30s / xray consistency sync 60s / connection cleanup 1h / sample cleanup 1d / region probe 5min
  access log collection: ACCESS_LOG_PATH → connections (2s polling, handling copytruncate and file recreation)
```

- Data plane: xray-core, one VLESS + WS inbound carrying multiple users, one UUID per user, email as the ledger primary key.
- Control plane: Node/TS + Express + better-sqlite3, managing users dynamically through the `xray api` subcommands, with zero gRPC and zero reload.
- Consistency: write operations persist to SQLite first, then call xray; if xray fails, SQLite is rolled back and a 502 is returned (create / revoke).
- Ledger: pull xray counter increments every 30s and accumulate; the first pull after process start is read-only without reset, to avoid missing traffic from the downtime window.

## Monitoring / tracing / audit

| Layer | Data source | Table | Retention | Frontend |
|---|---|---|---|---|
| A Traffic chart | 30s statsquery increments | `traffic_samples` | 30-day rolling | link detail → traffic trend |
| B Connection tracing | xray access log (connection-establishment events only) | `connections` | 7-day rolling | link detail → connection records |
| C Operation audit | linkService write operations | `audit_log` | no trimming | top "audit" |

The xray access log is plain text, one line per connection, with only connection-establishment events and no byte counts: `connections` up/down/duration are always empty, and traffic comes from `traffic_samples`. The log contains an `email` field that can be correlated with links; when there is no match in the database, `link_id` is empty and only the email is recorded. Rotation is handled by system logrotate (`deploy/xray-logrotate`, kept 7 days).

## Quick start

Requirements: Node.js ≥ 20, xray-core (with the `xray api` subcommand).

```bash
# 1. Data plane: xray (see deploy/xray.config.json; listens on 127.0.0.1:7895, management API on 127.0.0.1:8081)
mkdir -p /var/log/xray
xray run -c deploy/xray.config.json
cp deploy/xray-logrotate /etc/logrotate.d/xray-access   # access log rotation (kept 7 days)
# 2. Control plane + frontend (root npm workspaces)
npm install
cp server/.env.example server/.env       # ports, xray address, auth mode, etc.
npm run build                            # server tsc + frontend vite build
npm start                                # node server/dist/index.js, listens on 127.0.0.1:7897
```

The frontend build output is in `frontend/dist`, served by the control plane, so no separate deployment is needed.

## Configuration

`server/.env` (template and comments in `server/.env.example`):

| Name | Default | Description |
|---|---|---|
| `PORT` | `7897` | Control plane listening port |
| `HOST` | `127.0.0.1` | Listen address; production is reverse-proxied by nginx |
| `XRAY_API` | `127.0.0.1:8081` | xray management API address |
| `XRAY_BIN` | `xray` | xray executable |
| `XRAY_INBOUND_TAG` | `vless-in` | Tag of the managed inbound |
| `XRAY_API_TIMEOUT_S` | `3` | Timeout for a single xray api call (seconds) |
| `XRAY_API_RETRIES` | `2` | Retry count on failure (exponential backoff) |
| `DEFAULT_HOURS` | `24` | Default duration when no validity is specified (hours) |
| `MAX_HOURS` | `720` | Upper bound for the `hours` option (hours) |
| `EXPIRE_SCAN_INTERVAL_S` | `15` | Expiry scan period (seconds) |
| `LEDGER_INTERVAL_S` | `30` | Traffic ledger and sampling period (seconds) |
| `XRAY_RECONCILE_INTERVAL_S` | `60` | Period for xray user / ledger consistency sync (seconds); `0` means sync once at startup only, no periodic self-healing |
| `ACCESS_LOG_PATH` | `/var/log/xray/access.log` | xray access log path |
| `CONN_RETENTION_S` | `604800` | `connections` retention seconds (7 days), cleanup period `CONN_CLEANUP_INTERVAL_S=3600` |
| `SAMPLE_RETENTION_S` | `2592000` | `traffic_samples` retention seconds (30 days), cleanup period `SAMPLE_CLEANUP_INTERVAL_S=86400` |
| `REGION_PROBE_INTERVAL_S` | `300` | Region probe period (seconds, minimum 60) |
| `REGION_PROBES` | empty | Region endpoint JSON override; leaves the built-in US / Europe / Japan / Singapore list in place when empty |
| `DB_PATH` | `server/data/v2link.db` | SQLite file path (`data/` is gitignored) |
| `AUTH_MODE` | `builtin` | `builtin` built-in account / `sso` trusts only `X-Auth-User` |
| `V2LINK_ADMIN_USER` | `admin` | Admin username created on first start |
| `V2LINK_ADMIN_PASSWORD` | empty | Randomly generated and printed once on first start if empty |
| `SESSION_TTL_HOURS` | `12` | Session lifetime (hours, sliding renewal on use) |
| `TRUST_PROXY` | `loopback` | Express trust proxy; used under a reverse proxy to get the real IP for login rate limiting |

`frontend/.env` (injected at build time, template in `frontend/.env.example`):

| Name | Default | Description |
|---|---|---|
| `VITE_API_PROXY_TARGET` | `http://127.0.0.1:7897` | dev server `/api` proxy target |
| `VITE_PUBLIC_HOST` | `v2.example.com` | Host name for generated links (address, may be an IP) |
| `VITE_PUBLIC_SNI` | empty (falls back to `VITE_PUBLIC_HOST`) | TLS SNI / WS Host for generated links (domain); fill separately when the address is an IP |
| `VITE_PUBLIC_PATH` | `/v2ws` | WebSocket path for generated links |

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/links` | all links with status and up/down traffic |
| POST | `/api/links` | create a link, body `{ note?, alias?, expiresAt?, hours?, permanent? }` (the last three are mutually exclusive) |
| POST | `/api/links/:id/revoke` | revoke (remove the user from xray, write audit) |
| POST | `/api/links/:id/extend` | one of `{ hours }` / `{ expiresAt }` (epoch ms) / `{ permanent: true }` |
| GET | `/api/links/:id/traffic?from=&to=&bucket=hour\|day` | traffic chart buckets (default last 24h, hour buckets) |
| GET | `/api/links/:id/connections?q=&from=&to=&limit=&offset=` | paginated connection records (`q` is a host prefix search) |
| GET | `/api/audit?limit=&offset=` | paginated operation audit |
| GET | `/api/regions/probes` | region connectivity snapshot + the last 12 rounds (in memory) |
| GET | `/api/healthz` | health check (no auth) |
| GET | `/api/auth-mode` | current auth mode (no auth) |
| POST | `/api/auth/login` | builtin: verify password, set a session cookie (rate-limited by IP) |
| POST | `/api/auth/logout` | builtin: delete the session (idempotent) |
| GET | `/api/auth/me` | builtin: return the current username, 401 when not logged in |

`expiresAt` must be an integer in epoch milliseconds, later than now and no more than 365 days in the future; `extend`'s `{ expiresAt }` may shorten the validity in advance, and a permanent link has no base time, so converting to limited can only use `expiresAt`.

## Authentication and security

- `builtin` (default): the control plane has its own account. The password is stored as a `node:crypto` scrypt hash (`scrypt$<salt>$<hash>`, hash only); a successful login sets an HttpOnly cookie `v2link_session`, and requests also accept `Authorization: Bearer <token>`; sessions default to 12 hours with sliding renewal; after 10 failures from the same IP within 15 minutes it returns 429 (in-memory counter, reset on restart).
- `sso`: built-in passwords are off and identity trusts only the `X-Auth-User` injected by the upstream auth layer; `/api/auth/login|logout|me` all return 404. In both modes, missing credentials return 401, never 302 or 500.
- On first start (empty users table) the admin is created from `V2LINK_ADMIN_USER`; when no password is provided, a random one is generated and printed once.
- Paths without auth: `/`, `/v2ws`, `/api/healthz`, `/api/auth-mode`.
- No private information is hard-coded: domains are injected at build time via `VITE_*` and configured in nginx, and passwords live only in `.env` (gitignored). Logs and audit do not additionally print full `vless://` links.

## Deployment

- Build: `npm run build`, producing `server/dist` (control plane) and `frontend/dist` (frontend static).
- systemd: control plane `v2link.service`, data plane `xray.service` (unit files are not in this repo). After changing the control plane, `systemctl restart v2link`; only when changing `deploy/xray.config.json` is `systemctl restart xray` needed.
- nginx: use `deploy/v2link.conf.example` as a template (the example is an sso deployment, with `/api/` and `/_auth/` going to Auth Gateway; for `builtin`, connect `/api/` directly to the control plane). `/v2ws` goes to xray, `/` goes to the control plane static site, and `server_name` is replaced with a placeholder; the config no longer contains `auth_request` / `/auth-check`.
- Data plane: `deploy/xray.config.json` provides access / error logs and `api.listen`; see `deploy/xray-logrotate` for log rotation.

## Development

```bash
npm install
npm run dev            # concurrently: server (tsx watch) + frontend (vite)
npm test               # vitest (server + frontend)
npm run typecheck
npm run build
npm run lint           # / npm run format
```

Run a single package: `npm run dev -w server`, `npm run dev -w frontend`.

## License

MIT, see `LICENSE`.
