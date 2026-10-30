---
type: prd
status: draft
version: 0.1
owner: Praneet
updated: 2026-10-30
---
# PRD: AI Real-time Dispatch & Operations Engine

> [!info] What a PRD is
> A Product Requirements Document answers **what** we build and **why**, not **how**. The "how" lives in `02-Architecture`. If a section here mentions Redis or React, it's in the wrong document.

## 1. Codename
> [!todo] ✍️ Pick a name. "dispatch-engine" is the placeholder.

## 2. Problem statement
> [!todo] ✍️ You write this (5–8 sentences)
> - Who has the problem? (ambulance network? delivery fleet? field technicians? Pick ONE primary domain.)
> - What goes wrong today when they use "nearest available unit"?
> - What does a bad assignment cost? (minutes, money, lives, failed SLAs)
> - Why does this need to be real-time?

## 3. Goals
> [!todo] ✍️ Write 3–5 goals. Each one must be measurable.
> Bad: "Fast dispatch." Good: "95% of requests get an offer within 1 s."

- G1:
- G2:
- G3:

## 4. Non-goals (what we deliberately won't build)
Starting suggestions. Keep, edit or delete each:
- A consumer mobile app for requesters or drivers (we simulate them)
- Real payments or pricing
- Real turn-by-turn navigation
- Multi-city / multi-region deployment
- ✍️ add your own:

## 5. Users
See [[Personas]].

## 6. User stories
Format: *As a <persona>, I want <capability>, so that <benefit>.*
- US-1: As an **ops dispatcher**, I want to see every unit live on a map, so that I know my coverage at a glance.
- US-2: As a **requester**, I want a unit assigned within seconds, so that help arrives fast.
- US-3: As an **ops dispatcher**, I want to see *why* a unit was chosen, so that I can trust or override the engine.
- US-4: ✍️
- US-5: ✍️

## 7. Functional requirements
| ID | Requirement | Phase | Priority |
|---|---|---|---|
| FR-1 | Ingest live location updates from agents | 1 | P0 |
| FR-2 | Show all agents live on a map | 1 | P0 |
| FR-3 | Create a request with location, priority and required capability | 2 | P0 |
| FR-4 | Match the request to a candidate agent and send an offer | 2 | P0 |
| FR-5 | Reassign if an offer is declined or times out | 2 | P0 |
| FR-6 | Never assign one agent to two active requests | 2 | P0 |
| FR-7 | Detect stale agents (no heartbeat) and exclude them | 3 | P0 |
| FR-8 | Rank candidates on ETA, freshness, capability and zone impact | 4 | P1 |
| FR-9 | Explain each assignment (score breakdown) | 4 | P1 |
| FR-10 | Forecast demand per zone | 5 | P2 |
| FR-11 | Flag anomalous movement (impossible speed) | 5 | P2 |
| FR-12 | ✍️ | | |

## 8. Non-functional requirements
These numbers come from the deck. **Validate each one in [[Benchmarks-Index]] before you claim it.**
| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Dispatch decision latency | p95 < 1 s |
| NFR-2 | Simulated concurrent agents | 10,000 |
| NFR-3 | Location freshness | median ≤ 4 s |
| NFR-4 | Burst load | 1,000s of requests in a spike, no lost requests |
| NFR-5 | Correctness | 0 double assignments under concurrency tests |

## 9. Success metrics (how we'll know it's better than "nearest")
- Average pickup ETA: smart engine vs nearest-agent baseline
- % of requests within SLA during a demand spike
- Unserved / expired requests during the spike
- ✍️ add one you care about

## 10. Risks & open questions
- ✍️ What could make this project fail? (scope, time, unknown tech)
- Open question: which city and domain for the simulation?

## Changelog
| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-10-30 | Skeleton created |
