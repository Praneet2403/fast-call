---
type: spec
status: living
updated: 2026-10-31
---
# API & Event Spec

## REST: emergency calls (`apps/api/src/routes/requests.ts`)

### `POST /requests`: report an emergency
**Header:** `Idempotency-Key: <8-128 URL-safe chars>` (required). Reuse the same key on every retry of the same call.

```json
{ "lat": 26.9239, "lng": 75.8267, "priority": "P1", "requiredCapability": "ALS" }
```

| Status | When |
|---|---|
| **201** Created | New call. `Location: /requests/{id}` is set, and a `match` job is queued |
| **200** OK | Retry of an earlier identical call: same body as the original, plus `Idempotent-Replayed: true` |
| **400** | Missing or invalid `Idempotency-Key`, or an invalid body |
| **422** | Key reused with a **different** body (per the IETF Idempotency-Key draft), or location outside the Jaipur service area |

Response: the request record (`id`, `state`, `location`, `priority`, `requiredCapability`, `assignedAgentId`, `createdAt`, `updatedAt`).

### `GET /requests/:id`
`200 { request, events[] }` · `400` if the id is not a UUID · `404` if unknown.
`events` is the audit trail: `{ fromState, toState, reason, agentId, at }`, oldest first.

### `POST /requests/:id/cancel`
Optional body `{ "reason": "caller hung up" }`.
`200` cancelled · `404` unknown · `409 { state }` when the call is already finished or the crew is on scene (ARRIVED).

### Crew answers: over the WebSocket, not REST
Offers, acknowledgements and status reports travel on the crew's existing WebSocket (see below). A real ambulance tablet already holds that connection, and the dispatcher can push offers to it instantly. Polling a REST endpoint would add seconds to every dispatch.

## Request lifecycle
Source of truth: `packages/shared/src/lifecycle.ts` (15 legal moves, tested exhaustively).
See [[Request-Lifecycle]].

## Queue: API → dispatcher (BullMQ on Redis)
| Queue | Job | Data | Job id |
|---|---|---|---|
| `dispatch` | `match` | `{ requestId }` | `match-{requestId}` (first), `match-{requestId}-{ts}` (retries) |
| `dispatch` | `offer-response` | `{ offerId, agentId, response }` | `response-{offerId}`: one answer per offer |
| `dispatch` | `offer-timeout` | `{ offerId }` (delayed by the ack timeout) | `timeout-{offerId}` |
| `dispatch` | `crew-status` | `{ agentId, status, requestId, ts }` | `status-{requestId}-{status}` |
| `dispatch` | `call-cancelled` | `{ requestId }` | `cancelled-{requestId}` |

## WebSocket: crew devices ↔ ingest (`/ws/agents`)
**Device → server**
```json
{ "type": "register", "agents": [{ "agentId": "A-0017", "capability": "ALS", "status": "AVAILABLE" }] }
{ "type": "pings", "pings": [{ "type": "ping", "agentId": "A-0017", "lat": 26.9124, "lng": 75.7873, "ts": 1730000000000 }] }
{ "type": "offer.response", "offerId": "…", "agentId": "A-0017", "response": "ACK" }
{ "type": "status", "agentId": "A-0017", "status": "AT_SCENE", "requestId": "…", "ts": 1730000000000 }
```
**Server → device** (published by the dispatcher on Redis channel `agent-commands`, relayed by ingest)
```json
{ "type": "offer", "offerId": "…", "agentId": "A-0017", "requestId": "…", "location": {…}, "priority": "P1", "requiredCapability": "ALS", "expiresAt": 0 }
{ "type": "assigned", "offerId": "…", "agentId": "A-0017", "requestId": "…", "location": {…} }
{ "type": "offer.withdrawn", "offerId": "…", "agentId": "A-0017", "requestId": "…", "reason": "no acknowledgement in time" }
```
Crew status → call state: `EN_ROUTE` → EN_ROUTE · `AT_SCENE` → ARRIVED · `AT_HOSPITAL` → COMPLETED.

## WebSocket: server → dashboards (`/ws/dashboard`)
| Event | Payload | Status |
|---|---|---|
| `fleet.snapshot` | stats + `[id, lng, lat, status, capability, lastSeenAt][]`, 1/s | ✅ live |
| (in `fleet.snapshot`) `calls` | `[id, lng, lat, state, priority, agentId, createdAt][]` + `callStats` | ✅ live |
