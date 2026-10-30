import { describe, expect, it } from 'vitest';
import { haversineMeters, isWithin, JAIPUR_BOUNDS } from '@fast-call/shared';
import type { LocationPing } from '@fast-call/shared';
import { MAX_SPEED_MPS, randomPoint, SimAgent } from './agent.js';
import type { SimConfig } from './config.js';
import { Fleet } from './fleet.js';
import { createRng } from './rng.js';

describe('createRng', () => {
  it('replays the same sequence for the same seed', () => {
    const a = createRng(7);
    const b = createRng(7);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('gives different sequences for different seeds', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('keeps int() inside its inclusive range', () => {
    const rng = createRng(3);
    for (let i = 0; i < 10_000; i++) {
      const n = rng.int(-5, 5);
      expect(n).toBeGreaterThanOrEqual(-5);
      expect(n).toBeLessThanOrEqual(5);
    }
  });
});

describe('SimAgent', () => {
  const makeAgent = (seed = 1) => {
    const rng = createRng(seed);
    return new SimAgent('A-0001', 'BLS', randomPoint(rng, JAIPUR_BOUNDS), rng, JAIPUR_BOUNDS);
  };

  it('never moves faster than the max speed (no teleporting)', () => {
    const agent = makeAgent();
    for (let i = 0; i < 5_000; i++) {
      const before = agent.position;
      agent.step(1000);
      expect(haversineMeters(before, agent.position)).toBeLessThanOrEqual(MAX_SPEED_MPS + 1e-6);
    }
  });

  it('stays inside Jaipur forever', () => {
    const agent = makeAgent(2);
    for (let i = 0; i < 20_000; i++) {
      agent.step(1000);
      expect(isWithin(JAIPUR_BOUNDS, agent.position)).toBe(true);
    }
  });

  it('is deterministic for the same seed', () => {
    const a = makeAgent(9);
    const b = makeAgent(9);
    for (let i = 0; i < 1_000; i++) {
      a.step(1000);
      b.step(1000);
    }
    expect(a.position).toEqual(b.position);
  });
});

describe('Fleet', () => {
  const config: SimConfig = {
    agentCount: 200,
    seed: 42,
    tickMs: 1000,
    pingIntervalMs: 4000,
    pingJitterMs: 1000,
    alsShare: 0.3,
    logEverySec: 5,
    durationSec: 0,
  };

  it('pings each agent roughly once per interval', () => {
    const fleet = new Fleet(config, createRng(config.seed), JAIPUR_BOUNDS);
    const pings: LocationPing[] = [];
    fleet.schedulePings(0);
    const seconds = 120;
    for (let t = 0; t < seconds * 1000; t += config.tickMs) fleet.tick(t, { send: (p) => pings.push(p) });

    const expected = (config.agentCount * seconds * 1000) / config.pingIntervalMs;
    expect(pings.length).toBeGreaterThan(expected * 0.9);
    expect(pings.length).toBeLessThan(expected * 1.1);
  });

  it('assigns roughly the configured ALS share', () => {
    const fleet = new Fleet({ ...config, agentCount: 2000 }, createRng(5), JAIPUR_BOUNDS);
    const als = fleet.agents.filter((a) => a.capability === 'ALS').length / 2000;
    expect(als).toBeGreaterThan(0.25);
    expect(als).toBeLessThan(0.35);
  });
});
