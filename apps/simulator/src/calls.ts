import { isWithin, JAIPUR_BOUNDS } from '@fast-call/shared';
import type { Capability, GeoPoint, Priority } from '@fast-call/shared';
import type { RoadGraph } from '@fast-call/roads';
import type { Rng } from './rng.js';

/**
 * Synthetic demand. Positions are approximate neighbourhood centres, chosen so demand has
 * learnable structure for the Day 6 forecast. They are not real call statistics.
 */
export const HOTSPOTS: readonly { name: string; center: GeoPoint; sigmaM: number; weight: number }[] = [
  { name: 'Walled City (Badi Chaupar)', center: { lat: 26.9239, lng: 75.8267 }, sigmaM: 900, weight: 3 },
  { name: 'Jaipur Junction', center: { lat: 26.9196, lng: 75.788 }, sigmaM: 700, weight: 2 },
  { name: 'Sindhi Camp', center: { lat: 26.9235, lng: 75.8 }, sigmaM: 600, weight: 1.5 },
  { name: 'Malviya Nagar', center: { lat: 26.8549, lng: 75.8243 }, sigmaM: 1200, weight: 2 },
  { name: 'Mansarovar', center: { lat: 26.8505, lng: 75.7628 }, sigmaM: 1500, weight: 2 },
  { name: 'Vaishali Nagar', center: { lat: 26.911, lng: 75.743 }, sigmaM: 1200, weight: 1.5 },
  { name: 'Raja Park', center: { lat: 26.8977, lng: 75.83 }, sigmaM: 800, weight: 1 },
  { name: 'Sitapura Industrial Area', center: { lat: 26.78, lng: 75.85 }, sigmaM: 1500, weight: 1 },
];

/** Share of calls drawn around a hotspot; the rest are spread over the whole road network. */
const HOTSPOT_SHARE = 0.7;

/**
 * Calls per hour relative to the daily average (24 values, mean = 1).
 * Quiet nights, a morning commute peak, the highest load in the evening.
 */
export const DIURNAL = (() => {
  const raw = [0.45, 0.35, 0.3, 0.3, 0.35, 0.5, 0.75, 1.05, 1.3, 1.35, 1.25, 1.15,
               1.1, 1.05, 1.0, 1.05, 1.15, 1.35, 1.55, 1.6, 1.45, 1.2, 0.9, 0.65];
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  return raw.map((v) => v / mean);
})();

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** Hour of day in Jaipur (IST, UTC+5:30). */
export function istHour(ts: number): number {
  return new Date(ts + IST_OFFSET_MS).getUTCHours();
}

export interface CallSpec {
  location: GeoPoint;
  priority: Priority;
  requiredCapability: Capability;
  hotspot: string | null;
}

/** Knuth's Poisson sampler; fine for the small per-tick means used here. */
function poisson(rng: Rng, mean: number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = rng.next();
  while (p > limit) {
    k++;
    p *= rng.next();
  }
  return k;
}

/** Standard normal via Box–Muller. */
function gaussian(rng: Rng): number {
  const u = 1 - rng.next(); // (0, 1]
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

function pickPriority(rng: Rng): Priority {
  const r = rng.next();
  return r < 0.15 ? 'P1' : r < 0.5 ? 'P2' : 'P3';
}

/** P1 almost always needs ALS; a few P3s are ALS inter-facility transfers. */
function pickCapability(rng: Rng, priority: Priority): Capability {
  const alsChance = priority === 'P1' ? 0.85 : priority === 'P2' ? 0.3 : 0.05;
  return rng.chance(alsChance) ? 'ALS' : 'BLS';
}

const METERS_PER_DEG_LAT = 111_320;
const totalWeight = HOTSPOTS.reduce((a, h) => a + h.weight, 0);

/**
 * Emergency calls as a Poisson process whose rate follows the time of day.
 * Pure and seeded: the same seed and clock produce the same calls, so A/B runs are comparable,
 * and the same generator can back-fill weeks of history in seconds for forecasting.
 */
export class CallGenerator {
  constructor(
    private readonly rng: Rng,
    private readonly graph: RoadGraph,
    /** Average calls per minute across a whole day. */
    private readonly callsPerMin: number,
  ) {}

  /** Calls arriving during the `dtMs` window ending at `now`. */
  due(now: number, dtMs: number): CallSpec[] {
    const mean = (this.callsPerMin * DIURNAL[istHour(now)]! * dtMs) / 60_000;
    return Array.from({ length: poisson(this.rng, mean) }, () => this.call());
  }

  private call(): CallSpec {
    const priority = pickPriority(this.rng);
    const requiredCapability = pickCapability(this.rng, priority);
    const { location, hotspot } = this.location();
    return { location, priority, requiredCapability, hotspot };
  }

  private location(): { location: GeoPoint; hotspot: string | null } {
    if (this.rng.chance(HOTSPOT_SHARE)) {
      let pick = this.rng.next() * totalWeight;
      const spot = HOTSPOTS.find((h) => (pick -= h.weight) < 0) ?? HOTSPOTS[0]!;
      for (let attempt = 0; attempt < 10; attempt++) {
        const p = {
          lat: spot.center.lat + (gaussian(this.rng) * spot.sigmaM) / METERS_PER_DEG_LAT,
          lng:
            spot.center.lng +
            (gaussian(this.rng) * spot.sigmaM) / (METERS_PER_DEG_LAT * Math.cos((spot.center.lat * Math.PI) / 180)),
        };
        // Calls come from addresses, so snap to the nearest road.
        if (isWithin(JAIPUR_BOUNDS, p)) return { location: this.graph.point(this.graph.nearestNode(p)), hotspot: spot.name };
      }
    }
    return { location: this.graph.point(this.rng.int(0, this.graph.nodeCount - 1)), hotspot: null };
  }
}
