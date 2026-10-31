import { haversineMeters, isWithin, JAIPUR_BOUNDS, moveTowards } from '@fast-call/shared';
import type {
  AgentStatus,
  AssignedCommand,
  Capability,
  CrewStatus,
  CrewStatusMessage,
  GeoPoint,
  OfferCommand,
  OfferResponseMessage,
  OfferWithdrawnCommand,
} from '@fast-call/shared';
import { shortestPath } from '@fast-call/roads';
import type { RoadGraph } from '@fast-call/roads';
import type { Rng } from './rng.js';

/** Urban ambulance cruising speed range: ~29–50 km/h. */
export const MIN_SPEED_MPS = 8;
export const MAX_SPEED_MPS = 14;

/** Repositioning trips are 0.8–6 km: realistic standby moves, and short routes keep A* cheap. */
export const MIN_TRIP_M = 800;
export const MAX_TRIP_M = 6_000;

export function randomNode(rng: Rng, graph: RoadGraph): number {
  return rng.int(0, graph.nodeCount - 1);
}

const METERS_PER_DEG_LAT = 111_320;

/**
 * Road node at trip distance from `from` (deterministic per seed).
 * Samples a random bearing and distance in the 0.8–6 km ring, then snaps to the nearest road.
 * Sampling nodes uniformly across the city fails near the edges, where most nodes are too far.
 */
export function pickDestination(rng: Rng, graph: RoadGraph, from: number): number {
  const origin = graph.point(from);
  let best = from;
  let bestError = Infinity;
  for (let attempt = 0; attempt < 30; attempt++) {
    const bearing = rng.range(0, 2 * Math.PI);
    const meters = rng.range(MIN_TRIP_M, MAX_TRIP_M);
    const p = {
      lat: origin.lat + (meters * Math.cos(bearing)) / METERS_PER_DEG_LAT,
      lng: origin.lng + (meters * Math.sin(bearing)) / (METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180)),
    };
    if (!isWithin(JAIPUR_BOUNDS, p)) continue;
    const node = graph.nearestNode(p);
    const d = haversineMeters(origin, graph.point(node));
    if (d >= MIN_TRIP_M && d <= MAX_TRIP_M) return node;
    // Keep the closest miss in case every attempt fails (e.g. a node in a far corner).
    const error = d < MIN_TRIP_M ? MIN_TRIP_M - d : d - MAX_TRIP_M;
    if (error < bestError) {
      bestError = error;
      best = node;
    }
  }
  return best === from ? randomNode(rng, graph) : best;
}

/** Emergency driving with sirens: ~43–65 km/h. */
export const MIN_SIREN_MPS = 12;
export const MAX_SIREN_MPS = 18;

/** Demo-scaled timings (real scene and handover times are 10–30 min). */
export const SCENE_MS: [number, number] = [60_000, 180_000];
export const HANDOVER_MS: [number, number] = [60_000, 120_000];
/** How long a crew takes to answer an offer. */
export const REPLY_MS: [number, number] = [2_000, 8_000];
/** Crews that never answer (the offer times out) or answer "unable". */
export const NO_REPLY_CHANCE = 0.03;
export const UNABLE_CHANCE = 0.02;

type Phase = 'PATROL' | 'TO_SCENE' | 'ON_SCENE' | 'TO_HOSPITAL' | 'AT_HOSPITAL';

const PHASE_STATUS: Record<Phase, AgentStatus> = {
  PATROL: 'AVAILABLE',
  TO_SCENE: 'EN_ROUTE',
  ON_SCENE: 'AT_SCENE',
  TO_HOSPITAL: 'TRANSPORTING',
  AT_HOSPITAL: 'AT_HOSPITAL',
};

/** Context a crew needs to work calls: the hospitals' road nodes and a random stream for decisions. */
export interface CrewContext {
  hospitalNodes: number[];
  /** Separate from movement randomness, so crew behaviour doesn't change patrol routes. */
  crewRng: Rng;
}

/**
 * One simulated ambulance on Jaipur's real roads.
 * Patrol: pick a destination, route with A*, follow it node by node, repeat.
 * Calls: answer the offer → drive to the scene → treat → drive to the nearest hospital → hand over → patrol.
 * Every report it sends to the server goes into `outbox`, drained by the fleet after each tick.
 */
export class SimAgent {
  position: GeoPoint;
  speedMps = 0;
  nextPingAt = 0;
  /** Road nodes of the current trip; `leg` is the index of the node we're driving towards. */
  route: number[] = [];
  leg = 0;
  phase: Phase = 'PATROL';
  /** The call this crew is working, once assigned. */
  mission: { requestId: string; offerId: string; dwellUntil: number } | null = null;
  /** An offer we've been sent and haven't settled yet. */
  pendingOffer: { offerId: string; requestId: string; replyAt: number; response: 'ACK' | 'UNABLE' | null } | null = null;
  outbox: (OfferResponseMessage | CrewStatusMessage)[] = [];

  constructor(
    readonly id: string,
    readonly capability: Capability,
    startNode: number,
    private readonly rng: Rng,
    private readonly graph: RoadGraph,
    private readonly crew?: CrewContext,
  ) {
    this.position = graph.point(startNode);
    this.planTrip(startNode);
  }

  get status(): AgentStatus {
    return this.phase === 'PATROL' && this.pendingOffer ? 'DISPATCHED' : PHASE_STATUS[this.phase];
  }

  /** The road node the agent last passed (or started from). */
  get lastNode(): number {
    return this.route[this.leg - 1]!;
  }

  // ---- commands from the dispatcher ----

  receiveOffer(cmd: OfferCommand, now: number): void {
    if (this.phase !== 'PATROL' || this.pendingOffer || !this.crew) return; // busy: let it time out
    const r = this.crew.crewRng.next();
    const response = r < NO_REPLY_CHANCE ? null : r < NO_REPLY_CHANCE + UNABLE_CHANCE ? 'UNABLE' : 'ACK';
    const replyAt = now + this.crew.crewRng.range(REPLY_MS[0], REPLY_MS[1]);
    this.pendingOffer = { offerId: cmd.offerId, requestId: cmd.requestId, replyAt, response };
  }

  receiveAssigned(cmd: AssignedCommand, now: number): void {
    if (this.pendingOffer?.offerId !== cmd.offerId) return;
    this.pendingOffer = null;
    this.mission = { requestId: cmd.requestId, offerId: cmd.offerId, dwellUntil: 0 };
    this.driveTo(this.graph.nearestNode(cmd.location), 'TO_SCENE', now);
  }

  receiveWithdrawn(cmd: OfferWithdrawnCommand, now: number): void {
    if (this.pendingOffer && (this.pendingOffer.offerId === cmd.offerId || this.pendingOffer.requestId === cmd.requestId)) {
      this.pendingOffer = null; // offer void; the dispatcher already made us AVAILABLE again
      return;
    }
    if (this.mission?.requestId === cmd.requestId) {
      // Call cancelled while we were working it: stand down and tell dispatch we're free.
      this.report('AVAILABLE', cmd.requestId, now);
      this.mission = null;
      this.phase = 'PATROL';
      this.planTrip(this.route[this.leg] ?? this.lastNode);
    }
  }

  // ---- simulation ----

  /** Advance the agent by `dtMs` of simulated time ending at `now`. Returns metres travelled. */
  step(dtMs: number, now = 0): number {
    if (this.pendingOffer?.response && now >= this.pendingOffer.replyAt) {
      this.outbox.push({ type: 'offer.response', offerId: this.pendingOffer.offerId, agentId: this.id, response: this.pendingOffer.response });
      if (this.pendingOffer.response === 'UNABLE') this.pendingOffer = null;
      else this.pendingOffer.response = null; // sent; now wait for "assigned" or "withdrawn"
    }

    if (this.phase === 'ON_SCENE' || this.phase === 'AT_HOSPITAL') {
      if (now >= this.mission!.dwellUntil) this.finishDwell(now);
      return 0;
    }

    let budget = (this.speedMps * dtMs) / 1000;
    let travelled = 0;
    // Loop so an agent that passes one or more nodes mid-tick keeps driving along the road.
    while (budget > 0) {
      const target = this.graph.point(this.route[this.leg]!);
      const remaining = haversineMeters(this.position, target);
      if (remaining > budget) {
        this.position = moveTowards(this.position, target, budget);
        travelled += budget;
        break;
      }
      this.position = target;
      travelled += remaining;
      budget -= remaining;
      this.leg++;
      if (this.leg >= this.route.length) {
        this.arrive(now);
        if (this.phase !== 'PATROL') break; // stopped at the scene or hospital
      }
    }
    return travelled;
  }

  private arrive(now: number): void {
    const node = this.route.at(-1)!;
    if (this.phase === 'TO_SCENE') {
      this.phase = 'ON_SCENE';
      this.mission!.dwellUntil = now + this.crew!.crewRng.range(SCENE_MS[0], SCENE_MS[1]);
      this.report('AT_SCENE', this.mission!.requestId, now);
    } else if (this.phase === 'TO_HOSPITAL') {
      this.phase = 'AT_HOSPITAL';
      this.mission!.dwellUntil = now + this.crew!.crewRng.range(HANDOVER_MS[0], HANDOVER_MS[1]);
      this.report('AT_HOSPITAL', this.mission!.requestId, now);
    } else {
      this.planTrip(node);
    }
  }

  private finishDwell(now: number): void {
    const here = this.route.at(-1)!;
    if (this.phase === 'ON_SCENE') {
      const hospital = this.nearestHospital(here);
      this.driveTo(hospital, 'TO_HOSPITAL', now, here);
      return;
    }
    // Handover done: back in service.
    this.report('AVAILABLE', this.mission!.requestId, now);
    this.mission = null;
    this.phase = 'PATROL';
    this.planTrip(here);
  }

  /** Route to `goal` with sirens, continuing from the node we're heading to (or `from` if stopped). */
  private driveTo(goal: number, phase: 'TO_SCENE' | 'TO_HOSPITAL', now: number, from?: number): void {
    const start = from ?? this.route[this.leg] ?? this.lastNode;
    const path = shortestPath(this.graph, start, goal);
    const nodes = path && path.nodes.length > 1 ? path.nodes : [start, start];
    // Keep driving towards the current next node first, so the unit never jumps sideways.
    this.route = from === undefined ? [this.lastNode, ...nodes] : nodes;
    this.leg = 1;
    this.phase = phase;
    this.speedMps = this.crew!.crewRng.range(MIN_SIREN_MPS, MAX_SIREN_MPS);
    this.report(phase === 'TO_SCENE' ? 'EN_ROUTE' : 'TRANSPORTING', this.mission!.requestId, now);
  }

  private nearestHospital(from: number): number {
    const here = this.graph.point(from);
    let best = this.crew!.hospitalNodes[0]!;
    for (const h of this.crew!.hospitalNodes) {
      if (haversineMeters(here, this.graph.point(h)) < haversineMeters(here, this.graph.point(best))) best = h;
    }
    return best;
  }

  private report(status: CrewStatus, requestId: string, now: number): void {
    this.outbox.push({ type: 'status', agentId: this.id, status, requestId, ts: now });
  }

  private planTrip(from: number): void {
    const to = pickDestination(this.rng, this.graph, from);
    const route = shortestPath(this.graph, from, to);
    // The graph is one connected component, so a route always exists; guard anyway.
    this.route = route && route.nodes.length > 1 ? route.nodes : [from, this.graph.neighbors[this.graph.offsets[from]!]!];
    this.leg = 1;
    this.speedMps = this.rng.range(MIN_SPEED_MPS, MAX_SPEED_MPS);
  }
}
