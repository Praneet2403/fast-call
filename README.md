# Fast Call

Real-time ambulance dispatch engine for Jaipur. It picks the **best** unit for an emergency, not just the nearest one.

🚧 One-week build in progress. Planning docs and decisions live in [`/docs`](docs) (an Obsidian vault).

## Run it locally

Requires Node 24, pnpm and Docker.

```bash
docker compose up -d   # Postgres + PostGIS, Redis
pnpm install
pnpm dev               # API :4000, simulator, dashboard :5173
```

Open http://localhost:5173 to see the live fleet.

```bash
pnpm test        # unit + Redis integration tests
pnpm typecheck
```

## Repo layout

| Path | What it is |
|---|---|
| `apps/simulator` | 1,000+ simulated ambulances driving Jaipur's real road network (seeded, replayable) |
| `apps/api` | WebSocket ingest of GPS pings into Redis; 1/s fleet snapshots for dashboards |
| `apps/dashboard` | React + MapLibre ops dashboard |
| `packages/shared` | Domain types, wire protocol, geo helpers, hospitals |
| `packages/roads` | Jaipur road graph (OpenStreetMap) + A* routing |

## Data attribution

Road network and hospital locations: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
available under the Open Database License (ODbL 1.0). Map tiles: [OpenFreeMap](https://openfreemap.org) / OpenMapTiles.
The road graph is rebuilt with `pnpm --filter @fast-call/roads build-graph`.
