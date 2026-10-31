import { assertTransition } from '@fast-call/shared';
import type {
  CallRow,
  Capability,
  DispatchRequest,
  GeoPoint,
  OfferOutcome,
  Priority,
  RequestState,
  Timestamp,
} from '@fast-call/shared';
import type { Sql, Tx } from './client.js';

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
      const from = await lockState(tx, id);
      if (opts.onlyFrom && !opts.onlyFrom.includes(from)) return { applied: false, current: from };
      await applyTransition(tx, id, from, to, opts);
      return { applied: true, from, to };
    });
  }

  // ---- offers ----

  /**
   * Offer a MATCHING call to a unit: insert the offer and move the call to OFFERED atomically.
   * Returns `created: false` if the call left MATCHING meanwhile (e.g. it was cancelled).
   */
  async createOffer(
    requestId: string,
    agentId: string,
    ttlMs: number,
    meta: { reason: string; score?: number; breakdown?: Record<string, number> },
  ): Promise<{ created: true; offer: OfferRecord } | { created: false; current: RequestState }> {
    return this.sql.begin(async (tx) => {
      const from = await lockState(tx, requestId);
      if (from !== 'MATCHING') return { created: false, current: from };
      const [row] = await tx<OfferRow[]>`
        INSERT INTO offers (request_id, agent_id, expires_at, score, score_breakdown)
        VALUES (${requestId}, ${agentId}, now() + ${ttlMs} * interval '1 millisecond',
                ${meta.score ?? null}, ${meta.breakdown ? tx.json(meta.breakdown) : null})
        RETURNING id, request_id, agent_id, sent_at, expires_at, outcome`;
      await applyTransition(tx, requestId, from, 'OFFERED', { reason: meta.reason, agentId });
      return { created: true, offer: toOffer(row!) };
    });
  }

  /**
   * Settle an offer exactly once. The crew's answer and the timeout race each other; whichever
   * locks the offer row first wins, and the other finds it no longer PENDING and does nothing.
   *  ACKNOWLEDGED → call ASSIGNED to the unit · UNABLE / TIMED_OUT → call back to MATCHING.
   *  If the call was cancelled meanwhile, the offer is marked CANCELLED instead.
   */
  async resolveOffer(offerId: string, outcome: 'ACKNOWLEDGED' | 'UNABLE' | 'TIMED_OUT'): Promise<ResolveResult> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<OfferRow[]>`
        SELECT id, request_id, agent_id, sent_at, expires_at, outcome FROM offers WHERE id = ${offerId} FOR UPDATE`;
      if (!row) return { resolved: false, reason: 'not-found' };
      const offer = toOffer(row);
      if (offer.outcome !== 'PENDING') return { resolved: false, reason: 'already-resolved', offer };

      const callState = await lockState(tx, offer.requestId);
      if (callState !== 'OFFERED') {
        await tx`UPDATE offers SET outcome = 'CANCELLED' WHERE id = ${offerId}`;
        return { resolved: true, outcome: 'CANCELLED', offer, callState };
      }

      await tx`UPDATE offers SET outcome = ${outcome} WHERE id = ${offerId}`;
      if (outcome === 'ACKNOWLEDGED') {
        await applyTransition(tx, offer.requestId, 'OFFERED', 'ASSIGNED', { reason: 'crew acknowledged', agentId: offer.agentId });
        return { resolved: true, outcome, offer, callState: 'ASSIGNED' };
      }
      const reason = outcome === 'UNABLE' ? 'crew unable to respond' : 'crew did not acknowledge in time';
      await applyTransition(tx, offer.requestId, 'OFFERED', 'MATCHING', { reason, agentId: offer.agentId });
      return { resolved: true, outcome, offer, callState: 'MATCHING' };
    });
  }

  /** Units already offered this call: never offer the same call to them twice. */
  async offeredAgents(requestId: string): Promise<string[]> {
    const rows = await this.sql<{ agentId: string }[]>`SELECT agent_id FROM offers WHERE request_id = ${requestId}`;
    return rows.map((r) => r.agentId);
  }

  async getOffer(offerId: string): Promise<OfferRecord | null> {
    const [row] = await this.sql<OfferRow[]>`
      SELECT id, request_id, agent_id, sent_at, expires_at, outcome FROM offers WHERE id = ${offerId}`;
    return row ? toOffer(row) : null;
  }

  async pendingOffer(requestId: string): Promise<OfferRecord | null> {
    const [row] = await this.sql<OfferRow[]>`
      SELECT id, request_id, agent_id, sent_at, expires_at, outcome FROM offers
      WHERE request_id = ${requestId} AND outcome = 'PENDING'`;
    return row ? toOffer(row) : null;
  }

  // ---- dashboard read model ----

  /** Live calls with the unit assigned to them, or currently being offered them. */
  async liveCalls(): Promise<CallRow[]> {
    const rows = await this.sql<
      { id: string; lat: number; lng: number; state: RequestState; priority: Priority; agentId: string | null; createdAt: Date }[]
    >`
      SELECT r.id, r.lat, r.lng, r.state, r.priority, COALESCE(r.assigned_agent_id, o.agent_id) AS agent_id, r.created_at
      FROM request_view r
      LEFT JOIN offers o ON o.request_id = r.id AND o.outcome = 'PENDING'
      WHERE r.state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
      ORDER BY r.created_at`;
    return rows.map((r) => [r.id, r.lng, r.lat, r.state, r.priority, r.agentId, r.createdAt.getTime()]);
  }

  async finishedLastHour(): Promise<Partial<Record<RequestState, number>>> {
    const rows = await this.sql<{ state: RequestState; n: number }[]>`
      SELECT state, count(*)::int AS n FROM requests
      WHERE state IN ('COMPLETED', 'CANCELLED', 'EXPIRED') AND updated_at > now() - interval '1 hour'
      GROUP BY state`;
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}

async function lockState(tx: Tx, id: string): Promise<RequestState> {
  const [row] = await tx<{ state: RequestState }[]>`SELECT state FROM requests WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new RequestNotFoundError(id);
  return row.state;
}

/** Validates against the lifecycle table, updates the row and appends the audit event. Caller holds the row lock. */
async function applyTransition(tx: Tx, id: string, from: RequestState, to: RequestState, opts: TransitionOptions) {
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
}

export interface OfferRecord {
  id: string;
  requestId: string;
  agentId: string;
  sentAt: Timestamp;
  expiresAt: Timestamp;
  outcome: OfferOutcome;
}

interface OfferRow {
  id: string;
  requestId: string;
  agentId: string;
  sentAt: Date;
  expiresAt: Date;
  outcome: OfferOutcome;
}

const toOffer = (r: OfferRow): OfferRecord => ({
  id: r.id,
  requestId: r.requestId,
  agentId: r.agentId,
  sentAt: r.sentAt.getTime(),
  expiresAt: r.expiresAt.getTime(),
  outcome: r.outcome,
});

export type ResolveResult =
  | { resolved: false; reason: 'not-found' }
  | { resolved: false; reason: 'already-resolved'; offer: OfferRecord }
  | {
      resolved: true;
      outcome: 'ACKNOWLEDGED' | 'UNABLE' | 'TIMED_OUT' | 'CANCELLED';
      offer: OfferRecord;
      callState: RequestState;
    };
