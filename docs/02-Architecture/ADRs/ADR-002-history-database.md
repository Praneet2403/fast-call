---
type: adr
status: proposed
date: 2026-10-30
---
# ADR-002: Database for history and events

## Context
We need durable storage for requests, offers, state-transition events and (some) location history. We want geospatial queries for analytics and training data for the ML models.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| PostgreSQL + PostGIS | ✍️ | ✍️ |
| MongoDB | ✍️ | ✍️ |
| TimescaleDB (Postgres extension) for pings | ✍️ | ✍️ |

## Decision
> [!todo] ✍️ Fill this after you research and/or build a small spike. Write "We will use X because …".

## Consequences
> [!todo] ✍️ What gets easier? What gets harder? What would make you revisit this?
