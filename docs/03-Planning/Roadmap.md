---
type: roadmap
updated: 2026-10-30
---
# Roadmap

> [!info] Rule
> A phase is done when its **exit demo** works and is recorded, not when the code "mostly works".

| Phase | Name | Exit demo | Est. | Status |
|---|---|---|---|---|
| 0 | Foundations | Docs v0.1, repo + Docker running, ADR-001..003 accepted | 1–2 wk | 🟡 In progress |
| 1 | Live fleet | 1,000 agents moving live on the dashboard map | 1 wk | ⚪ |
| 2 | Basic dispatch | Request → nearest agent → offer → accept / timeout → reassign; concurrency test shows 0 double assignments | 1 wk | ⚪ |
| 3 | Failure handling | Kill an agent mid-trip → auto reassignment; stale agents excluded; idempotent request API | 1 wk | ⚪ |
| 4 | Smart ranking | Score breakdown visible in UI; H3 zones; smart engine beats nearest on avg ETA | 1 wk | ⚪ |
| 5 | AI layer | Demand forecast, ETA model, acceptance model, anomaly flags | 1–2 wk | ⚪ |
| 6 | Proof | 10k agents + spike; p50/p95 latency report; A/B vs nearest; README + demo video | 1 wk | ⚪ |

## Learning goals per phase
See [[Learning-Map]].

## Changelog
- 2026-10-30: Roadmap created.
