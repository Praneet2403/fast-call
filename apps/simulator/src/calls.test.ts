import { beforeAll, describe, expect, it } from 'vitest';
import { haversineMeters, isWithin, JAIPUR_BOUNDS } from '@fast-call/shared';
import { RoadGraph } from '@fast-call/roads';
import { CallGenerator, DIURNAL, istHour } from './calls.js';
import type { CallSpec } from './calls.js';
import { createRng } from './rng.js';

let graph: RoadGraph;
beforeAll(() => {
  graph = RoadGraph.load();
});

/** Generate a full simulated day in 1-minute steps, starting at IST midnight. */
function simulateDay(seed: number, callsPerMin: number): { calls: CallSpec[]; perHour: number[] } {
  const gen = new CallGenerator(createRng(seed), graph, callsPerMin);
  const istMidnight = Date.UTC(2026, 10, 2) - 5.5 * 3600 * 1000;
  const calls: CallSpec[] = [];
  const perHour = Array<number>(24).fill(0);
  for (let m = 1; m <= 24 * 60; m++) {
    const now = istMidnight + m * 60_000 - 1;
    const batch = gen.due(now, 60_000);
    perHour[istHour(now)]! += batch.length;
    calls.push(...batch);
  }
  return { calls, perHour };
}

describe('time-of-day curve', () => {
  it('averages exactly 1 so CALLS_PER_MIN is the true daily average', () => {
    expect(DIURNAL.reduce((a, b) => a + b, 0) / 24).toBeCloseTo(1, 10);
  });

  it('maps timestamps to Jaipur local time (IST, UTC+5:30)', () => {
    expect(istHour(Date.UTC(2026, 10, 2, 18, 30))).toBe(0); // 18:30 UTC = 00:00 IST
    expect(istHour(Date.UTC(2026, 10, 2, 13, 30))).toBe(19);
  });
});

describe('CallGenerator', () => {
  const day = () => simulateDay(42, 6);

  it('produces the configured daily volume (6/min ≈ 8,640/day)', () => {
    const { calls } = day();
    expect(calls.length).toBeGreaterThan(8640 * 0.95);
    expect(calls.length).toBeLessThan(8640 * 1.05);
  });

  it('is busier in the evening peak than in the small hours', () => {
    const { perHour } = day();
    expect(perHour[19]!).toBeGreaterThan(3 * perHour[3]!);
  });

  it('mixes priorities roughly 15% P1 / 35% P2 / 50% P3, with P1 mostly ALS', () => {
    const { calls } = day();
    const share = (p: string) => calls.filter((c) => c.priority === p).length / calls.length;
    expect(share('P1')).toBeGreaterThan(0.12);
    expect(share('P1')).toBeLessThan(0.18);
    expect(share('P3')).toBeGreaterThan(0.46);
    const p1 = calls.filter((c) => c.priority === 'P1');
    expect(p1.filter((c) => c.requiredCapability === 'ALS').length / p1.length).toBeGreaterThan(0.8);
  });

  it('puts every call on a road inside Jaipur, ~70% of them around hotspots', () => {
    const { calls } = day();
    for (const c of calls.slice(0, 500)) {
      expect(isWithin(JAIPUR_BOUNDS, c.location)).toBe(true);
      expect(haversineMeters(c.location, graph.point(graph.nearestNode(c.location)))).toBeLessThan(0.01);
    }
    const hotspotShare = calls.filter((c) => c.hotspot).length / calls.length;
    expect(hotspotShare).toBeGreaterThan(0.65);
    expect(hotspotShare).toBeLessThan(0.75);
  });

  it('replays identically for the same seed', () => {
    const a = simulateDay(7, 2).calls.slice(0, 50);
    const b = simulateDay(7, 2).calls.slice(0, 50);
    expect(a).toEqual(b);
  });
});
