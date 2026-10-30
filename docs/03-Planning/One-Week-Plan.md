---
type: plan
start: 2026-10-31
end: 2026-11-06
updated: 2026-10-31
---
# One-Week Plan (Oct 31 – Nov 6)

> [!warning] Reality check
> This compresses ~13 weeks into 7 days by **cutting scope, not corners**. It assumes **~10 focused hours a day**. This page is the **schedule** (hours per task). Tick progress in [[Build-Checklist]], the master checklist.

**Legend:** 🧑 you write it (core logic) · 🧱 boilerplate (help is fine, but you must be able to explain it) · ⏱ rough time

## What ships by Day 7
1. A simulator with 1,000+ agents moving around Jaipur, shown live on a map
2. A request API with idempotency → queue → dispatcher → lock → offer → accept/timeout → reassign
3. A state machine with an event log in Postgres; **0 double assignments** proven by a test
4. Stale-agent detection + automatic reassignment when an agent dies
5. Smart ranking (ETA + freshness + zone capacity + **demand forecast**) with a "why this unit won" panel
6. **Measured** results: nearest vs smart on the same seeded scenario, plus dispatch latency p50/p95
7. README + architecture diagram + 2-minute demo video

## Time-savers (decided, don't revisit)
| Instead of | Use | Why |
|---|---|---|
| Migration tool | `db/init.sql` mounted into `/docker-entrypoint-initdb.d` | Postgres runs it automatically on first start |
| deck.gl | MapLibre GeoJSON source + `circle` layer | One library; handles 10k points |
| Python ML service | Demand forecast in TypeScript (seasonal baseline + exponential smoothing per H3 cell) | No second runtime; still real forecasting, measurable against a naive baseline |
| Full docs | README + 1 diagram + results table | Your vault can catch up after the week |

---

## Day 1: Sat Oct 31 · Foundations + simulator
- [x] 🧱 Finish Phase 0: `allowBuilds: esbuild: true`, clean `package.json`, README stub, commit + push ⏱ 30m
- [x] 🧑 **Domain: ambulance (emergency medical dispatch)** ⏱ 15m
- [ ] 🧑 `packages/shared` types: `GeoPoint`, `Agent`, `AgentStatus`, `Capability`, `Priority`, `RequestState`, `DispatchRequest`, `LocationPing`, `Offer`, `Hospital` ⏱ 1.5h
- [ ] 🧱 Root scripts (`dev`, `typecheck`, `test`) + `vitest` ⏱ 30m
- [ ] 🧱 `apps/simulator` scaffold + env config (`AGENT_COUNT`, `PING_INTERVAL_MS`, `SEED`) ⏱ 30m
- [ ] 🧑 Seeded RNG + haversine (with unit tests) ⏱ 1h
- [ ] 🧑 Random-waypoint movement inside the Jaipur box (lat 26.80–27.00, lng 75.70–75.90) ⏱ 2h
- [ ] 🧑 Pick 6–8 real Jaipur hospitals from OpenStreetMap → `hospitals.json` (name, lat/lng, `hasALSCare`) ⏱ 30m
- [ ] 🧑 Tick loop printing positions; pings with jitter ⏱ 1h

✅ **Exit:** `pnpm --filter simulator dev` logs 1,000 agents moving believably; tests pass; pushed.

## Day 2: Sun Nov 1 · Ingest + live map
- [ ] 🧱 `apps/api`: Fastify + `@fastify/websocket` + `ioredis` ⏱ 45m
- [ ] 🧑 `/ws/agents`: validate pings with `zod`, drop out-of-order ones ⏱ 1h
- [ ] 🧑 Redis writes in a **pipeline**: `GEOADD agents:geo`, `HSET agent:{id}`, heartbeat `SET agent:{id}:hb EX 15` ⏱ 1.5h
- [ ] 🧑 Simulator connects and streams pings ⏱ 45m
- [ ] 🧑 `/ws/dashboard`: broadcast **one batched snapshot per second** ⏱ 1.5h
- [ ] 🧱 `apps/dashboard`: Vite + React + MapLibre + free tiles (OpenFreeMap) ⏱ 1h
- [ ] 🧑 Agents as a GeoJSON circle layer, coloured by status; header with counts + median freshness ⏱ 2h

✅ **Exit:** 1,000 dots moving live on the map at about 1 dashboard message/s. Record a GIF.

## Day 3: Mon Nov 2 · Database + request API + state machine
- [ ] 🧑 `db/init.sql`: `requests` (PostGIS `geography(Point)` + GiST index, `idempotency_key UNIQUE`), `offers`, `request_events` ⏱ 1.5h
- [ ] 🧑 State machine: transition table + `transition()` that rejects illegal moves and writes the event **in the same transaction** ⏱ 2h
- [ ] 🧑 Unit tests for legal and illegal transitions ⏱ 1h
- [ ] 🧑 `POST /requests` (Idempotency-Key), `GET /requests/:id`, `POST /requests/:id/cancel` ⏱ 2h
- [ ] 🧱 BullMQ queue; enqueue a `match` job on create ⏱ 45m
- [ ] 🧑 Simulator: request generator with **hotspots + time-of-day curve** (needed for the forecast on Day 6) ⏱ 1.5h

✅ **Exit:** posting the same request twice → one row; illegal transition tests pass; jobs appear in the queue.

## Day 4: Tue Nov 3 · Dispatcher (the heart of the project)
- [ ] 🧱 `apps/dispatcher`: BullMQ worker scaffold ⏱ 30m
- [ ] 🧑 Candidates: `GEOSEARCH … ASC COUNT k`, radius 3 → 5 → 8 km; filter AVAILABLE + capability ⏱ 1.5h
- [ ] 🧑 Lock: `SET agent:{id}:lock <requestId> NX PX 20000` + Lua compare-and-delete release ⏱ 1.5h
- [ ] 🧑 Offer → delayed timeout job → on decline/timeout release the lock, exclude the agent, retry → EXPIRED after N attempts ⏱ 2h
- [ ] 🧑 Simulator crews **acknowledge** offers (ack delay; rare "unable" reply), drive to the scene, then transport to a hospital before becoming AVAILABLE ⏱ 1.5h
- [ ] 🧑 **Concurrency test:** 500 simultaneous requests vs 50 agents → assert no agent is held by two requests. Remove the lock once, watch it fail, and note why. ⏱ 1.5h
- [ ] 🧑 Dashboard: request markers by state + line from agent to request ⏱ 1h

✅ **Exit:** end-to-end flow works live on the map; the concurrency test passes.

## Day 5: Wed Nov 4 · Failure handling + zones
- [ ] 🧑 Stale agents: expired heartbeat → excluded from search; shown grey on the map ⏱ 1h
- [ ] 🧑 Agent dies mid-trip → request goes back to MATCHING automatically ⏱ 1.5h
- [ ] 🧑 Sweeper (every 5 s): fix requests stuck past their deadline ⏱ 1.5h
- [ ] 🧑 Simulator chaos flags: `--kill-pct`, `--drop-pings`, `--delay-pings` ⏱ 1h
- [ ] 🧑 Kill the dispatcher mid-run and restart → no lost requests ⏱ 1h
- [ ] 🧱 `pino` logs with `requestId` on every line ⏱ 30m
- [ ] 🧑 H3 (`h3-js`): cell per agent on ping; per-cell available counts in Redis ⏱ 1.5h
- [ ] 🧑 Write one short postmortem of the worst thing that broke today ⏱ 30m

✅ **Exit:** kill 10% of agents under load → every affected request is reassigned or expired, none stuck. Record it.

## Day 6: Thu Nov 5 · Smart ranking + demand forecast
- [ ] 🧑 ETA v0: haversine × road factor ÷ zone speed ⏱ 45m
- [ ] 🧑 `score()` as a **pure function** returning `{ total, breakdown }`: ETA, freshness, coverage (zone impact), demand pressure, capability waste (avoid sending ALS to a BLS call); unit tests ⏱ 2h
- [ ] 🧑 Demand forecast per H3 cell per 15 min: seasonal baseline + exponential smoothing; compare its MAE against a naive "last value" forecast ⏱ 2.5h
- [ ] 🧑 Zone impact uses the forecast: avoid draining a cell that's about to spike ⏱ 1h
- [ ] 🧑 `DISPATCH_STRATEGY=nearest|smart`; store `score_breakdown` on each offer ⏱ 45m
- [ ] 🧑 Dashboard: "Why this unit won" panel + demand heat per cell ⏱ 1.5h
- [ ] 🧑 Experiment script: same `SEED`, both strategies → avg ETA, % within SLA, expired count ⏱ 1.5h

✅ **Exit:** a results table where smart beats nearest on at least one metric, and you can explain why.

## Day 7: Fri Nov 6 · Prove it + ship
- [ ] 🧑 Scale up (2k → 5k → 10k agents): find the first bottleneck, fix one thing, record before/after ⏱ 2.5h
- [ ] 🧑 Dispatch latency p50/p95/p99 (time from job start to offer sent) under a request burst ⏱ 1.5h
- [ ] 🧑 Final A/B run during a demand spike → results table ⏱ 1h
- [ ] 🧱 GitHub Actions: typecheck + unit tests ⏱ 30m
- [ ] 🧑 README: pitch, architecture diagram, run in one command, **results with real numbers**, tradeoffs, known limits ⏱ 2h
- [ ] 🧑 2-minute demo video: fleet → spike → smart dispatch → kill agents → recovery → results ⏱ 1h
- [ ] 🧑 Resume bullet using **only the numbers you measured** ⏱ 15m

✅ **Exit:** a stranger can clone the repo, run it, and watch it work. Repo public.

---

## If you fall behind, cut in this order
1. CI workflow
2. Demand heat layer on the map (keep the forecast itself)
3. Chaos `--delay-pings`
4. Scaling past whatever level you've measured (claim only what you measured)
5. Dispatcher-crash test (keep stale + mid-trip reassignment)

**Never cut:** the lock + concurrency test, the state machine tests, the nearest-vs-smart results, the README numbers.

## Stretch (only if you're ahead)
- Rule-based anomaly flag (impossible speed between pings) ⏱ 45m
- Unit-availability / acknowledge-time scoring from offer history ⏱ 2h
- Python LightGBM forecast to compare against your TypeScript baseline

## Daily rhythm
- **First 30 min:** read up on today's main concept (locks, GEO, H3…) and write 5 lines in your own words
- **Build** in small commits: `feat(scope): … (DE-xxx)`
- **Last 15 min:** push, tick boxes, 3-line log (did / learned / blocked)
