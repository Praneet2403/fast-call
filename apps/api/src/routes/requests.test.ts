import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSql, RequestRepo } from '@fast-call/db';
import type { DispatchQueue } from '../queue.js';
import { buildServer } from '../server.js';
import { FleetStore } from '../store.js';

const sql = await createTestSql('api');

/** Records enqueues instead of talking to BullMQ, so these tests only need Postgres. */
class FakeQueue implements DispatchQueue {
  jobs: string[] = [];
  async enqueueMatch(requestId: string) {
    this.jobs.push(requestId);
  }
  async enqueueOfferResponse() {}
  async enqueueCrewStatus() {}
  async enqueueCallCancelled() {}
  async close() {}
}

const queue = new FakeQueue();
// FleetStore connects lazily and is never used by these routes.
const store = new FleetStore('redis://localhost:6379/15', 15);
const app = sql
  ? await buildServer(
      { port: 0, host: '127.0.0.1', redisUrl: '', heartbeatTtlSec: 15, snapshotIntervalMs: 60_000 },
      { store, requests: new RequestRepo(sql), queue },
    )
  : null;

let n = 0;
const key = () => `test-key-${Date.now()}-${n++}`;
const body = { lat: 26.9124, lng: 75.7873, priority: 'P1', requiredCapability: 'ALS' };

const post = (payload: object, headers: Record<string, string> = {}) =>
  app!.inject({ method: 'POST', url: '/requests', payload, headers });

describe.skipIf(!sql)('request API', () => {
  beforeEach(async () => {
    await sql!`TRUNCATE requests, request_events, offers`;
    queue.jobs = [];
  });
  afterAll(async () => {
    await app?.close();
    store.redis.disconnect();
    await sql?.end();
  });

  it('reports ready (200) when Redis and Postgres both answer', async () => {
    const res = await app!.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.map((c: { ok: boolean }) => c.ok)).toEqual([true, true]);
  });

  it('reports not ready (503) with per-dependency detail when Redis is unreachable', async () => {
    const deadRedis = new FleetStore('redis://127.0.0.1:1/0', 15); // nothing listens on port 1
    const app2 = await buildServer(
      { port: 0, host: '127.0.0.1', redisUrl: '', heartbeatTtlSec: 15, snapshotIntervalMs: 60_000 },
      { store: deadRedis, requests: new RequestRepo(sql!), queue },
    );
    const res = await app2.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const checks = res.json().checks as { name: string; ok: boolean }[];
    expect(checks.find((c) => c.name === 'postgres')!.ok).toBe(true);
    expect(checks.find((c) => c.name === 'redis')!.ok).toBe(false);
    await app2.close();
    deadRedis.redis.disconnect();
  });

  it('creates a call (201), enqueues one match job, and sets Location', async () => {
    const res = await post(body, { 'idempotency-key': key() });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({ state: 'CREATED', priority: 'P1', requiredCapability: 'ALS' });
    expect(res.headers.location).toBe(`/requests/${created.id}`);
    expect(queue.jobs).toEqual([created.id]);
  });

  it('replays a retried call (200) with the same id and the Idempotent-Replayed header', async () => {
    const k = key();
    const first = (await post(body, { 'idempotency-key': k })).json();
    const retry = await post(body, { 'idempotency-key': k });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json().id).toBe(first.id);
  });

  it('rejects a reused key with a different body (422)', async () => {
    const k = key();
    await post(body, { 'idempotency-key': k });
    const res = await post({ ...body, priority: 'P3' }, { 'idempotency-key': k });
    expect(res.statusCode).toBe(422);
  });

  it('requires an Idempotency-Key (400)', async () => {
    expect((await post(body)).statusCode).toBe(400);
    expect((await post(body, { 'idempotency-key': 'short' })).statusCode).toBe(400);
  });

  it('validates the body (400) and the service area (422)', async () => {
    expect((await post({ ...body, priority: 'P9' }, { 'idempotency-key': key() })).statusCode).toBe(400);
    expect((await post({ lat: 26.9 }, { 'idempotency-key': key() })).statusCode).toBe(400);
    const delhi = await post({ ...body, lat: 28.61, lng: 77.21 }, { 'idempotency-key': key() });
    expect(delhi.statusCode).toBe(422);
  });

  it('returns a call with its event history, 404 for unknown, 400 for a bad id', async () => {
    const created = (await post(body, { 'idempotency-key': key() })).json();
    const res = await app!.inject({ method: 'GET', url: `/requests/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().events.map((e: { toState: string }) => e.toState)).toEqual(['CREATED']);
    expect((await app!.inject({ method: 'GET', url: '/requests/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'GET', url: '/requests/not-a-uuid' })).statusCode).toBe(400);
  });

  it('cancels a live call (200), then refuses to cancel it again (409)', async () => {
    const created = (await post(body, { 'idempotency-key': key() })).json();
    const url = `/requests/${created.id}/cancel`;
    const cancel = await app!.inject({ method: 'POST', url, payload: { reason: 'caller hung up' } });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().state).toBe('CANCELLED');
    const again = await app!.inject({ method: 'POST', url });
    expect(again.statusCode).toBe(409);
    expect(again.json().state).toBe('CANCELLED');
  });

  it('handles 20 concurrent retries of one call: one row, every response has the same id', async () => {
    const k = key();
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(body, { 'idempotency-key': k })));
    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 200)).toHaveLength(19);
    expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
  });
});
