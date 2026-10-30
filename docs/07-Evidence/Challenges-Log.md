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
**Date:** 2026-10-31 · **Commit:** see `feat(requests)` (Day 3) · **Area:** request API, Postgres

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
