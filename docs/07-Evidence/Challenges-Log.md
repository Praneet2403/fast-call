---
type: interview-prep
updated: 2026-10-31
---
# Challenges Log: where I got stuck and how I got out

> [!info] How to use this
> Interviewers ask "What was the hardest bug?" or "Where did you get stuck?". Every entry here **really happened** in this project, with the commit that fixed it. Each one has a **30-second answer** to say out loud, and the details behind it for follow-up questions.
>
> Add a new entry whenever something takes more than ~30 minutes to figure out.

## Index
| # | Challenge | Area | Best for the question… |
|---|---|---|---|
| 1 | [[#1. Blank map: the bug no test could see]] | Frontend / build tooling | "Hardest bug?" |
| 2 | [[#2. Pings drifting slower than configured]] | Simulation / timing | "A bug your tests caught?" |
| 3 | [[#3. Old GPS pings moving ambulances backwards]] | Distributed systems / Redis | "A race condition?" |
| 4 | [[#4. Database image wouldn't run on Apple Silicon]] | DevOps / Docker | "Environment problems?" |
| 5 | [[#5. Ambulances driving through a forest]] | Product realism / geospatial | "Something you noticed only by looking?" |
| 6 | [[#6. One emergency, many retries: no duplicate ambulances]] | API design / Postgres concurrency | "How do you handle retries?" / "Idempotency?" |
| 7 | [[#7. The schema that would never have been applied]] | Databases / DevOps | "A gotcha you avoided?" |
| 8 | [[#8. One ambulance offered to 261 emergencies at once]] | Distributed systems / Redis | "Race condition?" ⭐ best story |
| 9 | [[#9. Free ambulances invisible behind busy ones]] | Algorithms / geospatial | "A bug a test caught?" |
| 10 | [[#10. Status reports arriving out of order]] | Distributed systems | "Ordering / consistency?" |
| 11 | [[#11. What happens when things die: the sweeper]] | Reliability / self-healing | "How does your system recover from failures?" |
| 12 | [[#12. Health check that lied]] | Operations | "Liveness vs readiness?" |
| 13 | [[#13. Chaos testing: killing 10% of the fleet on purpose]] | Reliability / testing | "How did you test failure handling?" ⭐ |

---

## 1. Blank map: the bug no test could see
**Date:** 2026-10-31 · **Commit:** `19af1d5` · **Area:** dashboard (React + MapLibre + Vite)

### 30-second answer
> "My ops dashboard passed typecheck, every unit test and the production build, but the map was blank. MapLibre decodes map tiles and GeoJSON in a Web Worker loaded from a separate file. Vite's dependency pre-bundler moved MapLibre into its cache folder but left the worker file behind, so the worker request returned a 504 and nothing was ever drawn. I found it by driving a real browser engine with Playwright and software WebGL and reading the failed network request. The fix was to bundle the worker as its own entry with `?worker&url` and pass it to MapLibre's `setWorkerUrl()`. The lesson: some bugs only exist at runtime in a real browser, which is why the project has a browser smoke test."

### Symptom
- The side panel was live (1,000 units, freshness numbers updating), but the map area was an empty grey canvas: no streets, no ambulances.
- No error was visible on the page.

### Investigation
1. **Headless browser:** the page crashed completely. Cause: headless Chromium had **no WebGL**, which MapLibre needs. That was a *second* problem: one failing component blanked the whole React app.
2. **Headed browser:** WebGL worked and the canvas existed, but there were still no tiles or dots, so WebGL wasn't the root cause.
3. **Playwright + SwiftShader** (software WebGL, the same approach CI uses) with network and console capture showed it:
   `requestfailed …/.vite/deps/maplibre-gl-worker.mjs net::ERR_FAILED` → `Error: Worker failed to load`.

### Root cause
MapLibre 6 does its heavy work off the main thread in a **Web Worker** loaded from `maplibre-gl-worker.mjs`. In dev, Vite **pre-bundles dependencies** into `node_modules/.vite/deps/`. It moved MapLibre's main file but not the worker, so the relative worker URL pointed at a file that didn't exist. **The production build had the same bug without any error**: its output contained no worker file at all.

### Fix
```ts
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
setWorkerUrl(maplibreWorkerUrl);
```
`?worker&url` makes Vite bundle the worker as its own entry (with its imports) and return its URL.
**Related hardening:** if WebGL is missing, the map now shows a clear message and the stats panel keeps working, instead of the whole app going blank.

### Verification
Playwright + SwiftShader: all 1,000 units rendered; positions read 6 s apart showed ~75 m of movement (~12.5 m/s); 13/13 tile requests returned 200; no console errors from app code. The production build now emits `maplibre-gl-worker-*.js`.

### Lesson
Typecheck, unit tests and the build **all passed**, and the feature was still broken. Some bugs only show up when real code runs in a real browser engine. → A browser smoke test is part of the Day 7 plan.

### Likely follow-up questions
- *Why does MapLibre use a worker?* Decoding vector tiles and building geometry is CPU-heavy. Doing it on the main thread would freeze the UI.
- *How did you test WebGL without a GPU?* SwiftShader, a CPU implementation of the GPU pipeline that Chromium can use. It's how map apps get tested in CI.
- *Why didn't the build fail?* The worker is loaded at runtime from a computed URL. The bundler never saw a static import of it, so nothing told it the file was needed.

---

## 2. Pings drifting slower than configured
**Date:** 2026-10-31 · **Commit:** `13d6f46` · **Area:** simulator

### 30-second answer
> "The simulator sends each ambulance's GPS every 4 seconds, but a unit test showed 10% fewer pings than expected: they were really arriving every ~4.5 s. Pings can only fire on 1-second ticks, and I scheduled the next ping from 'now', so every interval was rounded up to the next tick and the error built up. I changed it to schedule from the *due time*, plus a resync if the process stalls, so it doesn't fire a burst of catch-up pings. It's the same reason naive timers drift."

### Details
- **Caught by:** the test `pings each agent roughly once per interval`. It expected ~6,000 pings in 120 s for 200 agents and got 5,300.
- **Root cause:** `nextPingAt = now + interval`. When a ping is due at t=4.2 s, it fires at the 5 s tick, and the next one is then scheduled from 5 s instead of 4.2 s.
- **Fix:** `nextPingAt = dueTime + interval ± jitter`. If more than one interval behind (e.g. the event loop was blocked), resync to now instead of bursting.
- **Lesson:** tests on *rates and statistics*, not only on single values, catch timing bugs.

---

## 3. Old GPS pings moving ambulances backwards
**Date:** 2026-10-31 · **Commit:** `7ea623a` · **Area:** ingest API / Redis

### 30-second answer
> "GPS pings can arrive out of order: network retries, reconnects, or two ingest servers. If an old ping is applied after a new one, the ambulance jumps backwards and the dispatcher acts on a wrong position. A simple 'read the last timestamp, then write' has a race between two servers. So I put the check and the write in one Redis Lua script, which runs atomically. An integration test against real Redis proves an older ping can't move a unit back."

### Details
- **The script:** compare the ping's `ts` with `agents:lastSeen`. Only if it's newer: update the timestamp, `GEOADD` the position, and refresh the heartbeat key with a TTL.
- **Why Lua:** Redis runs a script atomically, so no other command can run between the read and the write. That makes it a compare-and-set.
- **Performance:** all pings in a batch go in one pipelined round trip (~252 pings/s at 1k units, 0 rejected).
- **Test:** `drops out-of-order pings` (Redis DB 15).

---

## 4. Database image wouldn't run on Apple Silicon
**Date:** 2026-10-30 · **Area:** local infrastructure (Docker)

### 30-second answer
> "`docker compose up` failed with 'no matching manifest for linux/arm64'. The official PostGIS image is only published for Intel. I used `docker manifest inspect` to see which CPU architectures each image ships, then switched to a multi-arch PostGIS build that runs natively on ARM. The other option was forcing `platform: linux/amd64`, but that runs under emulation and is slower."

### Details
- `docker manifest inspect postgis/postgis:17-3.5` → amd64 only.
- `imresamu/postgis:17-3.5` → amd64 + arm64 (the same Postgres 17 + PostGIS 3.5).
- **Lesson:** Docker images are built per CPU architecture. Check before you assume an image works on your machine.

---

## 5. Ambulances driving through a forest
**Date:** 2026-10-31 · **Commit:** `5770a2a` · **Area:** simulator realism / geospatial

### 30-second answer
> "Looking at the live map, I noticed ambulances crossing the Jhalana Reserve Forest and the Aravalli hills. The simulator moved units in straight lines between random points, so it ignored roads entirely, and every straight-line 'ETA' was fiction. That's the same mistake the project claims to fix in dispatch. I pulled Jaipur's drivable roads from OpenStreetMap, built a graph of 216k nodes and 248k road segments, and routed every ambulance with A\*. On average, the road distance in Jaipur is 1.24× the straight line, which is exactly the error 'nearest by straight line' makes."

### Details
- **Found by:** looking at the map, not by a test. Unit tests checked speed and bounds, not road realism.
- **Data:** Overpass API → clip to the service area → keep the **largest connected component** (99.3% of nodes; the other 109 fragments are private compounds and broken data), so a route always exists. Stored as a 1.68 MB gzipped file in the repo, so seeded runs stay reproducible even when OSM changes.
- **Graph:** CSR adjacency in typed arrays (compact and cache-friendly) plus a grid index for "nearest road to this point".
- **Routing:** A\* with a straight-line heuristic. It's admissible because a road is never shorter than a straight line, so A\* gives the same answer as Dijkstra. Measured: **~5× fewer nodes explored than Dijkstra; p50 8.9 ms, p95 34 ms** per city-wide route; 1,000 initial routes in 1.6 s.
- **A second bug the tests caught:** destinations were picked by sampling random nodes until one was 0.8–6 km away. From the city edge most nodes are too far, so all attempts failed and a 9 km trip slipped through. Fix: sample a bearing and distance, then snap to the nearest road. The test now includes the four corner nodes.
- **Verified visually:** units now stay on roads. The one unit left inside Jhalana was on a real `tertiary` road in OSM (way 1180267892) that the base map doesn't draw at that zoom.
- **Lesson:** a believable simulation needs the same constraints as the real world, or the "smart dispatch beats nearest" result is meaningless.

### Likely follow-up questions
- *Why A\* and not Dijkstra?* Same optimal answer, but the heuristic points the search towards the goal, so it explores far fewer nodes.
- *Why not call Google Maps or OSRM?* Rate limits, cost, network latency on every decision, and non-reproducible results. A local graph is deterministic and fast enough.
- *What's simplified?* Roads are undirected (one-way streets are ignored; ambulances with sirens often bend that rule anyway), and speed is constant per trip, not per road type. Both are listed as known limits.

---

## 6. One emergency, many retries: no duplicate ambulances
**Date:** 2026-10-31 · **Commit:** `ff4e1c3` · **Area:** request API, Postgres

### 30-second answer
> "When a caller's app times out, it retries. If the server had already saved the call, a naive API creates a *second* emergency, and two ambulances drive to one patient while someone else waits. Every POST carries an `Idempotency-Key`. The insert uses `ON CONFLICT DO NOTHING` on a unique index, so if 25 identical requests race, Postgres lets exactly one insert. The others wait for it to commit, then read and return the original with a 200. I proved it with a test that fires 25 concurrent creates: one row, one id, 24 replays. A key reused with a *different* body gets a 422, because that's a client bug, not a retry."

### Details
- **Why not "check if exists, then insert"?** Two requests can both check, both see nothing, and both insert. The unique index makes the database the referee.
- **Crash between the DB commit and the queue enqueue?** A retried POST for a call still in `CREATED` enqueues again. The BullMQ job id is `match-{requestId}`, so a healthy call is never matched twice. Day 5's sweeper covers clients that never retry.
- **The same idea everywhere:** the simulator reuses one key across its own retries, the queue dedupes by job id, and state changes use `onlyFrom` guards so a retried worker is a no-op.
- **Tests:** `creates exactly one request when 25 identical POSTs race`; `handles 20 concurrent retries of one call` (HTTP level: one 201, nineteen 200, one id).
- **Live check:** three identical `curl` POSTs → 201, 200, 200 (`Idempotent-Replayed: true`), and the queue grew by **one** job.

### Related: state changes that can't interleave
`transition()` does `SELECT … FOR UPDATE`, checks the lifecycle table, then updates the row and appends the audit event in **one transaction**. Test: 10 workers race to move the same call `MATCHING → OFFERED`, and exactly one wins. A partial unique index also makes Postgres **refuse to put one unit on two live calls**, and that test shows the audit event is rolled back too.

---

## 7. The schema that would never have been applied
**Date:** 2026-10-31 · **Area:** Postgres / Docker

### 30-second answer
> "The plan said to put the schema in `/docker-entrypoint-initdb.d`. But Postgres's Docker image only runs those scripts when the data volume is **empty**, and mine was created days earlier. The schema would silently never have been applied on my machine, while working on a fresh clone. Instead the services apply an idempotent `schema.sql` (every statement is `IF NOT EXISTS`) on startup, inside a transaction with an advisory lock so two services can't migrate at the same moment."

### Lesson
"Works on a fresh machine" and "works on mine" are different states. Make setup steps idempotent and run them every time, instead of relying on first-run hooks.

---

## 8. One ambulance offered to 261 emergencies at once
**Date:** 2026-10-31 · **Commit:** `74d1d87` · **Area:** dispatcher, Redis

### 30-second answer
> "The dispatcher runs 32 jobs in parallel. Claiming a unit looks simple: 'if it's AVAILABLE, mark it DISPATCHED'. But as two separate commands, many workers read AVAILABLE before any of them writes. I wrote a test that fires 500 calls at 50 ambulances at once and ran it with the naive claim: **one ambulance was offered to 261 calls simultaneously**, and 4–6 units were double-booked on every run. The fix is one Lua script that Redis runs atomically: check the heartbeat, check AVAILABLE, `SET lock NX` with a TTL, mark DISPATCHED. Same test: every unit offered exactly once, zero double bookings. Postgres also has a partial unique index as a last line of defence, so even a buggy lock can't put one unit on two live calls."

### Details
- **Why a lock *and* a status?** The lock (with TTL) covers the short window while an offer is open; the status keeps a unit busy for the whole call. Releases are compare-and-delete (only if the lock still holds *our* request id), so a slow worker can't release someone else's lock.
- **Why the TTL?** If the dispatcher crashes mid-offer, the lock expires instead of locking the unit forever.
- **Defence in depth:** Redis lock → DB `requests_one_live_call_per_unit` unique index → test that proves the DB refuses it.
- **Kept in the code on purpose:** `FleetOps(redis, unsafeClaim = true)` exists only so the test can show the bug.
- **Tests:** `never offers one unit to two calls when claims are atomic` / `DOES double-book units with a naive read-then-write claim`.

---

## 9. Free ambulances invisible behind busy ones
**Date:** 2026-10-31 · **Area:** dispatcher candidate search

### 30-second answer
> "To find candidates I asked Redis for the 25 nearest units, *then* filtered out busy ones. The concurrency test showed only 25 of 50 units ever got used: once the 25 closest were busy, every new call saw '25 candidates, all busy' and waited, while free units sat just outside the top 25. Redis's GEOSEARCH can limit by distance but not by status. So if a full page comes back with nobody usable, I widen the page 4× and search the same ring again until the ring is exhausted. In a real spike, that's the difference between a call waiting and a free ambulance going out."

### Details
- **Found by:** `expected 50 offers, got 25` in the 500-vs-50 test.
- **Scale-up option (later):** keep a separate GEO set of only AVAILABLE units, so search never sees busy ones. That costs an extra write on every status change, a tradeoff worth measuring at 10k units.

---

## 10. Status reports arriving out of order
**Date:** 2026-10-31 · **Area:** dispatcher, crew messages

### 30-second answer
> "Crews report EN_ROUTE, AT_SCENE, TRANSPORTING, AT_HOSPITAL, AVAILABLE. The dispatcher processes jobs in parallel, so two reports from one crew can be handled out of order. A late EN_ROUTE applied after AVAILABLE would make a free ambulance look busy forever. Two fixes: every report carries the device's timestamp, and a Lua compare-and-set only applies a status if it's newer than the last one. And the call's state *walks forward* to the reported step: if AT_SCENE arrives before EN_ROUTE, the call goes ASSIGNED → EN_ROUTE → ARRIVED, and the late EN_ROUTE changes nothing."

### Details
- **Test:** `copes with crew reports processed out of order`.
- **Related rule:** after a call is cancelled, only "I'm AVAILABLE again" is accepted from that crew.
- **Another reliability choice:** while disconnected, the simulator **drops** stale GPS pings but **queues** crew messages, because losing "I'm free again" would strand a unit.

---

## 11. What happens when things die: the sweeper
**Date:** 2026-10-31 · **Area:** dispatcher reliability

### 30-second answer
> "The happy path is event-driven: jobs, timeout jobs, crew reports. Events get lost when things crash: the API can die between saving a call and queueing it, a worker can die after claiming an ambulance but before offering it, an ambulance's radio can go dark mid-drive. So I added a sweeper, a reconciliation loop that runs every 5 seconds and compares what *should* be true with what *is*. It re-queues calls that stopped moving, settles offers whose timeout was lost, reassigns calls whose ambulance went silent, and frees ambulances orphaned by a crash. Every repair is idempotent, and only one dispatcher instance sweeps at a time, chosen by a Redis leader key with a TTL."

### The four repairs (each has a test that stages the failure)
| Lost event | How the sweeper notices | Repair |
|---|---|---|
| API crashed after saving a call, before queueing | `CREATED`/`MATCHING` with no progress for 20 s | Re-queue a match job (deduplicated per 30 s window) |
| Offer timeout job lost | `PENDING` offer past `expires_at` | Settle it as timed out → re-offer |
| Unit's GPS goes dark while driving to a call | Call `ASSIGNED`/`EN_ROUTE`, unit's heartbeat key gone | Call → `MATCHING`, unit → `OFFLINE`, offer to the next unit |
| Worker crashed between claim and offer | Unit `DISPATCHED`, no lock, no offer, no call | Unit → `AVAILABLE` (Lua CAS, skipped if a new claim landed) |

### Design decisions worth defending
- **Why not just make every step transactional?** Redis and Postgres can't share one transaction. A reconciliation loop is the standard answer, the same idea as Kubernetes controllers.
- **Calls already ARRIVED aren't reassigned** when the unit goes silent: the crew is with the patient (often in a building with no signal), not lost.
- **A reassigned unit comes back by itself:** it stays `OFFLINE` until it reports `AVAILABLE`, and that report is always accepted, even for a call it no longer holds.
- **Leader election** = `SET dispatcher:sweeper-leader <id> NX PX 15000` + renew. If the leader dies, its key expires and another instance takes over (tested).

---

## 12. Health check that lied
**Date:** 2026-10-31 · **Area:** operations

### 30-second answer
> "On Day 4 Docker stopped, taking Postgres and Redis with it, yet my API's `/health` still returned 'ok', because it only proved the process was alive. Those are two different questions. *Liveness*: should this process be restarted? *Readiness*: can it serve traffic right now? I kept `/health` as liveness and added `/ready`, which pings Redis and Postgres with a 1-second timeout each and returns 503 with per-dependency detail. A load balancer should route on readiness. Restarting the process on readiness would just restart-loop it while the database is down."

### Tests
`reports ready (200) when Redis and Postgres both answer` / `reports not ready (503) with per-dependency detail when Redis is unreachable`.

---

## 13. Chaos testing: killing 10% of the fleet on purpose
**Date:** 2026-10-31 · **Full write-up:** [[Postmortem-2026-10-31-chaos]]

### 30-second answer
> "Unit tests prove the pieces; I wanted proof the whole system heals. I built failure injection into the simulator: kill a share of unit devices, drop pings, delay pings so they arrive out of order. Then I ran it live under heavy load. I killed 100 of 1,000 ambulances, 11 of them mid-call, and then `kill -9`'d the dispatcher for 20 seconds. Results: every call whose ambulance was still driving was reassigned about 16 seconds after the device died. The 26 calls that came in while the dispatcher was dead were all picked up after restart. Zero double bookings, zero lost calls, zero failed jobs. It also found a real gap: calls where the crew was already on scene when the unit died were stuck forever and nobody was told. I fixed that with a supervisor alert, deliberately not an automatic second ambulance."

### Numbers to remember
100 units killed (11 mid-call) · 4/4 driving calls reassigned in ~16 s · 26-call backlog cleared after a dispatcher `kill -9` (p50 wait 8.4 s) · 0 stuck · 0 double-booked · 1,330 out-of-order pings rejected.
