---
type: architecture
status: draft
---
# Data Model

> [!todo] ✍️ Finish this after ADR-002 is decided. Below is a first guess.

```mermaid
erDiagram
  AGENT ||--o{ LOCATION_PING : sends
  AGENT ||--o{ OFFER : receives
  REQUEST ||--o{ OFFER : has
  REQUEST ||--o{ REQUEST_EVENT : logs
  AGENT {
    string id
    string status
    string[] capabilities
    timestamp last_seen_at
  }
  REQUEST {
    string id
    string idempotency_key
    point location
    int priority
    string required_capability
    string state
    timestamp created_at
  }
  OFFER {
    string id
    string request_id
    string agent_id
    string outcome
    float score
    json score_breakdown
  }
  REQUEST_EVENT {
    string request_id
    string from_state
    string to_state
    string reason
    timestamp at
  }
  LOCATION_PING {
    string agent_id
    point location
    timestamp at
  }
```

## What lives where
| Data | Redis (live) | Postgres (history) |
|---|---|---|
| Latest agent position | ✅ | snapshot only? ✍️ |
| Heartbeat | ✅ (TTL) | ❌ |
| Requests & state | ✍️ | ✅ |
| Event log | ❌ | ✅ |
| Every ping | ❌ | ✍️ all? sampled? (think about storage) |
