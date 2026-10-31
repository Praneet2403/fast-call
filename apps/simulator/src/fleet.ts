import { HOSPITALS } from '@fast-call/shared';
import type { AgentCommand, CrewStatusMessage, LocationPing, OfferResponseMessage } from '@fast-call/shared';
import type { RoadGraph } from '@fast-call/roads';
import { randomNode, SimAgent } from './agent.js';
import type { CrewContext } from './agent.js';
import type { SimConfig } from './config.js';
import { createRng } from './rng.js';
import type { Rng } from './rng.js';

export interface PingSink {
  send(ping: LocationPing): void;
  /** Called once after each tick, so sinks can batch. */
  flush?(): void;
  /** Crew messages (offer answers, status reports): sent right away, never dropped. */
  sendControl?(msg: OfferResponseMessage | CrewStatusMessage): void;
}

export interface TickStats {
  pingsSent: number;
  maxStepMeters: number;
}

export interface ChaosStats {
  dead: number;
  pingsDropped: number;
  pingsDelayed: number;
}

export class Fleet {
  readonly agents: SimAgent[];
  private readonly byId: Map<string, SimAgent>;
  /** Units whose device is "dead", with the time they come back (Infinity = never). */
  private readonly dead = new Map<string, number>();
  private delayed: { releaseAt: number; ping: LocationPing }[] = [];
  private readonly chaosRng: Rng;
  readonly chaosStats: ChaosStats = { dead: 0, pingsDropped: 0, pingsDelayed: 0 };

  constructor(
    private readonly config: SimConfig,
    private readonly rng: Rng,
    graph: RoadGraph,
  ) {
    const crew: CrewContext = {
      hospitalNodes: HOSPITALS.map((h) => graph.nearestNode(h.location)),
      // Its own stream, so crew decisions never change how the fleet patrols.
      crewRng: createRng(config.seed ^ 0x2545f491),
    };
    this.agents = Array.from({ length: config.agentCount }, (_, i) => {
      const id = `A-${String(i + 1).padStart(4, '0')}`;
      const capability = rng.chance(config.alsShare) ? 'ALS' : 'BLS';
      return new SimAgent(id, capability, randomNode(rng, graph), rng, graph, crew);
    });
    this.byId = new Map(this.agents.map((a) => [a.id, a]));
    // Chaos gets its own random stream, so injecting failures never changes fleet movement.
    this.chaosRng = createRng(config.seed ^ 0x51ed270b);
  }

  /** Chaos: the devices of `pct` of live units die. The vehicles keep moving; we just stop hearing them. */
  kill(pct: number, now: number, reviveAfterMs: number): string[] {
    const live = this.agents.filter((a) => !this.dead.has(a.id));
    const victims: string[] = [];
    for (let n = Math.round(pct * this.agents.length); n > 0 && live.length > 0; n--) {
      const [agent] = live.splice(this.chaosRng.int(0, live.length - 1), 1);
      this.dead.set(agent!.id, reviveAfterMs > 0 ? now + reviveAfterMs : Infinity);
      victims.push(agent!.id);
    }
    this.chaosStats.dead = this.dead.size;
    return victims;
  }

  /** Spread first pings across one interval so the fleet doesn't burst at startup. */
  schedulePings(now: number): void {
    for (const agent of this.agents) {
      agent.nextPingAt = now + this.rng.int(0, this.config.pingIntervalMs);
    }
  }

  /** A command from the dispatcher, routed to the crew it's for. */
  handleCommand(cmd: AgentCommand, now: number): void {
    const agent = this.byId.get(cmd.agentId);
    if (!agent || this.dead.has(agent.id)) return; // a dead device hears nothing
    if (cmd.type === 'offer') agent.receiveOffer(cmd, now);
    else if (cmd.type === 'assigned') agent.receiveAssigned(cmd, now);
    else agent.receiveWithdrawn(cmd, now);
  }

  /** Move every agent one tick, send crew reports, then pings for agents that are due. */
  tick(now: number, sink: PingSink): TickStats {
    const { tickMs, pingIntervalMs, pingJitterMs } = this.config;
    let pingsSent = 0;
    let maxStepMeters = 0;

    const chaos = this.config.chaos;
    for (const [id, reviveAt] of this.dead) if (now >= reviveAt) this.dead.delete(id);
    this.chaosStats.dead = this.dead.size;

    // Delayed pings are released now, carrying their original (older) timestamp.
    const due = this.delayed.filter((d) => d.releaseAt <= now);
    if (due.length) {
      this.delayed = this.delayed.filter((d) => d.releaseAt > now);
      for (const d of due) sink.send(d.ping);
    }

    for (const agent of this.agents) {
      maxStepMeters = Math.max(maxStepMeters, agent.step(tickMs, now));
      const isDead = this.dead.has(agent.id);
      if (agent.outbox.length) {
        if (!isDead) for (const msg of agent.outbox) sink.sendControl?.(msg);
        agent.outbox = []; // a dead device's reports are lost
      }

      if (now >= agent.nextPingAt) {
        const ping: LocationPing = { type: 'ping', agentId: agent.id, lat: agent.position.lat, lng: agent.position.lng, ts: now };
        if (isDead) {
          // silent
        } else if (chaos.dropPct > 0 && this.chaosRng.chance(chaos.dropPct)) {
          this.chaosStats.pingsDropped++;
        } else if (chaos.delayPct > 0 && this.chaosRng.chance(chaos.delayPct)) {
          this.delayed.push({ releaseAt: now + chaos.delayMs, ping });
          this.chaosStats.pingsDelayed++;
        } else {
          sink.send(ping);
          pingsSent++;
        }
        // Schedule from the due time, not from `now`: pings only fire on tick boundaries,
        // so scheduling from `now` would round every interval up and the rate would drift low.
        // If we fell more than an interval behind (event-loop stall), resync instead of bursting.
        const base = now - agent.nextPingAt > pingIntervalMs ? now : agent.nextPingAt;
        agent.nextPingAt = base + pingIntervalMs + this.rng.int(-pingJitterMs, pingJitterMs);
      }
    }
    sink.flush?.();
    return { pingsSent, maxStepMeters };
  }
}
