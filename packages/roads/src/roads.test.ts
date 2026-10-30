import { beforeAll, describe, expect, it } from 'vitest';
import { haversineMeters, HOSPITALS, isWithin, JAIPUR_BOUNDS } from '@fast-call/shared';
import { RoadGraph } from './graph.js';
import { shortestPath } from './route.js';

let graph: RoadGraph;
beforeAll(() => {
  graph = RoadGraph.load();
});

/** Tiny deterministic generator so the random pairs are the same on every run. */
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

describe('RoadGraph', () => {
  it('loads the Jaipur network with every node inside the service area', () => {
    expect(graph.nodeCount).toBeGreaterThan(100_000);
    for (let i = 0; i < graph.nodeCount; i += 997) expect(isWithin(JAIPUR_BOUNDS, graph.point(i))).toBe(true);
  });

  it('stores each road in both directions with a positive length', () => {
    for (let i = 0; i < 5_000; i++) {
      for (let k = graph.offsets[i]!; k < graph.offsets[i + 1]!; k++) {
        const j = graph.neighbors[k]!;
        expect(graph.lengths[k]).toBeGreaterThan(0);
        let back = false;
        for (let m = graph.offsets[j]!; m < graph.offsets[j + 1]!; m++) back ||= graph.neighbors[m] === i;
        expect(back).toBe(true);
      }
    }
  });

  it('finds the true nearest node (checked against brute force)', () => {
    const rand = lcg(1);
    for (let t = 0; t < 25; t++) {
      const p = {
        lat: JAIPUR_BOUNDS.minLat + rand() * (JAIPUR_BOUNDS.maxLat - JAIPUR_BOUNDS.minLat),
        lng: JAIPUR_BOUNDS.minLng + rand() * (JAIPUR_BOUNDS.maxLng - JAIPUR_BOUNDS.minLng),
      };
      let brute = Infinity;
      for (let i = 0; i < graph.nodeCount; i++) brute = Math.min(brute, haversineMeters(p, graph.point(i)));
      expect(haversineMeters(p, graph.point(graph.nearestNode(p)))).toBeCloseTo(brute, 6);
    }
  });

  it('puts every hospital within 300 m of a road', () => {
    for (const h of HOSPITALS) {
      const d = haversineMeters(h.location, graph.point(graph.nearestNode(h.location)));
      expect(d, h.name).toBeLessThan(300);
    }
  });
});

describe('shortestPath', () => {
  it('returns a connected path whose length matches its edges', () => {
    const rand = lcg(2);
    for (let t = 0; t < 20; t++) {
      const a = Math.floor(rand() * graph.nodeCount);
      const b = Math.floor(rand() * graph.nodeCount);
      const route = shortestPath(graph, a, b)!;
      expect(route.nodes[0]).toBe(a);
      expect(route.nodes.at(-1)).toBe(b);
      let sum = 0;
      for (let i = 1; i < route.nodes.length; i++) {
        const u = route.nodes[i - 1]!;
        const v = route.nodes[i]!;
        let edge = -1;
        for (let k = graph.offsets[u]!; k < graph.offsets[u + 1]!; k++) if (graph.neighbors[k] === v) edge = k;
        expect(edge, `no road between consecutive nodes ${u} → ${v}`).not.toBe(-1);
        sum += graph.lengths[edge]!;
      }
      expect(route.meters).toBeCloseTo(sum, 0);
      // A road route can never be shorter than the straight line.
      expect(route.meters).toBeGreaterThanOrEqual(haversineMeters(graph.point(a), graph.point(b)) - 1e-6);
    }
  });

  it('A* finds the same distance as Dijkstra while expanding fewer nodes', () => {
    const rand = lcg(3);
    for (let t = 0; t < 8; t++) {
      const a = Math.floor(rand() * graph.nodeCount);
      const b = Math.floor(rand() * graph.nodeCount);
      const astar = shortestPath(graph, a, b)!;
      const dijkstra = shortestPath(graph, a, b, { heuristic: false })!;
      expect(astar.meters).toBeCloseTo(dijkstra.meters, 3);
      expect(astar.expanded).toBeLessThanOrEqual(dijkstra.expanded);
    }
  });

  it('routes from one node to itself in zero metres', () => {
    expect(shortestPath(graph, 42, 42)).toMatchObject({ nodes: [42], meters: 0 });
  });
});
