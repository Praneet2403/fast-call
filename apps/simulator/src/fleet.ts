import type { Bounds, LocationPing } from '@fast-call/shared';
import { randomPoint, SimAgent } from './agent.js';
import type { SimConfig } from './config.js';
import type { Rng } from './rng.js';

export interface PingSink {
  send(ping: LocationPing): void;
}

export interface TickStats {
  pingsSent: number;
  maxStepMeters: number;
}

export class Fleet {
  readonly agents: SimAgent[];

  constructor(
    private readonly config: SimConfig,
    private readonly rng: Rng,
    bounds: Bounds,
  ) {
    this.agents = Array.from({ length: config.agentCount }, (_, i) => {
      const id = `A-${String(i + 1).padStart(4, '0')}`;
      const capability = rng.chance(config.alsShare) ? 'ALS' : 'BLS';
      return new SimAgent(id, capability, randomPoint(rng, bounds), rng, bounds);
    });
  }

  /** Spread first pings across one interval so the fleet doesn't burst at startup. */
  schedulePings(now: number): void {
    for (const agent of this.agents) {
      agent.nextPingAt = now + this.rng.int(0, this.config.pingIntervalMs);
    }
  }

  /** Move every agent one tick, then send pings for agents that are due. */
  tick(now: number, sink: PingSink): TickStats {
    const { tickMs, pingIntervalMs, pingJitterMs } = this.config;
    let pingsSent = 0;
    let maxStepMeters = 0;

    for (const agent of this.agents) {
      maxStepMeters = Math.max(maxStepMeters, agent.step(tickMs));

      if (now >= agent.nextPingAt) {
        sink.send({
          type: 'ping',
          agentId: agent.id,
          lat: agent.position.lat,
          lng: agent.position.lng,
          ts: now,
        });
        pingsSent++;
        // Schedule from the due time, not from `now`: pings only fire on tick boundaries,
        // so scheduling from `now` would round every interval up and the rate would drift low.
        // If we fell more than an interval behind (event-loop stall), resync instead of bursting.
        const base = now - agent.nextPingAt > pingIntervalMs ? now : agent.nextPingAt;
        agent.nextPingAt = base + pingIntervalMs + this.rng.int(-pingJitterMs, pingJitterMs);
      }
    }
    return { pingsSent, maxStepMeters };
  }
}
