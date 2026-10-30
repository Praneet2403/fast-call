---
type: architecture
status: draft
---
# Dispatch Algorithm

## Pipeline (v0)
1. **Candidate search:** agents within radius R (start 3 km; widen to 5 km, then 8 km if needed).
2. **Hard filters:** AVAILABLE, fresh heartbeat, has the required capability.
3. **Score** each candidate (below).
4. **Lock** the best one atomically, so two requests can't claim the same agent.
5. **Offer** and start the timeout. On decline or timeout → release the lock → go to step 1 excluding that agent.

## Scoring v0 (rules, no AI yet)
```
score = w_eta·eta_score + w_fresh·freshness_score
      + w_zone·zone_impact_score + w_acc·acceptance_score
```
| Factor | v0 (Phase 2–4) | AI version (Phase 5) |
|---|---|---|
| ETA | distance ÷ avg speed | learned ETA model |
| Freshness | linear decay to 0 at threshold | n/a |
| Zone impact | free units left in the zone after assignment | + demand forecast |
| Acceptance | constant | logistic regression on history |

> [!todo] ✍️ Justify your weights
> Write *why* you chose each weight. Change them only through an experiment logged in `07-Evidence`.

## Baseline for comparison
**Nearest available agent** (straight-line). Every improvement is measured against this.
