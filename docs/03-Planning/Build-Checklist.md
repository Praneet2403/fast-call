---
type: plan
start: 2026-10-31
end: 2026-11-06
updated: 2026-10-31
---
# Build Checklist: what, how, when (1-week version)

> [!info] How to use this
> This is the **master checklist**: tick boxes here. Hours per task and the daily rhythm are in [[One-Week-Plan]]. Anything not built this week is in **After the week** at the bottom.

**Legend**
- 🧑 **You write it.** Core logic: think, write and test it yourself, then ask for review.
- 🧱 **Boilerplate.** Config or setup code. It's fine to get help, as long as you can explain every line.
- ✅ **Done when** = the exit check. No ticking until it passes.

**Golden rules**
1. Each day ends with its **exit check** passing and the code pushed.
2. Commit small and often: `feat(scope): message (DE-xxx)`.
3. Every number you claim must come from a benchmark you actually ran.
4. The forecast and scoring only *rank* candidates. The lock and the state machine stay deterministic.

---

## Timeline at a glance
| Day | Date | Phase | Exit demo |
|---|---|---|---|
| 1 | Sat Oct 31 | 0 Foundations + 1a Simulator | 1,000 agents moving in the console, tests pass |
| 2 | Sun Nov 1 | 1b Ingest + live map | 1,000 dots moving live on the map |
| 3 | Mon Nov 2 | 2a DB + state machine + request API | Duplicate POST → one row; transition tests pass |
| 4 | Tue Nov 3 | 2b Dispatcher | End-to-end live; 0 double assignments under concurrency |
| 5 | Wed Nov 4 | 3 Failure handling + zones | Kill 10% of agents → no stuck requests |
| 6 | Thu Nov 5 | 4 Smart ranking + demand forecast | Smart beats nearest on the same seeded scenario |
| 7 | Fri Nov 6 | 5 Proof & ship | p50/p95 + A/B results in the README, demo video, repo public |

## Decisions made to save time
| Topic | Choice |
|---|---|
| Repo | pnpm workspaces monorepo, TypeScript, Node 24 |
| Live locations | Redis GEO + TTL heartbeat keys |
| History | Postgres + PostGIS (`imresamu/postgis:17-3.5` for arm64) |
| Migrations | `db/init.sql` mounted into `/docker-entrypoint-initdb.d` |
| Queue | BullMQ (on the existing Redis) |
| Map | MapLibre GL, GeoJSON source + `circle` layer, OpenFreeMap tiles |
| Forecast | TypeScript: seasonal baseline + exponential smoothing per H3 cell |

---

## Phase 0: Foundations (Day 1, morning)
- [x] 🧱 Git repo + GitHub remote
- [x] 🧱 Root `.gitignore`
- [x] 🧱 pnpm workspace (`apps/*`, `packages/*`) + `tsconfig.base.json`
- [x] 🧱 `docker-compose.yml`: Postgres+PostGIS (arm64 image) + Redis
- [ ] 🧱 Fix `allowBuilds: esbuild: true`, clean root `package.json`, add `README.md`, commit + push
- [x] 🧑 **Domain: ambulance (emergency medical dispatch).** Drives capabilities (BLS/ALS), priorities (P1–P3) and SLAs.
- [ ] 🧑 `packages/shared`: `GeoPoint`, `Agent`, `AgentStatus`, `Capability`, `Priority`, `RequestState`, `DispatchRequest`, `LocationPing`, `Offer`, `Hospital`
  - ✅ `pnpm exec tsc -p packages/shared` passes and the types have been reviewed
- [ ] 🧱 Root scripts: `dev`, `typecheck`, `test`; install `vitest`

## Phase 1a: Simulator (Day 1, afternoon)
- [ ] 🧱 `apps/simulator` scaffold + env config (`AGENT_COUNT`, `PING_INTERVAL_MS`, `SEED`)
- [ ] 🧑 Seeded RNG (every run can be replayed exactly; needed for the Day 6 A/B test)
- [ ] 🧑 Haversine distance + unit tests
- [ ] 🧑 Random-waypoint movement inside the Jaipur box (lat 26.80–27.00, lng 75.70–75.90)
- [ ] 🧑 Pick 6–8 real Jaipur hospitals from OpenStreetMap → `hospitals.json` (name, lat/lng, `hasALSCare`)
- [ ] 🧑 Tick loop; pings with jitter so agents don't all fire at once
  - ✅ 1,000 agents logged moving believably (no teleporting); tests pass; pushed

## Phase 1b: Ingest + live map (Day 2)
- [ ] 🧱 `apps/api`: Fastify + `@fastify/websocket` + `ioredis`
- [ ] 🧑 `/ws/agents`: validate pings with `zod`; drop out-of-order pings
- [ ] 🧑 Redis writes in a **pipeline**: `GEOADD agents:geo`, `HSET agent:{id}`, `SET agent:{id}:hb EX 15`
- [ ] 🧑 Simulator connects and streams pings
- [ ] 🧑 `/ws/dashboard`: **one batched snapshot per second**, not every ping
- [ ] 🧱 `apps/dashboard`: Vite + React + MapLibre + OpenFreeMap tiles
- [ ] 🧑 Agents as a GeoJSON circle layer, coloured by status; header with counts + median freshness
  - ✅ 1,000 dots moving live; ~1 dashboard message/s in the network tab; GIF recorded

## Phase 2a: Database + state machine + request API (Day 3)
- [ ] 🧑 `db/init.sql`: `requests` (`geography(Point)` + GiST index, `idempotency_key UNIQUE`), `offers`, `request_events`
- [ ] 🧑 State machine: transition table + `transition()` that rejects illegal moves and writes the event **in the same transaction**
- [ ] 🧑 Unit tests for legal and illegal transitions
- [ ] 🧑 `POST /requests` (Idempotency-Key), `GET /requests/:id`, `POST /requests/:id/cancel`
- [ ] 🧱 BullMQ queue; enqueue a `match` job on create
- [ ] 🧑 Simulator request generator with **hotspots + time-of-day curve** (gives the Day 6 forecast something to learn)
  - ✅ Same POST twice → one row; illegal transition tests pass; jobs appear in the queue

## Phase 2b: Dispatcher (Day 4)
- [ ] 🧱 `apps/dispatcher`: BullMQ worker scaffold
- [ ] 🧑 Candidates: `GEOSEARCH … ASC COUNT k`, radius 3 → 5 → 8 km; filter AVAILABLE + capability
- [ ] 🧑 Lock: `SET agent:{id}:lock <requestId> NX PX 20000` + Lua compare-and-delete release
- [ ] 🧑 Offer → delayed timeout job → on decline/timeout: release the lock, exclude the agent, retry → EXPIRED after N attempts
- [ ] 🧑 Simulator crews **acknowledge** offers (ack delay; rare "unable" reply), drive to the scene, then transport to a hospital before becoming AVAILABLE
- [ ] 🧑 **Concurrency test:** 500 simultaneous requests vs 50 agents → no agent held by two requests
- [ ] 🧑 Remove the lock once, watch the test fail, write down why (your best interview story)
- [ ] 🧑 Dashboard: request markers by state + line from agent to request
  - ✅ End-to-end flow live on the map; concurrency test passes

## Phase 3: Failure handling + zones (Day 5)
- [ ] 🧑 Stale agents: expired heartbeat → excluded from search; grey on the map
- [ ] 🧑 Agent dies mid-trip → request goes back to MATCHING automatically
- [ ] 🧑 Sweeper (every 5 s): fix requests stuck past their deadline
- [ ] 🧑 Simulator chaos flags: `--kill-pct`, `--drop-pings`, `--delay-pings`
- [ ] 🧑 Kill the dispatcher mid-run and restart → no lost requests
- [ ] 🧱 `pino` logs with `requestId` on every line
- [ ] 🧑 H3 (`h3-js`): cell per agent on ping; per-cell available counts in Redis
- [ ] 🧑 One short postmortem of the worst thing that broke
  - ✅ Kill 10% of agents under load → every affected request is reassigned or expired, none stuck; recorded

## Phase 4: Smart ranking + demand forecast (Day 6)
- [ ] 🧑 ETA v0: haversine × road factor ÷ zone speed
- [ ] 🧑 `score()` as a **pure function** → `{ total, breakdown }`: ETA, freshness, coverage (zone impact), demand pressure, capability waste (avoid sending ALS to a BLS call); unit tests
- [ ] 🧑 Demand forecast per H3 cell per 15 min (seasonal baseline + exponential smoothing); compare its MAE with a naive "last value" forecast
- [ ] 🧑 Zone impact uses the forecast: avoid draining a cell that's about to spike
- [ ] 🧑 `DISPATCH_STRATEGY=nearest|smart`; store `score_breakdown` on each offer
- [ ] 🧑 Dashboard: "Why this unit won" panel + demand heat per cell
- [ ] 🧑 Experiment script: same `SEED`, both strategies → avg ETA, % within SLA, expired count
  - ✅ Results table where smart beats nearest on at least one metric, and you can explain why

## Phase 5: Proof & ship (Day 7)
- [ ] 🧑 Scale 2k → 5k → 10k agents: find the first bottleneck, fix one thing, record before/after
- [ ] 🧑 Dispatch latency p50/p95/p99 (job start → offer sent) under a request burst
- [ ] 🧑 Final A/B run during a demand spike → results table
- [ ] 🧱 GitHub Actions: typecheck + unit tests
- [ ] 🧑 README: pitch, architecture diagram, one-command run, **real numbers**, tradeoffs, known limits
- [ ] 🧑 2-minute demo video: fleet → spike → smart dispatch → kill agents → recovery → results
- [ ] 🧑 Resume bullet with **only measured numbers**
  - ✅ A stranger can clone, run and watch it work; repo public

---

## If you fall behind, cut in this order
1. CI workflow
2. Demand heat layer on the map (keep the forecast itself)
3. Chaos `--delay-pings`
4. Scaling past what you've measured (claim only what you measured)
5. Dispatcher-crash test (keep stale + mid-trip reassignment)

**Never cut:** lock + concurrency test, state machine tests, nearest-vs-smart results, real numbers in the README.

## After the week (backlog)
- [ ] Rule-based anomaly flag (impossible speed between pings)
- [ ] Unit-availability / acknowledge-time model from offer history
- [ ] Python `services/ml` (FastAPI): LightGBM demand forecast vs the TS baseline; learned ETA model
- [ ] ML calls with a 50 ms timeout + heuristic fallback
- [ ] Rebalancing suggestions (nudge idle agents toward forecast hotspots)
- [ ] k6 load tests; Prometheus + Grafana dashboards
- [ ] Integration tests in CI with Postgres + Redis services
- [ ] Deploy on one small VM with docker compose
- [ ] Catch up the vault: PRD, ADR-001..003, concept notes
