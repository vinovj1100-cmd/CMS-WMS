# WMS — Warehouse Management System

A warehouse management system built on Next.js 14 (App Router, TypeScript). It covers the full
inbound-to-outbound lifecycle — receiving, putaway, inventory control, wave picking, packing,
shipping, cycle counting, returns and replenishment — behind a role-permissioned API with an
append-only audit trail.

Everything below has been verified against a running build: the domain layer is covered by
**99 passing tests** across five suites, `next build` prerenders **12 WMS screens** and serves
**23 API routes**, and the auth, RBAC, CSRF and rate-limit guards were exercised end to end with
`curl` against a production-mode server.

---

## Table of contents

1. [Quick start](#quick-start)
2. [What it does](#what-it-does)
3. [Architecture](#architecture)
4. [Security model](#security-model)
5. [Roles and permissions](#roles-and-permissions)
6. [API reference](#api-reference)
7. [Configuration](#configuration)
8. [Deployment](#deployment) — test, develop, production
9. [Testing](#testing)
10. [Project layout](#project-layout)
11. [Demo data](#demo-data)
12. [Extending it](#extending-it)

---

## Quick start

Requires Node.js 18.18 or newer. This repo uses pnpm.

```bash
corepack enable
pnpm install
cp .env.example .env      # every value has a safe default, so this is optional
pnpm dev                  # http://localhost:3000
```

Open **http://localhost:3000/auth/login** and sign in with a demo account:

| Role              | Username     | Password           |
| ----------------- | ------------ | ------------------ |
| Administrator     | `admin`      | `Wms!Owner2026`    |
| Warehouse Manager | `manager`    | `Wms!Manager2026`  |
| Supervisor        | `supervisor` | `Wms!Supervisor2026` |
| Operator          | `operator`   | `Wms!Operator2026` |
| Read-only         | `viewer`     | `Wms!Viewer2026`   |

> These accounts exist only when `WMS_SEED_DEMO_DATA` is enabled, which defaults to **off** in
> production. They are for evaluation, not for a real deployment.

The app lands on `/wms`. Unauthenticated visitors to any `/wms/*` route are redirected to the
login screen and returned to where they were headed afterwards.

### Verify the install

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # 99 domain + security tests
pnpm lint        # next lint
pnpm build       # full production build, prerenders every page
pnpm check       # all four of the above, in order
```

---

## What it does

### Inbound

- **Purchase orders** — draft → submitted → partially received → complete, with receipt
  progress tracked per line.
- **Advance shipping notices** — a strict state machine:
  `expected → arrived → unloading → receiving → qc → putaway → complete`. Out-of-order
  transitions are rejected rather than silently corrected.
- **Scan-driven receiving** — receive per unit against a line, or "receive all". Lot-controlled
  SKUs demand a lot number and expiry-controlled SKUs demand an expiry date *at the point stock
  moves*, not just on the ASN. Over-receipt returns HTTP 409.
- **Putaway** — the system suggests a destination; scanning somewhere else is **flagged, not
  blocked**, because operators always know something the system doesn't. Blocked locations are
  skipped by the suggestion engine.

Received stock lands **reserved at the dock**. It only becomes saleable when putaway completes —
that reservation is the QC gate, and it is what keeps unpicked-up receipts out of the
available-to-promise figure.

### Inventory

- Per-location, per-lot balances with `onHand`, `allocated`, `reserved` and `damaged` tracked
  separately, and `available` derived from them.
- FEFO (first-expiry-first-out) and pick-face-first allocation.
- Adjustments, transfers and cycle-count approvals all write **both** an adjustment record and a
  movement ledger entry, so the two reports can always be reconciled against each other.
- Adjustments refuse to drive a location negative or to oversell stock that is already
  allocated.

### Outbound

- **Allocation** reserves stock without moving it. It is all-or-nothing: if any line is short the
  whole allocation rolls back and the order goes `backordered`, so you never end up with a
  half-committed order.
- **Waves** group allocated orders. Releasing a wave generates pick tasks in **travel sequence**
  (aisle → bay → level → position) so a picker walks each aisle once. This is usually the single
  biggest picking-productivity win available.
- **Picking** requires the location to be scanned before the item, which stops mis-picks at the
  bin rather than at dispatch. Reporting a short pick is a normal outcome, not an error.
- **Packing and shipping** validate packed quantities against picked quantities, then manifest a
  shipment with tracking and carrier.
- Cancelling an order releases its allocation and records the reason; shipped orders cannot be
  cancelled.

### Cycle counting

Counts are **blind** — the system quantity is hidden from the counter while the sheet is in
progress, which is the only way to get an unbiased number.

Counting and approving are **separate capabilities**. A sheet only leaves `in_progress` once
every line is counted; if nothing varied it completes immediately, and if anything varied it goes
to `variance_review` and needs someone holding `cyclecount:approve`. Variances are flagged for
recount on an absolute threshold (>3 units) *and* a relative one (>10% of the balance), because
two missing units matters on a near-empty bin but not on a full pallet.

### Returns

RMAs go `requested → approved → received → processed`. Disposition decides where stock goes:

| Disposition     | Effect                                                        |
| --------------- | ------------------------------------------------------------- |
| `restock`       | Returns to saleable stock at the scanned location              |
| `refurbish`     | Held in the returns zone as **reserved** — never saleable      |
| `scrap`         | Held in the returns zone as **reserved** — never saleable      |
| `vendor_return` | Held in the returns zone as **reserved** — never saleable      |

### Replenishment

Generates tasks when a pick face drops below its minimum, pulling from reserve. Skips blocked
locations, respects weight and capacity, and is executed as a scanned move.

---

## Architecture

```
Browser
  │  fetch (CSRF header)
  ▼
middleware.ts            navigation guard only — NOT authorisation
  │
  ▼
app/api/**/route.ts      one handler per endpoint
  │  withAuth(...) → session verify + rate limit + CSRF + capability check
  ▼
lib/api/guard.ts         request pipeline
  ▼
lib/wms/services/*.ts    pure domain logic. No Next.js, no I/O.
  │  (snapshot, input) → result | throws ApiError
  ▼
lib/wms/store            Store interface + adapters
  ├─ memory              default, in-process
  └─ file                JSON on disk under WMS_DATA_DIR
```

### The domain layer is pure

Services in `lib/wms/services/` take a `DatabaseSnapshot` and an input, mutate the snapshot, and
return a result or throw an `ApiError`. They never touch the filesystem, the network, or
`next/*`. That is what makes them testable in isolation — the 99 tests call the same functions the
API routes call, with no HTTP or mocking layer in between.

### Persistence

`Store` is a four-method interface (`read`, `write`, `mutate`, `reset`). All mutation goes through
`mutate()`, which serialises on a mutex. That serialisation is what stops two concurrent API calls
from clobbering each other's read-modify-write — there is a test that fires twenty concurrent
increments through it and asserts none are lost.

Swapping in a real database means writing one adapter and nothing else. `getStore()` caches on
`globalThis` so hot reloads don't drop the data.

### Numbering

Every document number comes from `nextNumber(snapshot, prefix)`, producing
`PREFIX-YYYY-0001` (`PO-2026-0001`, `SO-2026-0001`, `RMA-2026-0001`, …) and advancing a per-prefix
sequence stored on the snapshot.

---

## Security model

Security is layered, and each layer is enforced independently — nothing relies on the layer above
it having already checked something.

### Sessions

- HMAC-signed cookies, `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- Rotated on every login. Changing a password revokes every **other** session.
- A role change or deactivation revokes that user's live sessions, so the change takes effect
  immediately rather than at their next sign-in.
- Default TTL is 8 hours — one warehouse shift.

### Passwords

- scrypt, `N=32768`, `r=8`, `p=1`, 64-byte key, 32-byte salt per user.
- Policy: minimum 12 characters, at least three of four character classes, no common password
  words, no character repeated three or more times.
- NFKC-normalised and capped at 128 bytes before hashing, so a long password can't be silently
  truncated by scrypt's internal limit.
- Verification uses `timingSafeEqual`.
- Login against an unknown user still runs the hash against a dummy record, so response time
  doesn't reveal whether the username exists.

### Rate limiting and lockout

Token-bucket limiters keyed per user+IP for login and per IP for the API. Held on `globalThis` so
a hot reload doesn't reset an attacker's attempt counter. Accounts lock after
`WMS_LOGIN_MAX_ATTEMPTS` failures within `WMS_LOGIN_WINDOW_SECONDS`.

### CSRF

Double-submit cookie. The server sets `wms_csrf` as a **readable** cookie; the client echoes it in
the `x-wms-csrf` header on every state-changing request. A cross-origin attacker can't read the
cookie, so it can't populate the header. Requests with no token pair fall back to a strict
same-origin check, and a malformed `Origin` header is rejected rather than failing open.

This sits on top of `SameSite=Lax` — the two are complementary, not redundant.

### Audit

Every authenticated action, permission denial and failed sign-in is appended to an audit log.
**There is no delete path anywhere in the application.** Retention is handled by archiving
externally. The log is filterable by outcome, which makes `outcome: denied` a useful thing to
watch.

### Boot-time configuration gate

`assertSecureConfig()` runs at startup via `instrumentation.ts` and **throws** on fatal
violations, so a production container refuses to serve traffic with a debug secret or an insane
TTL. The same findings are surfaced non-fatally by `GET /api/health`, which returns `503` and
`ready: false` when a fatal violation exists or the dataset is empty.

### Middleware is a navigation guard only

`middleware.ts` shape-checks the session cookie to redirect unauthenticated browsers. It is
**not** authorisation and must never be treated as such — it runs on the Edge runtime and can't
verify the HMAC. Every API call re-verifies the session through `lib/api/guard.ts` regardless of
what the middleware decided.

### Verified behaviour

These were checked against a running production-mode server:

```
GET  /api/health                          200  ready: true
GET  /api/wms/inventory      (no session) 401  UNAUTHORIZED
GET  /api/wms/reports/summary (operator)  403  requires "reports:read"
POST /api/wms/inventory/transfer
     Origin: https://evil.example         403  CSRF_FAILED — cross-origin
POST with mismatched token                403  CSRF_FAILED — token mismatch
POST /api/auth/login  (wrong password)    401  "Invalid username or password."
GET  /wms/inventory          (no session) 307  → /auth/login?next=%2Fwms%2Finventory
GET  /wms/inventory        (with session) 200
```

---

## Roles and permissions

Five roles over a flat permission list (`inventory:read`, `inbound:receive`, `outbound:ship`,
`cyclecount:approve`, …). Defined in `lib/security/rbac.ts`.

| Role                | Can do                                                             |
| ------------------- | ------------------------------------------------------------------ |
| `admin`             | Everything, including user administration and settings             |
| `warehouse_manager` | Everything operational; approvals; no user administration          |
| `supervisor`        | Operational work plus cycle-count and return approvals             |
| `operator`          | Receive, putaway, pick, pack, count — no approvals, no adjustments |
| `viewer`            | Read-only across the board                                         |

Two separations are deliberate and load-bearing:

- **Counting ≠ approving a cycle count.** `operator` holds `cyclecount:count` but not
  `cyclecount:approve`.
- **`viewer` holds no mutating capability at all** — not one write permission.

Admin safeguards: you cannot deactivate your own account, and the last active admin cannot be
demoted or deactivated. New accounts start with `mustChangePassword: true`.

---

## API reference

All routes are prefixed `/api` and return JSON. Errors are always
`{ "error": { "code", "message", "details?" } }` with a matching HTTP status.

### Auth

| Method | Path                      | Notes                                              |
| ------ | ------------------------- | -------------------------------------------------- |
| `GET`  | `/api/auth/session`       | Public. Always issues a CSRF cookie.                |
| `POST` | `/api/auth/login`         | Body: `{ username, password }`. Rotates CSRF.       |
| `POST` | `/api/auth/logout`        | Revokes the current session.                        |
| `POST` | `/api/auth/change-password` | Revokes all other sessions.                       |
| `GET`  | `/api/health`             | Public. `503` + `ready: false` when not healthy.    |

### WMS

| Method        | Path                             | Purpose                                  |
| ------------- | -------------------------------- | ---------------------------------------- |
| `GET`         | `/api/wms/inventory`             | Balances, filters, pagination            |
| `POST`        | `/api/wms/inventory/transfer`    | Move stock between locations             |
| `GET` `POST`  | `/api/wms/inbound`               | ASNs and purchase orders                 |
| `POST`        | `/api/wms/inbound/[id]/receive`  | Per-line receipt, `action`-discriminated |
| `GET` `POST`  | `/api/wms/putaway`               | Putaway queue and confirmation           |
| `GET` `POST`  | `/api/wms/outbound`              | Sales orders                             |
| `POST`        | `/api/wms/outbound/[id]`         | Allocate / pack / ship / cancel          |
| `GET` `POST`  | `/api/wms/waves`                 | Wave planning and release                |
| `GET` `POST`  | `/api/wms/picks`                 | Pick task queue and confirmation         |
| `GET` `POST`  | `/api/wms/cycle-counts`          | Count sheets, submit / approve / reject  |
| `GET` `POST`  | `/api/wms/returns`               | RMAs, review and receipt                 |
| `GET` `POST`  | `/api/wms/replenishment`         | Generate and execute tasks               |
| `GET` `PATCH` | `/api/wms/locations`             | Rack map; block/unblock                  |
| `GET`         | `/api/wms/reports/summary`       | Dashboard and reporting payload          |
| `GET`         | `/api/wms/audit`                 | Audit trail (read-only, paginated)       |
| `GET`         | `/api/wms/master-data`           | Warehouses, zones, SKUs, partners        |
| `GET` `POST`  | `/api/wms/admin/users`           | User administration                      |
| `PATCH`       | `/api/wms/admin/users/[id]`      | Role, active, password reset             |

Multi-action endpoints discriminate on a body `action` field rather than growing a URL per verb.

**Blocking a location** is refused with `409` while that location still holds stock, because
putaway and replenishment skip blocked locations — silently blocking a populated bin would strand
its stock.

---

## Configuration

Every variable has a safe default, so the app boots with no `.env` at all. See `.env.example`.

| Variable                  | Default              | Purpose                                      |
| ------------------------- | -------------------- | -------------------------------------------- |
| `NODE_ENV`                | `development`        | `production` turns on the strict config gate  |
| `NEXT_PUBLIC_SITE_URL`    | `http://localhost:3000` | Origin; used for CSP and CSRF origin checks |
| `WMS_SESSION_SECRET`      | *(dev secret)*       | HMAC key. **Required** in production.         |
| `WMS_SESSION_TTL_SECONDS` | `28800`              | Session lifetime (8 hours = one shift)        |
| `WMS_SCRYPT_N`            | `32768`              | Hash cost. 2^15.                              |
| `WMS_LOGIN_MAX_ATTEMPTS`  | `5`                  | Failures before lockout                       |
| `WMS_LOGIN_WINDOW_SECONDS`| `900`                | Lockout window                                |
| `WMS_STORAGE_DRIVER`      | `memory`             | `memory` or `file`                            |
| `WMS_DATA_DIR`            | `./data`             | Directory for the `file` driver               |
| `WMS_SEED_DEMO_DATA`      | on outside production| Seed the demo warehouse and users             |
| `WMS_SECURE_COOKIES`      | on in production     | `Secure` flag on cookies                      |
| `WMS_AUDIT_LOG`           | `true`               | Emit structured audit records                 |
| `CSP_ENFORCE`             | `false`              | Enforce rather than report-only               |

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### What the config gate refuses

In production these are **fatal** and stop the process at boot:

- session secret shorter than 32 characters
- session secret equal to the built-in development secret
- a `sessionTtlSeconds` outside 1 minute to 30 days
- a `loginMaxAttempts` outside 1 to 100
- a `WMS_SCRYPT_N` outside 1024 to 1,048,576
- a `NEXT_PUBLIC_SITE_URL` that isn't a valid URL

These are **warnings**, surfaced by `/api/health` but not fatal:

- `WMS_SEED_DEMO_DATA` on in production
- cookies not marked `Secure`

Outside production the same checks report as warnings so local development isn't blocked.

---

## Deployment

`next.config.mjs` sets `output: "standalone"`, which produces a self-contained server with only
the dependencies actually used.

### Test

Ephemeral, seeded, no secrets required. This is the configuration CI runs.

```bash
NODE_ENV=test \
WMS_STORAGE_DRIVER=memory \
WMS_SEED_DEMO_DATA=true \
WMS_SESSION_SECRET="test-secret-at-least-32-characters-long" \
pnpm build && pnpm start
```

The test profile deliberately keeps demo data on so fixtures are predictable, and keeps the
memory driver so each run starts clean.

### Develop

```bash
pnpm dev
```

`NODE_ENV=development` relaxes the config gate to warnings, keeps cookies non-`Secure` (local
traffic is HTTP), and seeds demo data by default. Hot reload preserves the dataset because the
store is cached on `globalThis`.

For persistence across restarts:

```bash
WMS_STORAGE_DRIVER=file WMS_DATA_DIR=./data pnpm dev
```

### Production

Three things are non-negotiable:

1. **Set `WMS_SESSION_SECRET`** to real randomness. The app refuses to start without it.
2. **Set `WMS_SEED_DEMO_DATA=false`** so no demo credentials exist.
3. **Persist the data.** The memory driver loses everything on restart. Either mount a volume for
   the `file` driver or write a database adapter.

```bash
NODE_ENV=production \
NEXT_PUBLIC_SITE_URL="https://wms.example.com" \
WMS_SESSION_SECRET="<48 random bytes, base64url>" \
WMS_STORAGE_DRIVER=file \
WMS_DATA_DIR=/var/lib/wms \
WMS_SEED_DEMO_DATA=false \
node .next/standalone/server.js
```

> Note the entry point: with `output: "standalone"`, run `node .next/standalone/server.js` rather
> than `next start`.

Serve behind TLS. The app sets `Secure` cookies in production and validates the `Origin` header
against `NEXT_PUBLIC_SITE_URL`, so both need the real public origin.

### Docker

```bash
docker build -t wms .
docker run -d --name wms -p 3000:3000 \
  -e NODE_ENV=production \
  -e NEXT_PUBLIC_SITE_URL=https://wms.example.com \
  -e WMS_SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  -e WMS_SEED_DEMO_DATA=false \
  -v wms-data:/app/data \
  wms
```

The container runs as a non-root user, and `/app/data` is the mount point for the file driver.

### Health checking

Point your load balancer at `GET /api/health`. It returns `200` with `ready: true` when the
configuration is valid and the dataset is non-empty, and `503` with `ready: false` otherwise —
along with the specific violations.

---

## Testing

```bash
pnpm test          # single run
pnpm test:watch    # watch mode
```

99 tests across five suites. They call the real domain functions with real seeded data; nothing is
mocked.

| Suite                   | Tests | Covers                                                        |
| ----------------------- | ----- | ------------------------------------------------------------- |
| `tests/inventory.test.ts`   | 14 | adjustments, transfers, allocation, rollback, derived views    |
| `tests/inbound.test.ts`     | 10 | PO lifecycle, ASN state machine, receipt, putaway, QC hold     |
| `tests/outbound.test.ts`    | 18 | allocation atomicity, waves, travel sequencing, pack, ship     |
| `tests/operations.test.ts`  | 23 | cycle counts, returns, store concurrency and isolation         |
| `tests/security.test.ts`    | 34 | hashing, policy, CSRF, rate limiting, RBAC, config validation  |

Tests run under Vitest with `WMS_SCRYPT_N=4096`. That is a real scrypt path at a cost that keeps
the suite around two seconds; production keeps 32768.

---

## Project layout

```
app/
  api/
    auth/{session,login,logout,change-password}/route.ts
    health/route.ts
    wms/**/route.ts            23 API route files
  wms/                         12 screens
    page.tsx                   dashboard
    inventory/  locations/  inbound/  putaway/
    outbound/   picking/    cycle-count/  returns/
    reports/    audit/      admin/users/
  auth/login/page.tsx
components/
  wms/{wms-shell,primitives}.tsx
  ui/                          shadcn/ui primitives
  auth/login-form.tsx
hooks/
  use-wms.ts                   useApi, describeError
  use-media-query.ts
lib/
  wms/
    types.ts                   every domain type
    schemas.ts                 zod validation for every request
    services/                  pure domain logic
      inventory.ts  inbound.ts  outbound.ts
      cycle-count.ts  operations.ts  reports.ts
    store/
      index.ts                 Store interface, getStore, clone
      adapters/{memory,file}.ts
      seed.ts  seed-data.ts    demo warehouse
  security/
    config.ts                  env parsing + boot gate
    password.ts                scrypt + policy
    session.ts                 signing, rotation
    rbac.ts                    permissions and roles
    rate-limit.ts              token buckets
    csrf.ts                    double-submit cookie
    audit.ts                   append-only log
  api/
    http.ts                    ApiError, JSON helpers
    guard.ts                   withAuth request pipeline
    client.ts                  browser fetch wrapper
middleware.ts                  navigation guard
instrumentation.ts             boot-time config gate
tests/                         99 tests
```

---

## Demo data

`WMS_SEED_DEMO_DATA=true` (the default outside production) builds a realistic two-warehouse
operation:

| Entity            | Count |
| ----------------- | ----- |
| Warehouses        | 2     |
| Zones             | 13    |
| Locations         | 284   |
| SKUs              | 30    |
| Inventory records | 62    |
| Suppliers         | 5     |
| Customers         | 8     |
| Users             | 5     |

Locations use a real scheme — `aisle-bay-level-position` codes with capacity, weight limits and
pick-face flags. SKUs carry dimensions, ABC class, lot and expiry control. Stock is spread across
lots with staggered expiry dates so FEFO allocation has something to work with, and a spread of
ASNs, orders, waves, counts and RMAs sits across every state of every workflow so no screen is
empty on first load.

Turn it off with `WMS_SEED_DEMO_DATA=false` and the store starts empty.

---

## Extending it

**Add a permission.** Add the string to `PERMISSIONS` in `lib/security/rbac.ts`, then grant it in
the relevant `*_GRANTS` array.

**Add an endpoint.** Define a zod schema in `lib/wms/schemas.ts`, write the pure function in the
relevant service, then wrap the handler in `withAuth` with the capability it needs. The handler
receives `(request, auth, ctx)` positionally and performs its mutation inside `store.mutate()`:

```ts
export const POST = withAuth(
  { permission: "inventory:transfer", auditAction: "inventory.transfer", auditResource: "inventory" },
  async (request: NextRequest, auth) => {
    const body = await parseBody(request, transferInventorySchema)
    const store = await getStore()

    const result = await store.mutate((snapshot) =>
      transferInventory(snapshot, { ...body, performedBy: auth.user.username }),
    )

    return ok({ ok: true, from: result.from, to: result.to })
  },
)
```

`withAuth` applies, in order: the IP throttle, CSRF for state-changing methods, session
verification, the capability check, and the audit write. Throwing an `ApiError` from anywhere
inside the handler produces the matching status and error envelope.

**Swap the database.** Implement the `Store` interface in `lib/wms/store/adapters/` and select it
in `getStore()`. Nothing above the store knows which adapter is in use.

**Add a screen.** Pages follow one shape: `PageHeader` + a `StatCard` grid + a `DataTable`, with
data from `useApi(path, { refreshKey })` and writes through `mutate()`.

---

## License

MIT.
