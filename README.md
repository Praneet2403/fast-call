# Fast Call

Real-time ambulance dispatch engine for Jaipur. It picks the **best** unit for an emergency, not just the nearest one.

🚧 One-week build in progress. Planning docs and decisions live in [`/docs`](docs) (an Obsidian vault).

## Run it locally

Requires Node 24, pnpm and Docker.

```bash
docker compose up -d   # Postgres + PostGIS, Redis
pnpm install
pnpm dev               # API :4000, dispatcher, simulator, dashboard :5173
```

Open http://localhost:5173 to see the live fleet.

```bash
pnpm test        # unit + Redis/Postgres integration tests
pnpm typecheck
```

### Health and chaos

```bash
curl localhost:4000/health   # liveness: the process is up
curl localhost:4000/ready    # readiness: Redis + Postgres reachable (503 if not)
curl localhost:4000/stats    # ingest, relay and snapshot counters
```

Failure injection in the simulator (all off by default):

| Env var | Effect |
|---|---|
| `CHAOS_KILL_PCT=0.1` + `CHAOS_KILL_AT_SEC=120` | 10% of unit devices go silent at t=120 s (or send `kill -USR2 <sim pid>` any time) |
| `CHAOS_REVIVE_AFTER_SEC=60` | dead devices come back after 60 s |
| `CHAOS_DROP_PCT=0.02` | 2% of GPS pings are lost |
| `CHAOS_DELAY_PCT=0.02`, `CHAOS_DELAY_MS=8000` | 2% of pings arrive 8 s late, out of order |

The dispatcher's sweeper (every 5 s, one leader across instances) reassigns calls whose unit went
silent, re-queues calls that stopped moving, settles offers whose timeout was lost, and frees units
orphaned by a crash.

## Repo layout

| Path | What it is |
|---|---|
| `apps/simulator` | 1,000+ simulated ambulances driving Jaipur's real road network (seeded, replayable) |
| `apps/api` | Emergency-call API (idempotent), crew WebSocket gateway, GPS ingest into Redis, 1/s dashboard snapshots |
| `apps/dispatcher` | BullMQ worker: finds the nearest free capable unit, claims it atomically, offers, handles ACK / timeout / re-offer |
| `apps/dashboard` | React + MapLibre ops dashboard |
| `packages/shared` | Domain types, request lifecycle, wire protocol, geo helpers, hospitals |
| `packages/db` | Postgres + PostGIS schema, request/offer repository with transactional state changes |
| `packages/roads` | Jaipur road graph (OpenStreetMap) + A* routing |

## Data attribution

Road network and hospital locations: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
available under the Open Database License (ODbL 1.0). Map tiles: [OpenFreeMap](https://openfreemap.org) / OpenMapTiles.
The road graph is rebuilt with `pnpm --filter @fast-call/roads build-graph`.
