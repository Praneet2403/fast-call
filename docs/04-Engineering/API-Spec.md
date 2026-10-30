---
type: spec
status: draft
---
# API & Event Spec

> [!todo] ✍️ Fill each endpoint as you build it. Write the spec **before** the code.

## REST
| Method | Path | Purpose | Phase |
|---|---|---|---|
| POST | `/requests` | Create a request (requires `Idempotency-Key` header) | 2 |
| GET | `/requests/:id` | Request + current state | 2 |
| POST | `/requests/:id/cancel` | Cancel | 2 |
| POST | `/offers/:id/accept` | Agent accepts | 2 |
| POST | `/offers/:id/decline` | Agent declines | 2 |

## WebSocket: agent → server
```json
{ "type": "ping", "agentId": "A-17", "lat": 23.25, "lng": 77.41, "ts": 1730000000000 }
```

## WebSocket: server → dashboard
| Event | Payload | Phase |
|---|---|---|
| `fleet.snapshot` | batched positions, 1/s | 1 |
| `request.state_changed` | id, from, to, reason | 2 |
| `offer.created` | requestId, agentId, score, breakdown | 2 |
