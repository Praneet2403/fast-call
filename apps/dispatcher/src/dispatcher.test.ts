import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createTestSql, RequestRepo } from '@fast-call/db';
import { REDIS_KEYS } from '@fast-call/shared';
import type { AgentCommand, Capability, GeoPoint } from '@fast-call/shared';
import type { DispatcherConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import type { Scheduler } from './dispatcher.js';
import { FleetOps } from './fleet.js';
import { Metrics } from './metrics.js';

// Integration: Redis DB 14 + the dispatch_test Postgres database. Skipped if either is down.
const sql = await createTestSql('dispatcher');
const redis = new Redis('redis://localhost:6379/14', { lazyConnect: true, maxRetriesPerRequest: 1 });
const redisUp = await redis.connect().then(() => true, () => false);
const ready = Boolean(sql) && redisUp;
const repo = sql ? new RequestRepo(sql) : (null as unknown as RequestRepo);

const CENTER: GeoPoint = { lat: 26.9124, lng: 75.7873 };
const config: DispatcherConfig = {
  redisUrl: '',
  ackTimeoutMs: 15_000,
  searchRadiiKm: [3, 5, 8],
  candidatesPerRing: 25,
  maxOffers: 3,
  maxWaitMs: 180_000,
  retryDelayMs: 2_000,
  concurrency: 1,
};

/** Records what the dispatcher would send to crews instead of publishing it. */
class RecordingFleet extends FleetOps {
  published: AgentCommand[] = [];
  override async publish(command: AgentCommand) {
    this.published.push(command);
  }
}

class RecordingScheduler implements Scheduler {
  matches: string[] = [];
  timeouts: string[] = [];
  async matchLater(requestId: string) {
    this.matches.push(requestId);
  }
  async offerTimeout(offerId: string) {
    this.timeouts.push(offerId);
  }
}

/** Put `n` live units in a ~1.5 km cluster around the centre. */
async function seedUnits(n: number, capability: (i: number) => Capability = () => 'BLS') {
  const pipe = redis.pipeline();
  for (let i = 0; i < n; i++) {
    const id = `A-${String(i + 1).padStart(4, '0')}`;
    const angle = (i / n) * 2 * Math.PI;
    const r = 0.003 + 0.01 * ((i * 7) % n) / n;
    pipe.geoadd(REDIS_KEYS.geo, CENTER.lng + r * Math.cos(angle), CENTER.lat + r * Math.sin(angle), id);
    pipe.hset(REDIS_KEYS.status, id, 'AVAILABLE');
    pipe.hset(REDIS_KEYS.capability, id, capability(i));
    pipe.set(REDIS_KEYS.heartbeat(id), '1', 'EX', 120);
  }
  await pipe.exec();
}

let seq = 0;
const newCall = async (capability: Capability = 'BLS', at: GeoPoint = CENTER) =>
  (await repo.create({ idempotencyKey: `disp-test-${Date.now()}-${seq++}`, location: at, priority: 'P2', requiredCapability: capability }))
    .request;

function setup(unsafeClaim = false) {
  const fleet = new RecordingFleet(redis, unsafeClaim);
  const scheduler = new RecordingScheduler();
  return { fleet, scheduler, dispatcher: new Dispatcher(repo, fleet, scheduler, config, new Metrics()) };
}

describe.skipIf(!ready)('Dispatcher (Redis + Postgres)', () => {
  beforeEach(async () => {
    await redis.flushdb();
    await sql!`TRUNCATE requests, request_events, offers`;
  });
  afterAll(async () => {
    redis.disconnect();
    await sql?.end();
  });

  describe('concurrency: 500 simultaneous calls vs 50 units', () => {
    const doubleBooked = async () =>
      sql!<{ agentId: string; n: number }[]>`
        SELECT agent_id, count(*)::int AS n FROM offers WHERE outcome = 'PENDING' GROUP BY agent_id HAVING count(*) > 1`;

    it('never offers one unit to two calls when claims are atomic', async () => {
      await seedUnits(50);
      const calls = await Promise.all(Array.from({ length: 500 }, () => newCall()));
      const { dispatcher } = setup();

      const outcomes = await Promise.all(calls.map((c) => dispatcher.handleMatch(c.id)));

      expect(outcomes.filter((o) => o.kind === 'offered')).toHaveLength(50); // every unit used once
      expect(outcomes.filter((o) => o.kind === 'retry-later')).toHaveLength(450); // the rest wait
      expect(await doubleBooked()).toEqual([]);
      const statuses = Object.values(await redis.hgetall(REDIS_KEYS.status));
      expect(statuses.every((s) => s === 'DISPATCHED')).toBe(true);
    }, 30_000);

    it('DOES double-book units with a naive read-then-write claim (the bug the lock prevents)', async () => {
      await seedUnits(50);
      const calls = await Promise.all(Array.from({ length: 500 }, () => newCall()));
      const { dispatcher } = setup(true);

      await Promise.all(calls.map((c) => dispatcher.handleMatch(c.id)));

      const doubles = await doubleBooked();
      // Record the evidence for the README / Challenges Log.
      console.log(`[unsafe claim] ${doubles.length} units offered to 2+ calls at once, worst: ${Math.max(...doubles.map((d) => d.n))} calls`);
      expect(doubles.length).toBeGreaterThan(0);
    }, 30_000);
  });

  describe('offer lifecycle', () => {
    it('offers the nearest unit that can do the job, skipping BLS units for an ALS call', async () => {
      await seedUnits(10, (i) => (i === 9 ? 'ALS' : 'BLS'));
      const { dispatcher, fleet } = setup();
      const call = await newCall('ALS');
      const outcome = await dispatcher.handleMatch(call.id);
      expect(outcome).toMatchObject({ kind: 'offered', agentId: 'A-0010' });
      expect(fleet.published[0]).toMatchObject({ type: 'offer', agentId: 'A-0010', requestId: call.id });
      expect((await repo.get(call.id))!.state).toBe('OFFERED');
    });

    it('skips units whose GPS heartbeat has expired', async () => {
      await seedUnits(2);
      await redis.del(REDIS_KEYS.heartbeat('A-0001'), REDIS_KEYS.heartbeat('A-0002'));
      const { dispatcher } = setup();
      expect((await dispatcher.handleMatch((await newCall()).id)).kind).toBe('retry-later');
    });

    it('on ACK: assigns the call, releases the lock, keeps the unit busy, tells the crew', async () => {
      await seedUnits(3);
      const { dispatcher, fleet } = setup();
      const call = await newCall();
      const offer = await dispatcher.handleMatch(call.id);
      if (offer.kind !== 'offered') throw new Error('expected an offer');

      await dispatcher.handleOfferResponse({ offerId: offer.offerId, agentId: offer.agentId, response: 'ACK' });

      expect((await repo.get(call.id))!).toMatchObject({ state: 'ASSIGNED', assignedAgentId: offer.agentId });
      expect(await redis.get(REDIS_KEYS.lock(offer.agentId))).toBeNull();
      expect(await redis.hget(REDIS_KEYS.status, offer.agentId)).toBe('DISPATCHED');
      expect(fleet.published.at(-1)).toMatchObject({ type: 'assigned', agentId: offer.agentId });
    });

    it('on timeout: frees the unit, withdraws the offer and re-matches the call', async () => {
      await seedUnits(3);
      const { dispatcher, fleet, scheduler } = setup();
      const call = await newCall();
      const offer = await dispatcher.handleMatch(call.id);
      if (offer.kind !== 'offered') throw new Error('expected an offer');

      await dispatcher.handleOfferTimeout({ offerId: offer.offerId });

      expect((await repo.get(call.id))!.state).toBe('MATCHING');
      expect(await redis.hget(REDIS_KEYS.status, offer.agentId)).toBe('AVAILABLE');
      expect(await redis.get(REDIS_KEYS.lock(offer.agentId))).toBeNull();
      expect(fleet.published.at(-1)).toMatchObject({ type: 'offer.withdrawn', agentId: offer.agentId });
      expect(scheduler.matches).toEqual([call.id]);

      // The next attempt goes to a different unit.
      const second = await dispatcher.handleMatch(call.id);
      expect(second.kind === 'offered' && second.agentId).not.toBe(offer.agentId);
    });

    it('ignores an answer from a unit the offer was not made to', async () => {
      await seedUnits(2);
      const { dispatcher } = setup();
      const call = await newCall();
      const offer = await dispatcher.handleMatch(call.id);
      if (offer.kind !== 'offered') throw new Error('expected an offer');
      await dispatcher.handleOfferResponse({ offerId: offer.offerId, agentId: 'A-9999', response: 'ACK' });
      expect((await repo.get(call.id))!.state).toBe('OFFERED');
    });

    it('expires a call after maxOffers units fail to acknowledge', async () => {
      await seedUnits(5);
      const { dispatcher } = setup();
      const call = await newCall();
      for (let i = 0; i < config.maxOffers; i++) {
        const offer = await dispatcher.handleMatch(call.id);
        if (offer.kind !== 'offered') throw new Error('expected an offer');
        await dispatcher.handleOfferTimeout({ offerId: offer.offerId });
      }
      expect(await dispatcher.handleMatch(call.id)).toMatchObject({ kind: 'expired' });
      expect((await repo.get(call.id))!.state).toBe('EXPIRED');
    });

    it('drives the call to COMPLETED from crew status reports', async () => {
      await seedUnits(1);
      const { dispatcher } = setup();
      const call = await newCall();
      const offer = await dispatcher.handleMatch(call.id);
      if (offer.kind !== 'offered') throw new Error('expected an offer');
      await dispatcher.handleOfferResponse({ offerId: offer.offerId, agentId: offer.agentId, response: 'ACK' });

      let ts = Date.now();
      for (const status of ['EN_ROUTE', 'AT_SCENE', 'TRANSPORTING', 'AT_HOSPITAL', 'AVAILABLE'] as const) {
        await dispatcher.handleCrewStatus({ agentId: offer.agentId, status, requestId: call.id, ts: ts++ });
      }
      const events = await repo.events(call.id);
      expect(events.map((e) => e.toState)).toEqual(['CREATED', 'MATCHING', 'OFFERED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'COMPLETED']);
      expect(await redis.hget(REDIS_KEYS.status, offer.agentId)).toBe('AVAILABLE');
    });

    it('copes with crew reports processed out of order', async () => {
      await seedUnits(1);
      const { dispatcher } = setup();
      const call = await newCall();
      const offer = await dispatcher.handleMatch(call.id);
      if (offer.kind !== 'offered') throw new Error('expected an offer');
      await dispatcher.handleOfferResponse({ offerId: offer.offerId, agentId: offer.agentId, response: 'ACK' });
      const t = Date.now();

      // AT_SCENE is processed before EN_ROUTE: the call still walks through EN_ROUTE to ARRIVED.
      await dispatcher.handleCrewStatus({ agentId: offer.agentId, status: 'AT_SCENE', requestId: call.id, ts: t + 2 });
      await dispatcher.handleCrewStatus({ agentId: offer.agentId, status: 'EN_ROUTE', requestId: call.id, ts: t + 1 });
      expect((await repo.events(call.id)).map((e) => e.toState).slice(-2)).toEqual(['EN_ROUTE', 'ARRIVED']);
      // …and the older EN_ROUTE report did not overwrite the unit's newer AT_SCENE status.
      expect(await redis.hget(REDIS_KEYS.status, offer.agentId)).toBe('AT_SCENE');
    });

    it('frees the offered unit when the call is cancelled', async () => {
      await seedUnits(1);
      const { dispatcher, fleet } = setup();
      const call = await newCall();
      const offer = await dispatcher.handleMatch(call.id);
      if (offer.kind !== 'offered') throw new Error('expected an offer');
      await repo.transition(call.id, 'CANCELLED', { reason: 'caller hung up' });

      await dispatcher.handleCallCancelled({ requestId: call.id });

      expect(await redis.hget(REDIS_KEYS.status, offer.agentId)).toBe('AVAILABLE');
      expect(fleet.published.at(-1)).toMatchObject({ type: 'offer.withdrawn', reason: 'call cancelled' });
    });
  });
});
