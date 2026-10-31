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

export class Fleet {
  readonly agents: SimAgent[];
  private readonly byId: Map<string, SimAgent>;

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
    if (!agent) return;
    if (cmd.type === 'offer') agent.receiveOffer(cmd, now);
    else if (cmd.type === 'assigned') agent.receiveAssigned(cmd, now);
    else agent.receiveWithdrawn(cmd, now);
  }

  /** Move every agent one tick, send crew reports, then pings for agents that are due. */
  tick(now: number, sink: PingSink): TickStats {
    const { tickMs, pingIntervalMs, pingJitterMs } = this.config;
    let pingsSent = 0;
    let maxStepMeters = 0;

    for (const agent of this.agents) {
      maxStepMeters = Math.max(maxStepMeters, agent.step(tickMs, now));
      if (agent.outbox.length) {
        for (const msg of agent.outbox) sink.sendControl?.(msg);
        agent.outbox = [];
      }

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
    sink.flush?.();
    return { pingsSent, maxStepMeters };
  }
}
