import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '@fast-call/shared';
import { RequestRepo } from './requests.js';
import type { NewRequest } from './requests.js';
import { createTestSql } from './testing.js';

const sql = await createTestSql();
const repo = sql ? new RequestRepo(sql) : (null as unknown as RequestRepo);

let n = 0;
const call = (overrides: Partial<NewRequest> = {}): NewRequest => ({
  idempotencyKey: `test-${Date.now()}-${n++}`,
  location: { lat: 26.9124, lng: 75.7873 },
  priority: 'P1',
  requiredCapability: 'ALS',
  ...overrides,
});

describe.skipIf(!sql)('RequestRepo (Postgres)', () => {
  beforeEach(async () => {
    await sql!`TRUNCATE requests, request_events, offers`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  describe('create', () => {
    it('creates a request in CREATED and records the first event', async () => {
      const r = await repo.create(call());
      expect(r.kind).toBe('created');
      expect(r.request).toMatchObject({ state: 'CREATED', priority: 'P1', requiredCapability: 'ALS' });
      expect(r.request.location.lat).toBeCloseTo(26.9124, 6);
      expect(await repo.events(r.request.id)).toMatchObject([{ fromState: null, toState: 'CREATED' }]);
    });

    it('returns the original request when the same call is retried', async () => {
      const input = call();
      const first = await repo.create(input);
      const retry = await repo.create(input);
      expect(retry.kind).toBe('existing');
      expect(retry.request.id).toBe(first.request.id);
      const [{ count }] = await sql!`SELECT count(*)::int AS count FROM requests`;
      expect(count).toBe(1);
    });

    it('flags a conflict when a key is reused with a different body', async () => {
      const input = call();
      await repo.create(input);
      expect((await repo.create({ ...input, priority: 'P3' })).kind).toBe('conflict');
    });

    it('creates exactly one request when 25 identical POSTs race', async () => {
      const input = call();
      const results = await Promise.all(Array.from({ length: 25 }, () => repo.create(input)));
      expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'existing')).toHaveLength(24);
      expect(new Set(results.map((r) => r.request.id)).size).toBe(1);
      const [{ count }] = await sql!`SELECT count(*)::int AS count FROM requests`;
      expect(count).toBe(1);
    });
  });

  describe('transition', () => {
    it('walks the happy path and logs every step in order', async () => {
      const { request } = await repo.create(call());
      await repo.transition(request.id, 'MATCHING', { reason: 'dispatcher picked up' });
      await repo.transition(request.id, 'OFFERED', { reason: 'offer sent', agentId: 'A-0007' });
      await repo.transition(request.id, 'ASSIGNED', { reason: 'crew acknowledged', agentId: 'A-0007' });
      expect((await repo.get(request.id))!.assignedAgentId).toBe('A-0007');
      await repo.transition(request.id, 'EN_ROUTE', { reason: 'driving' });
      await repo.transition(request.id, 'ARRIVED', { reason: 'on scene' });
      await repo.transition(request.id, 'COMPLETED', { reason: 'patient handed over' });

      const events = await repo.events(request.id);
      expect(events.map((e) => e.toState)).toEqual([
        'CREATED', 'MATCHING', 'OFFERED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'COMPLETED',
      ]);
      expect((await repo.get(request.id))!.assignedAgentId).toBe('A-0007'); // kept for history
    });

    it('clears the unit when a call goes back to MATCHING', async () => {
      const { request } = await repo.create(call());
      await repo.transition(request.id, 'MATCHING', { reason: 'r' });
      await repo.transition(request.id, 'OFFERED', { reason: 'r', agentId: 'A-0001' });
      await repo.transition(request.id, 'ASSIGNED', { reason: 'r', agentId: 'A-0001' });
      await repo.transition(request.id, 'MATCHING', { reason: 'unit went stale' });
      expect((await repo.get(request.id))!.assignedAgentId).toBeNull();
    });

    it('rejects an illegal move and writes nothing', async () => {
      const { request } = await repo.create(call());
      await expect(repo.transition(request.id, 'COMPLETED', { reason: 'nope' })).rejects.toThrow(IllegalTransitionError);
      expect((await repo.get(request.id))!.state).toBe('CREATED');
      expect(await repo.events(request.id)).toHaveLength(1);
    });

    it('lets only one of 10 racing workers apply the same move', async () => {
      const { request } = await repo.create(call());
      await repo.transition(request.id, 'MATCHING', { reason: 'r' });
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.transition(request.id, 'OFFERED', { reason: `worker ${i}`, agentId: `A-000${i}`, onlyFrom: ['MATCHING'] }),
        ),
      );
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect((await repo.events(request.id)).filter((e) => e.toState === 'OFFERED')).toHaveLength(1);
    });

    it('has the database refuse a unit on two live calls, rolling back the event too', async () => {
      const a = (await repo.create(call())).request;
      const b = (await repo.create(call())).request;
      for (const r of [a, b]) {
        await repo.transition(r.id, 'MATCHING', { reason: 'r' });
        await repo.transition(r.id, 'OFFERED', { reason: 'r', agentId: 'A-0042' });
      }
      await repo.transition(a.id, 'ASSIGNED', { reason: 'ack', agentId: 'A-0042' });
      await expect(repo.transition(b.id, 'ASSIGNED', { reason: 'ack', agentId: 'A-0042' })).rejects.toThrow(
        /requests_one_live_call_per_unit/,
      );
      expect((await repo.get(b.id))!.state).toBe('OFFERED');
      expect((await repo.events(b.id)).some((e) => e.toState === 'ASSIGNED')).toBe(false);
    });
  });
});
