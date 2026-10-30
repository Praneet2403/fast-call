---
type: adr
status: proposed
date: 2026-10-30
---
# ADR-001: Where to store live agent locations

## Context
10,000 agents send a ping every ~4 s ≈ **2,500 writes/s**. The dispatcher must find nearby AVAILABLE agents in a few milliseconds. Only the *latest* position matters on the hot path.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Redis GEO (`GEOADD` / `GEOSEARCH`) | ✍️ | ✍️ |
| PostGIS only (GiST index) | ✍️ | ✍️ |
| MongoDB 2dsphere | ✍️ | ✍️ |
| In-memory in the dispatcher process | ✍️ | ✍️ |

> [!tip] Spike idea
> Write a 50-line script that inserts 10k points and runs 1,000 radius queries in each option. Record the timings in `07-Evidence`.

## Decision
> [!todo] ✍️ Fill this after you research and/or build a small spike. Write "We will use X because …".

## Consequences
> [!todo] ✍️ What gets easier? What gets harder? What would make you revisit this?
