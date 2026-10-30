---
type: roadmap
updated: 2026-10-30
---
# Roadmap

> [!info] Rule
> A phase is done when its **exit demo** works and is recorded, not when the code "mostly works".

> [!info] Compressed to one week (Oct 31 – Nov 6)
> Day-by-day checklist: [[Build-Checklist]] · schedule: [[One-Week-Plan]]

| Phase  | Name                             | Exit demo                                                                     | Day            | Status         |
| ------ | -------------------------------- | ----------------------------------------------------------------------------- | -------------- | -------------- |
| 0 + 1a | Foundations + simulator          | Docker + workspace + shared types; 1,000 agents moving in the console         | Day 1 · Oct 31 | 🟡 In progress |
| 1b     | Ingest + live map                | 1,000 agents moving live on the dashboard map                                 | Day 2 · Nov 1  | ⚪              |
| 2a     | DB + state machine + request API | Idempotent POST; transition tests pass                                        | Day 3 · Nov 2  | ⚪              |
| 2b     | Dispatcher                       | Request → nearest → offer → accept / timeout → reassign; 0 double assignments | Day 4 · Nov 3  | ⚪              |
| 3      | Failure handling + zones         | Kill agents mid-trip → auto reassignment; no stuck requests                   | Day 5 · Nov 4  | ⚪              |
| 4      | Smart ranking + demand forecast  | "Why this unit won" in UI; smart beats nearest on a seeded replay             | Day 6 · Nov 5  | ⚪              |
| 5      | Proof & ship                     | p50/p95 latency, A/B results, README, demo video                              | Day 7 · Nov 6  | ⚪              |
| —      | After the week                   | Python ML models, acceptance model, anomaly flags, k6, Grafana, deploy        | later          | ⚪              |

## Learning goals per phase
See [[Learning-Map]].

## Changelog
- 2026-10-30: Roadmap created.
- 2026-10-31: Compressed to a one-week plan; ML service and extras moved to after the week.
