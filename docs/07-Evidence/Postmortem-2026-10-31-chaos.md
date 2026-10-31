---
type: postmortem
date: 2026-10-31
---
# Postmortem: chaos run (10% of units die, then the dispatcher is killed)

## Summary
A planned failure-injection run against the full stack (API, dispatcher, 1,000 simulated units, Postgres, Redis).
Two scenarios: **(A)** the devices of 100 units die permanently under load; **(B)** the dispatcher is `kill -9`'d for 20 s.
The system **recovered from both without losing a call, double-booking a unit, or expiring a call**.
The run also exposed one real gap: **calls whose crew was already on scene when their unit died were stuck, and nobody was told.** Fixed the same day.

## Setup
- 1,000 units, call rate `CALLS_PER_MIN=40` (heavy, to stress it), plus 2% of pings dropped and 2% delayed by 8 s
- Heartbeat TTL 15 s · sweeper every 5 s · offer ACK timeout 15 s · dispatcher concurrency 32
- Script: `chaos-run.sh` (fresh DB, start the stack, inject faults, query the results)

## Timeline (IST)
| Time | Event |
|---|---|
| 20:15:21 | Stack up, 120 s warm-up |
| 20:17:19 | 50 calls have a unit driving to them |
| ~20:17:21 | **Chaos: 100 unit devices die permanently, 11 of them mid-call** |
| 20:17:37 | Sweeper reassigns all 4 calls whose dead unit was still driving to them (~16 s after the kill: 15 s heartbeat TTL + ≤5 s sweep) |
| 20:18:30 | **`kill -9` the dispatcher** with calls in flight |
| 20:18:50 | Dispatcher down 20 s: 26 new calls waiting in CREATED, 3 offers pending |
| 20:18:50 | Dispatcher restarted |
| 20:19:41 | All backlog cleared; checks below |

## Results
| Check | Result |
|---|---|
| Calls still pointing at a dead unit while driving | **0** |
| Reassigned calls re-offered to a new unit | **4 / 4**, new offer the same second the loss was detected |
| Time from device death to reassignment | **~16 s** (bounded by the heartbeat TTL) |
| Backlog after the dispatcher restart | 26 calls; waited **p50 8.4 s, max 20.4 s** from creation to being picked up |
| Stuck CREATED / MATCHING calls 50 s after restart | **0 / 0** |
| Overdue offers left unsettled | **0** |
| Units on two live calls | **0** |
| Expired calls / failed jobs | **0 / 0** |
| Out-of-order pings rejected by ingest | 1,330 (≈ the 1,400 pings chaos delayed) |

## What went well
- **Nothing was lost while the dispatcher was dead.** BullMQ keeps waiting and delayed jobs in Redis, so the restarted worker simply carried on. Nothing needed manual repair.
- **The sweeper reassigned every call it should have**, and the repair was idempotent (later sweeps found nothing to do).
- **Defence in depth held:** atomic claims plus the DB unique index meant zero double bookings, even across a crash.

## What went wrong
### 1. Seven calls silently stuck "on scene"
Of the 11 units that died mid-call, 4 were still driving and were reassigned. **The other 7 were already on scene or heading to hospital.** By design the system does not send a second ambulance to an ARRIVED call: the crew is probably with the patient, maybe inside a building with no signal. But with the device dead permanently, those calls could never complete, and **no human was told**.

- **Root cause:** the design handled "unit lost while driving" but treated "unit lost on scene" as not-our-problem, with no escalation path.
- **Fix (same day):** each 1 s snapshot now flags ARRIVED calls whose unit's heartbeat has expired (`callStats.needsAttention`). The dashboard shows a red **"N on-scene calls need a supervisor"** banner. No state change, no automatic second ambulance: a human decides.
- **Test:** `flags on-scene calls whose unit has gone silent for a human to check`.

### 2. My own verification script miscounted
A per-unit shell loop reported "159 stuck calls", more than units were killed. The cause was a quoting/compare bug in the check itself, not the system. Re-done as one pipelined `redis-cli` call: 7. **Lesson:** when a number looks impossible, check the measuring tool before the system.

## Action items
| # | Action | Status |
|---|---|---|
| 1 | Supervisor alert for on-scene calls with a silent unit | ✅ done |
| 2 | Policy for how long an on-scene call may stay unreachable before it pages someone or auto-closes as "unresolved" | Backlog |
| 3 | Run 2 dispatcher instances so a crash doesn't pause matching (the leader-elected sweeper already supports this) | Day 7 / backlog |
| 4 | Detection takes ~16 s (heartbeat TTL). A shorter TTL detects faster but flags more units stale on brief signal loss. Measure false positives before changing it | Backlog |
| 5 | p99 decision latency (1.26 s seen on Day 4) | Day 7 |
