import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allServiceZones, zoneOf } from '@fast-call/shared';
import { parseAgentMessage } from './messages.js';
import { buildSnapshot, percentile } from './snapshot.js';
import { FleetStore, KEYS } from './store.js';

const ping = (agentId: string, ts: number, lat = 26.9, lng = 75.8) => ({ type: 'ping', agentId, lat, lng, ts });

describe('parseAgentMessage', () => {
  it('accepts a valid ping batch', () => {
    const r = parseAgentMessage(JSON.stringify({ type: 'pings', pings: [ping('A-0001', 1)] }));
    expect(r.ok && r.message.type === 'pings' && r.message.pings.length).toBe(1);
  });

  it('drops only the bad pings in a batch', () => {
    const bad = { ...ping('A-0002', 2), lat: 999 };
    const r = parseAgentMessage(JSON.stringify({ type: 'pings', pings: [ping('A-0001', 1), bad, { nope: 1 }] }));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === 'pings') {
      expect(r.message.pings).toHaveLength(1);
      expect(r.rejectedPings).toBe(2);
    }
  });

  it('rejects garbage', () => {
    expect(parseAgentMessage('not json').ok).toBe(false);
    expect(parseAgentMessage(JSON.stringify({ type: 'hack' })).ok).toBe(false);
    expect(parseAgentMessage(JSON.stringify({ type: 'register', agents: [{ agentId: 'x', capability: 'ALS' }] })).ok).toBe(
      false,
    );
  });
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('buildSnapshot', () => {
  it('marks units past the heartbeat TTL as STALE and excludes them from freshness', () => {
    const now = 100_000;
    const snap = buildSnapshot(
      {
        positions: [
          ['A-0001', 75.8, 26.9],
          ['A-0002', 75.81, 26.91],
          ['A-0003', 75.82, 26.92],
        ],
        lastSeen: { 'A-0001': String(now - 2_000), 'A-0002': String(now - 4_000), 'A-0003': String(now - 60_000) },
        status: { 'A-0001': 'AVAILABLE', 'A-0002': 'EN_ROUTE', 'A-0003': 'AVAILABLE' },
        capability: { 'A-0001': 'ALS', 'A-0002': 'BLS', 'A-0003': 'BLS' },
      },
      now,
      15,
    );
    expect(snap.stats).toMatchObject({ total: 3, available: 1, stale: 1, als: 1, bls: 2 });
    expect(snap.stats.freshnessP50Ms).toBe(2_000);
    expect(snap.agents.find((a) => a[0] === 'A-0003')?.[3]).toBe('STALE');
  });

  it('flags on-scene calls whose unit has gone silent for a human to check', () => {
    const now = 100_000;
    const snap = buildSnapshot(
      {
        positions: [
          ['A-0001', 75.8, 26.9],
          ['A-0002', 75.81, 26.91],
        ],
        lastSeen: { 'A-0001': String(now - 60_000), 'A-0002': String(now - 1_000) }, // A-0001 silent for a minute
        status: { 'A-0001': 'AT_SCENE', 'A-0002': 'AT_SCENE' },
        capability: {},
      },
      now,
      15,
      [
        ['call-1', 75.8, 26.9, 'ARRIVED', 'P1', 'A-0001', now - 300_000],
        ['call-2', 75.81, 26.91, 'ARRIVED', 'P2', 'A-0002', now - 300_000],
        ['call-3', 75.8, 26.9, 'EN_ROUTE', 'P2', 'A-0001', now - 300_000], // sweeper's job, not a human's
      ],
    );
    expect(snap.callStats.needsAttention).toEqual(['call-1']);
  });

  it('counts free units per H3 zone and reports zones with no free unit as uncovered', () => {
    const now = 100_000;
    const fresh = String(now - 1_000);
    const snap = buildSnapshot(
      {
        // Two units ~100 m apart (same zone), one ~8 km away.
        positions: [
          ['A-0001', 75.8, 26.9],
          ['A-0002', 75.801, 26.9],
          ['A-0003', 75.86, 26.8],
        ],
        lastSeen: { 'A-0001': fresh, 'A-0002': fresh, 'A-0003': fresh },
        status: { 'A-0001': 'AVAILABLE', 'A-0002': 'EN_ROUTE', 'A-0003': 'AVAILABLE' },
        capability: {},
      },
      now,
      15,
    );
    const zone = (cell: string) => snap.zones.find((z) => z[0] === cell)!;
    const shared = zoneOf({ lat: 26.9, lng: 75.8 });
    expect(zone(shared).slice(1)).toEqual([1, 2]); // 1 free of 2 units
    expect(zone(zoneOf({ lat: 26.8, lng: 75.86 })).slice(1)).toEqual([1, 1]);
    expect(snap.stats.totalZones).toBe(allServiceZones().length);
    expect(snap.stats.uncoveredZones).toBe(allServiceZones().length - 2);
  });
});

// Integration: runs against the docker-compose Redis, on DB 15 so dev data in DB 0 is untouched.
describe('FleetStore (Redis)', async () => {
  const store = new FleetStore('redis://localhost:6379/15', 15);
  const reachable = await store
    .connect()
    .then(() => true)
    .catch(() => false);

  beforeAll(async () => {
    if (reachable) await store.redis.flushdb();
  });
  afterAll(async () => {
    if (reachable) {
      await store.redis.flushdb();
      await store.close();
    } else store.redis.disconnect();
  });

  it.skipIf(!reachable)('stores position, lastSeen and a heartbeat with TTL', async () => {
    await store.register([{ agentId: 'A-0001', capability: 'ALS' }]);
    expect(await store.applyPings([ping('A-0001', 1_000, 26.9124, 75.7873) as never])).toBe(1);

    const [lng, lat] = (await store.redis.geopos(KEYS.geo, 'A-0001'))[0]!.map(Number);
    expect(lat).toBeCloseTo(26.9124, 4);
    expect(lng).toBeCloseTo(75.7873, 4);
    expect(await store.redis.hget(KEYS.status, 'A-0001')).toBe('AVAILABLE');
    const ttl = await store.redis.ttl(KEYS.heartbeat('A-0001'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15);
  });

  it.skipIf(!reachable)('drops out-of-order pings', async () => {
    await store.applyPings([ping('A-0001', 5_000, 26.95, 75.85) as never]);
    const accepted = await store.applyPings([ping('A-0001', 4_000, 26.8, 75.75) as never]);
    expect(accepted).toBe(0);
    const [, lat] = (await store.redis.geopos(KEYS.geo, 'A-0001'))[0]!.map(Number);
    expect(lat).toBeCloseTo(26.95, 4); // the older ping did not move the unit back
  });

  it.skipIf(!reachable)('reads the whole fleet', async () => {
    const fleet = await store.readFleet();
    expect(fleet.positions.map((p) => p[0])).toContain('A-0001');
    expect(fleet.capability['A-0001']).toBe('ALS');
    expect(fleet.lastSeen['A-0001']).toBe('5000');
  });
});
