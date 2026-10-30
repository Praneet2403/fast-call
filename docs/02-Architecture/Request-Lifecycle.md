---
type: architecture
status: draft
---
# Request Lifecycle (state machine)

```mermaid
stateDiagram-v2
  [*] --> CREATED
  CREATED --> MATCHING
  MATCHING --> OFFERED: candidate found + locked
  MATCHING --> EXPIRED: no candidate after max attempts
  OFFERED --> ASSIGNED: agent accepts
  OFFERED --> MATCHING: decline / timeout
  ASSIGNED --> EN_ROUTE
  EN_ROUTE --> ARRIVED
  ARRIVED --> COMPLETED
  ASSIGNED --> MATCHING: agent goes stale
  EN_ROUTE --> MATCHING: agent goes stale
  CREATED --> CANCELLED
  MATCHING --> CANCELLED
  OFFERED --> CANCELLED
  COMPLETED --> [*]
  CANCELLED --> [*]
  EXPIRED --> [*]
```

## Rules
- Every transition is written to an **event log** (who, when, from → to, reason).
- Illegal transitions (e.g. COMPLETED → MATCHING) must be **rejected in code** and covered by tests.

> [!todo] ✍️ Decide and write down
> - Offer timeout: ___ s
> - Max matching attempts before EXPIRED: ___
> - Can a P1 request steal an agent from a P3 offer? Why or why not?

## Agent status (separate state machine)
`OFFLINE → AVAILABLE → OFFERED → BUSY → AVAILABLE` (plus `STALE`, which is derived from the heartbeat)
> [!todo] ✍️ Draw this one yourself.
