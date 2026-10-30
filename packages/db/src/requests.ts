import { assertTransition } from '@fast-call/shared';
import type { Capability, DispatchRequest, GeoPoint, Priority, RequestState, Timestamp } from '@fast-call/shared';
import type { Sql } from './client.js';

export interface RequestRecord extends DispatchRequest {
  idempotencyKey: string;
  assignedAgentId: string | null;
  updatedAt: Timestamp;
}

export interface RequestEvent {
  id: number;
  fromState: RequestState | null;
  toState: RequestState;
  reason: string;
  agentId: string | null;
  at: Timestamp;
}

export interface NewRequest {
  idempotencyKey: string;
  location: GeoPoint;
  priority: Priority;
  requiredCapability: Capability;
}

export type CreateResult =
  /** First time we saw this key. */
  | { kind: 'created'; request: RequestRecord }
  /** Retry of an earlier call with the same key and same body: return the original. */
  | { kind: 'existing'; request: RequestRecord }
  /** Same key, different body: almost certainly a client bug, so refuse it. */
  | { kind: 'conflict'; request: RequestRecord };

export interface TransitionOptions {
  reason: string;
  agentId?: string;
  /** Only apply if the request is currently in one of these states (for retried / racing workers). */
  onlyFrom?: RequestState[];
}

export type TransitionResult =
  | { applied: true; from: RequestState; to: RequestState }
  | { applied: false; current: RequestState };

export class RequestNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`request ${id} not found`);
    this.name = 'RequestNotFoundError';
  }
}

interface RequestRow {
  id: string;
  idempotencyKey: string;
  lat: number;
  lng: number;
  priority: Priority;
  requiredCapability: Capability;
  state: RequestState;
  assignedAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(r: RequestRow): RequestRecord {
  return {
    id: r.id,
    idempotencyKey: r.idempotencyKey,
    location: { lat: r.lat, lng: r.lng },
    priority: r.priority,
    requiredCapability: r.requiredCapability,
    state: r.state,
    assignedAgentId: r.assignedAgentId,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

const sameBody = (r: RequestRecord, n: NewRequest) =>
  r.priority === n.priority &&
  r.requiredCapability === n.requiredCapability &&
  Math.abs(r.location.lat - n.location.lat) < 1e-6 &&
  Math.abs(r.location.lng - n.location.lng) < 1e-6;

export class RequestRepo {
  constructor(private readonly sql: Sql) {}

  /**
   * Idempotent create. `ON CONFLICT DO NOTHING` on the unique key means two concurrent POSTs
   * with the same key can't both insert: the second waits for the first to commit, inserts
   * nothing, then reads the winner's row. No duplicate emergency call, no 500.
   */
  async create(input: NewRequest): Promise<CreateResult> {
    return this.sql.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO requests (idempotency_key, location, priority, required_capability, state)
        VALUES (
          ${input.idempotencyKey},
          ST_SetSRID(ST_MakePoint(${input.location.lng}, ${input.location.lat}), 4326)::geography,
          ${input.priority},
          ${input.requiredCapability},
          'CREATED'
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id`;

      if (inserted.length > 0) {
        const id = inserted[0]!.id;
        await tx`
          INSERT INTO request_events (request_id, from_state, to_state, reason)
          VALUES (${id}, NULL, 'CREATED', 'call received')`;
        const [row] = await tx<RequestRow[]>`SELECT * FROM request_view WHERE id = ${id}`;
        return { kind: 'created', request: toRecord(row!) };
      }

      const [row] = await tx<RequestRow[]>`SELECT * FROM request_view WHERE idempotency_key = ${input.idempotencyKey}`;
      const existing = toRecord(row!);
      return { kind: sameBody(existing, input) ? 'existing' : 'conflict', request: existing };
    });
  }

  async get(id: string): Promise<RequestRecord | null> {
    const [row] = await this.sql<RequestRow[]>`SELECT * FROM request_view WHERE id = ${id}`;
    return row ? toRecord(row) : null;
  }

  async events(id: string): Promise<RequestEvent[]> {
    const rows = await this.sql<(Omit<RequestEvent, 'at' | 'id'> & { id: string; at: Date })[]>`
      SELECT id, from_state, to_state, reason, agent_id, at
      FROM request_events WHERE request_id = ${id} ORDER BY id`;
    return rows.map((e) => ({ ...e, id: Number(e.id), at: e.at.getTime() }));
  }

  /**
   * The only way a request changes state. In one transaction it:
   *  1. locks the row (SELECT … FOR UPDATE), so a cancel and an acknowledgement can't interleave,
   *  2. checks the move against the lifecycle table,
   *  3. updates the row and appends the audit event.
   * Either both writes happen or neither does.
   */
  async transition(id: string, to: RequestState, opts: TransitionOptions): Promise<TransitionResult> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<{ state: RequestState }[]>`SELECT state FROM requests WHERE id = ${id} FOR UPDATE`;
      if (!row) throw new RequestNotFoundError(id);
      const from = row.state;
      if (opts.onlyFrom && !opts.onlyFrom.includes(from)) return { applied: false, current: from };
      assertTransition(from, to);

      if (to === 'ASSIGNED' && !opts.agentId) throw new Error('ASSIGNED requires an agentId');
      // Keep the unit on the record for history; drop it only when the call goes back to matching.
      const agent = to === 'ASSIGNED' ? opts.agentId! : to === 'MATCHING' ? null : undefined;

      if (agent === undefined) {
        await tx`UPDATE requests SET state = ${to}, updated_at = now() WHERE id = ${id}`;
      } else {
        await tx`UPDATE requests SET state = ${to}, assigned_agent_id = ${agent}, updated_at = now() WHERE id = ${id}`;
      }
      await tx`
        INSERT INTO request_events (request_id, from_state, to_state, reason, agent_id)
        VALUES (${id}, ${from}, ${to}, ${opts.reason}, ${opts.agentId ?? null})`;
      return { applied: true, from, to };
    });
  }
}
