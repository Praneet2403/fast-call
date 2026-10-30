import { haversineMeters, isWithin, JAIPUR_BOUNDS, moveTowards } from '@fast-call/shared';
import type { AgentStatus, Capability, GeoPoint } from '@fast-call/shared';
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

/**
 * One simulated ambulance that drives along real Jaipur roads:
 * pick a destination node, route to it with A*, follow the route node by node, repeat.
 */
export class SimAgent {
  status: AgentStatus = 'AVAILABLE';
  position: GeoPoint;
  speedMps = 0;
  nextPingAt = 0;
  /** Road nodes of the current trip; `leg` is the index of the node we're driving towards. */
  route: number[] = [];
  leg = 0;

  constructor(
    readonly id: string,
    readonly capability: Capability,
    startNode: number,
    private readonly rng: Rng,
    private readonly graph: RoadGraph,
  ) {
    this.position = graph.point(startNode);
    this.planTrip(startNode);
  }

  /** The road node the agent last passed (or started from). */
  get lastNode(): number {
    return this.route[this.leg - 1]!;
  }

  /** Advance the agent by `dtMs` of simulated time. Returns metres travelled. */
  step(dtMs: number): number {
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
      if (this.leg >= this.route.length) this.planTrip(this.route.at(-1)!);
    }
    return travelled;
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
