---
type: glossary
---
# Glossary
Use these words consistently in code, docs and interviews.

| Term | Meaning |
|---|---|
| **Agent / Unit** | A moving resource that can take jobs (driver, ambulance, technician). |
| **Request** | A job that needs an agent: location, priority, required capability. |
| **Offer** | A proposal sent to one agent for one request, valid for a short time. |
| **Assignment** | An accepted offer: the agent is now bound to the request. |
| **Reassignment** | Picking a new agent after a decline, a timeout or an agent failure. |
| **Heartbeat** | A periodic signal proving the agent is alive. Location pings double as heartbeats. |
| **Stale agent** | An agent whose last heartbeat is older than the threshold. |
| **Freshness** | Age of the latest location (now − lastSeenAt). |
| **ETA** | Estimated time for the agent to reach the request location. |
| **Zone / Cell** | A geographic area used for capacity and demand. We plan to use H3 hex cells. |
| **Capability** | What an agent can do (e.g. `ICU`, `BASIC`, `HEAVY_VEHICLE`). |
| **SLA** | Target time limit, e.g. "unit on scene within 10 min for P1". |
| **Idempotency key** | Client-supplied ID so a retried request isn't processed twice. |
| ✍️ | Add terms as you meet them. |
