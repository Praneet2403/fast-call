import { haversineMeters } from '@fast-call/shared';
import type { RoadGraph } from './graph.js';

export interface Route {
  /** Node indices from start to goal, inclusive. */
  nodes: number[];
  meters: number;
  /** Nodes popped from the queue: a measure of how much work the search did. */
  expanded: number;
}

/** Min-heap of node indices keyed by priority, with lazy deletion. */
class MinHeap {
  private keys: number[] = [];
  private items: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    const { keys, items } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= key) break;
      items[i] = items[parent]!;
      keys[i] = keys[parent]!;
      i = parent;
    }
    items[i] = item;
    keys[i] = key;
  }

  pop(): number {
    const { keys, items } = this;
    const top = items[0]!;
    const lastItem = items.pop()!;
    const lastKey = keys.pop()!;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r]! < keys[l]! ? r : l;
        if (keys[c]! >= lastKey) break;
        items[i] = items[c]!;
        keys[i] = keys[c]!;
        i = c;
      }
      items[i] = lastItem;
      keys[i] = lastKey;
    }
    return top;
  }
}

/**
 * Shortest road path with A*. The heuristic is straight-line (haversine) distance to the goal.
 * A road can never be shorter than a straight line, so the heuristic never overestimates
 * and A* returns the same optimal path as Dijkstra while exploring far fewer nodes.
 * Pass `heuristic: false` to run plain Dijkstra (used in tests to cross-check).
 */
export function shortestPath(graph: RoadGraph, from: number, to: number, opts: { heuristic?: boolean } = {}): Route | null {
  const useHeuristic = opts.heuristic ?? true;
  const goal = graph.point(to);
  const h = (i: number) => (useHeuristic ? haversineMeters(graph.point(i), goal) : 0);

  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const done = new Set<number>();
  const heap = new MinHeap();
  heap.push(from, h(from));
  let expanded = 0;

  while (heap.size > 0) {
    const node = heap.pop();
    if (done.has(node)) continue; // stale heap entry
    done.add(node);
    expanded++;

    if (node === to) {
      const nodes = [to];
      for (let n = to; n !== from; ) {
        n = prev.get(n)!;
        nodes.push(n);
      }
      nodes.reverse();
      return { nodes, meters: dist.get(to)!, expanded };
    }

    const base = dist.get(node)!;
    for (let k = graph.offsets[node]!; k < graph.offsets[node + 1]!; k++) {
      const next = graph.neighbors[k]!;
      if (done.has(next)) continue;
      const d = base + graph.lengths[k]!;
      if (d < (dist.get(next) ?? Infinity)) {
        dist.set(next, d);
        prev.set(next, node);
        heap.push(next, d + h(next));
      }
    }
  }
  return null;
}
