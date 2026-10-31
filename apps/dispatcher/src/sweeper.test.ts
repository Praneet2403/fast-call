import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createTestSql, RequestRepo } from '@fast-call/db';
import { REDIS_KEYS } from '@fast-call/shared';
import type { AgentCommand } from '@fast-call/shared';
import type { DispatcherConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import type { Scheduler } from './dispatcher.js';
import { FleetOps } from './fleet.js';
import { Metrics } from './metrics.js';
import { Sweeper } from './sweeper.js';

// Integration: Redis DB 13 + its own Postgres database. Skipped if either is down.
const sql = await createTestSql('sweeper');
const redis = new Redis('redis://localhost:6379/13', { lazyConnect: true, maxRetriesPerRequest: 1 });
const ready = Boolean(sql) && (await redis.connect().then(() => true, () => false));
const repo = sql ? new RequestRepo(sql) : (null as unknown as RequestRepo);

const config: DispatcherConfig = {
  redisUrl: '', ackTimeoutMs: 15_000, searchRadiiKm: [3, 5, 8], candidatesPerRing: 25, maxOffers: 5,
  maxWaitMs: 180_000, retryDelayMs: 2_000, concurrency: 1, sweepIntervalMs: 5_000, stallMs: 0, offerGraceMs: 0,
};

class RecordingFleet extends FleetOps {
  published: AgentCommand[] = [];
  override async publish(command: AgentCommand) {
    this.published.push(command);
  }
}
class RecordingScheduler implements Scheduler {
  matches: string[] = [];
  rescues: string[] = [];
  async matchLater(id: string) {
    this.matches.push(id);
  }
  async offerTimeout() {}
  async matchRescue(id: string) {
    this.rescues.push(id);
  }
}

function setup() {
  const fleet = new RecordingFleet(redis);
  const scheduler = new RecordingScheduler();
  const dispatcher = new Dispatcher(repo, fleet, scheduler, config, new Metrics());
  const sweeper = new Sweeper(repo, fleet, scheduler, dispatcher, { stallMs: 0, offerGraceMs: 0 });
  return { fleet, scheduler, dispatcher, sweeper };
}

async function seedUnit(id: string) {
  await redis
    .multi()
    .geoadd(REDIS_KEYS.geo, 75.7873, 26.9124, id)
    .hset(REDIS_KEYS.status, id, 'AVAILABLE')
    .hset(REDIS_KEYS.capability, id, 'ALS')
    .set(REDIS_KEYS.heartbeat(id), '1', 'EX', 120)
    .exec();
}

let seq = 0;
const newCall = async () =>
  (await repo.create({
    idempotencyKey: `sweep-test-${Date.now()}-${seq++}`,
    location: { lat: 26.9124, lng: 75.7873 },
    priority: 'P1',
    requiredCapability: 'ALS',
  })).request;

/** Drive a call all the way to EN_ROUTE with the given unit. */
async function callEnRoute(dispatcher: Dispatcher) {
  const call = await newCall();
  const offer = await dispatcher.handleMatch(call.id);
  if (offer.kind !== 'offered') throw new Error('expected an offer');
  await dispatcher.handleOfferResponse({ offerId: offer.offerId, agentId: offer.agentId, response: 'ACK' });
  await dispatcher.handleCrewStatus({ agentId: offer.agentId, status: 'EN_ROUTE', requestId: call.id, ts: Date.now() });
  return { call, agentId: offer.agentId };
}

describe.skipIf(!ready)('Sweeper (Redis + Postgres)', () => {
  beforeEach(async () => {
    await redis.flushdb();
    await sql!`TRUNCATE requests, request_events, offers`;
  });
  afterAll(async () => {
    redis.disconnect();
    await sql?.end();
  });

  it('re-enqueues a call that was saved but never queued (API crashed before enqueue)', async () => {
    const { sweeper, scheduler } = setup();
    const call = await newCall(); // CREATED, and no job was ever added
    expect((await sweeper.sweep()).rescuedCalls).toBe(1);
    expect(scheduler.rescues).toEqual([call.id]);
  });

  it('settles an offer whose timeout job was lost, freeing the unit and re-matching', async () => {
    await seedUnit('A-0001');
    const { sweeper, dispatcher, scheduler } = setup();
    const call = await newCall();
    await dispatcher.handleMatch(call.id);
    await sql!`UPDATE offers SET expires_at = now() - interval '1 minute'`; // the timeout never fired

    expect((await sweeper.sweep()).overdueOffers).toBe(1);
    expect((await repo.get(call.id))!.state).toBe('MATCHING');
    expect(await redis.hget(REDIS_KEYS.status, 'A-0001')).toBe('AVAILABLE');
    expect(scheduler.matches).toContain(call.id);
  });

  it('reassigns a call when the unit driving to it goes silent', async () => {
    await seedUnit('A-0001');
    const { sweeper, dispatcher, fleet, scheduler } = setup();
    const { call, agentId } = await callEnRoute(dispatcher);
    await redis.del(REDIS_KEYS.heartbeat(agentId)); // the unit's GPS goes dark

    expect((await sweeper.sweep()).reassignedCalls).toBe(1);
    const after = (await repo.get(call.id))!;
    expect(after.state).toBe('MATCHING');
    expect(after.assignedAgentId).toBeNull();
    expect(await redis.hget(REDIS_KEYS.status, agentId)).toBe('OFFLINE');
    expect(fleet.published.at(-1)).toMatchObject({ type: 'offer.withdrawn', agentId, reason: expect.stringContaining('lost contact') });
    expect(scheduler.matches).toContain(call.id);
    expect((await repo.events(call.id)).at(-1)!.reason).toContain('went silent');

    // A second sweep does nothing more: the repair is idempotent.
    expect((await sweeper.sweep()).reassignedCalls).toBe(0);
  });

  it('puts a lost unit back in service once it reports AVAILABLE for its old call', async () => {
    await seedUnit('A-0001');
    const { sweeper, dispatcher } = setup();
    const { call, agentId } = await callEnRoute(dispatcher);
    await redis.del(REDIS_KEYS.heartbeat(agentId));
    await sweeper.sweep();

    // The unit reconnects, finishes its (now reassigned) trip and reports itself free.
    await dispatcher.handleCrewStatus({ agentId, status: 'AVAILABLE', requestId: call.id, ts: Date.now() + 1000 });
    expect(await redis.hget(REDIS_KEYS.status, agentId)).toBe('AVAILABLE');
    // …but its late report can't drag the reassigned call back.
    await dispatcher.handleCrewStatus({ agentId, status: 'AT_SCENE', requestId: call.id, ts: Date.now() + 2000 });
    expect((await repo.get(call.id))!.state).toBe('MATCHING');
  });

  it('leaves a unit alone while it is legitimately working an ARRIVED call', async () => {
    await seedUnit('A-0001');
    const { sweeper, dispatcher } = setup();
    const { call, agentId } = await callEnRoute(dispatcher);
    await dispatcher.handleCrewStatus({ agentId, status: 'AT_SCENE', requestId: call.id, ts: Date.now() + 1 });
    await redis.del(REDIS_KEYS.heartbeat(agentId)); // no signal inside the building
    expect((await sweeper.sweep()).reassignedCalls).toBe(0);
    expect((await repo.get(call.id))!.state).toBe('ARRIVED');
  });

  it('frees a unit orphaned in DISPATCHED by a crash between claim and offer, but not real ones', async () => {
    for (const id of ['A-0001', 'A-0002', 'A-0003']) await seedUnit(id);
    const { sweeper, fleet, dispatcher } = setup();

    // A-0003 acknowledges a real call: lock released, status stays DISPATCHED until it reports EN_ROUTE.
    await redis.hset(REDIS_KEYS.status, 'A-0001', 'OFFLINE', 'A-0002', 'OFFLINE'); // so the match picks A-0003
    const call = await newCall();
    const offer = await dispatcher.handleMatch(call.id);
    if (offer.kind !== 'offered' || offer.agentId !== 'A-0003') throw new Error(`expected A-0003, got ${JSON.stringify(offer)}`);
    await dispatcher.handleOfferResponse({ offerId: offer.offerId, agentId: 'A-0003', response: 'ACK' });
    await redis.hset(REDIS_KEYS.status, 'A-0001', 'AVAILABLE', 'A-0002', 'AVAILABLE');

    // A-0001: claimed with a short lock, then the worker "crashed" before creating the offer.
    expect(await fleet.claim('A-0001', 'crashed-request', 50)).toBe(true);
    await new Promise((r) => setTimeout(r, 120)); // lock expired; status is still DISPATCHED
    // A-0002: claimed with a live lock: an offer is being created right now. Must not be touched.
    expect(await fleet.claim('A-0002', 'in-flight-request', 60_000)).toBe(true);

    expect((await sweeper.sweep()).freedUnits).toBe(1);
    expect(await redis.hget(REDIS_KEYS.status, 'A-0001')).toBe('AVAILABLE');
    expect(await redis.hget(REDIS_KEYS.status, 'A-0002')).toBe('DISPATCHED');
    expect(await redis.hget(REDIS_KEYS.status, 'A-0003')).toBe('DISPATCHED');
  });

  it('lets only one dispatcher instance lead the sweep, and hands over when the leader dies', async () => {
    const a = new FleetOps(redis);
    const b = new FleetOps(redis);
    expect(await a.tryLead('instance-a', 200)).toBe(true);
    expect(await b.tryLead('instance-b', 200)).toBe(false);
    expect(await a.tryLead('instance-a', 200)).toBe(true); // the leader renews
    await new Promise((r) => setTimeout(r, 300)); // leader stops renewing (crashed)
    expect(await b.tryLead('instance-b', 200)).toBe(true);
  });
});
