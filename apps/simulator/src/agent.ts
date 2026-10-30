import { haversineMeters, moveTowards } from '@fast-call/shared';
import type { AgentStatus, Bounds, Capability, GeoPoint } from '@fast-call/shared';
import type { Rng } from './rng.js';

/** Urban ambulance cruising speed range: ~29–50 km/h. */
export const MIN_SPEED_MPS = 8;
export const MAX_SPEED_MPS = 14;

export function randomPoint(rng: Rng, bounds: Bounds): GeoPoint {
  return {
    lat: rng.range(bounds.minLat, bounds.maxLat),
    lng: rng.range(bounds.minLng, bounds.maxLng),
  };
}

/**
 * One simulated ambulance using the "random waypoint" model:
 * pick a destination, drive towards it at a constant speed, pick a new one on arrival.
 */
export class SimAgent {
  status: AgentStatus = 'AVAILABLE';
  target: GeoPoint;
  speedMps: number;
  nextPingAt = 0;

  constructor(
    readonly id: string,
    readonly capability: Capability,
    public position: GeoPoint,
    private readonly rng: Rng,
    private readonly bounds: Bounds,
  ) {
    this.target = randomPoint(rng, bounds);
    this.speedMps = rng.range(MIN_SPEED_MPS, MAX_SPEED_MPS);
  }

  /** Advance the agent by `dtMs` of simulated time. Returns metres travelled. */
  step(dtMs: number): number {
    let budget = (this.speedMps * dtMs) / 1000;
    let travelled = 0;

    // Loop so an agent that reaches its waypoint mid-tick keeps driving towards the next one.
    while (budget > 0) {
      const remaining = haversineMeters(this.position, this.target);
      if (remaining > budget) {
        this.position = moveTowards(this.position, this.target, budget);
        travelled += budget;
        break;
      }
      this.position = { ...this.target };
      travelled += remaining;
      budget -= remaining;
      this.target = randomPoint(this.rng, this.bounds);
      this.speedMps = this.rng.range(MIN_SPEED_MPS, MAX_SPEED_MPS);
    }
    return travelled;
  }
}
