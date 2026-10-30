import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { haversineMeters } from '@fast-call/shared';
import type { GeoPoint } from '@fast-call/shared';
import type { RoadGraphFile } from './format.js';

const DEFAULT_PATH = fileURLToPath(new URL('../data/jaipur-roads.json.gz', import.meta.url));

/** Grid cell size for the nearest-node index: ~0.002° ≈ 220 m. */
const CELL_DEG = 0.002;

/**
 * Undirected road graph in CSR form (compressed sparse rows): for node i, its neighbours are
 * neighbors[offsets[i] .. offsets[i+1]) with matching lengths in metres. Typed arrays keep
 * 216k nodes / 248k roads in a few MB and make routing loops fast.
 */
export class RoadGraph {
  readonly nodeCount: number;
  readonly lat: Float64Array;
  readonly lng: Float64Array;
  readonly offsets: Int32Array;
  readonly neighbors: Int32Array;
  readonly lengths: Float32Array;
  private readonly grid = new Map<string, number[]>();

  constructor(file: RoadGraphFile) {
    const n = file.latE6.length;
    this.nodeCount = n;
    this.lat = Float64Array.from(file.latE6, (v) => v / 1e6);
    this.lng = Float64Array.from(file.lngE6, (v) => v / 1e6);

    const degree = new Int32Array(n);
    for (let k = 0; k < file.edges.length; k += 2) {
      degree[file.edges[k]!]!++;
      degree[file.edges[k + 1]!]!++;
    }
    this.offsets = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.offsets[i + 1] = this.offsets[i]! + degree[i]!;

    this.neighbors = new Int32Array(this.offsets[n]!);
    this.lengths = new Float32Array(this.offsets[n]!);
    const fill = this.offsets.slice(0, n);
    for (let k = 0; k < file.edges.length; k += 2) {
      const a = file.edges[k]!;
      const b = file.edges[k + 1]!;
      const len = haversineMeters(this.point(a), this.point(b));
      this.neighbors[fill[a]!] = b;
      this.lengths[fill[a]!++] = len;
      this.neighbors[fill[b]!] = a;
      this.lengths[fill[b]!++] = len;
    }

    for (let i = 0; i < n; i++) {
      const key = this.cellKey(this.lat[i]!, this.lng[i]!);
      const bucket = this.grid.get(key);
      if (bucket) bucket.push(i);
      else this.grid.set(key, [i]);
    }
  }

  static load(path = DEFAULT_PATH): RoadGraph {
    return new RoadGraph(JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as RoadGraphFile);
  }

  point(i: number): GeoPoint {
    return { lat: this.lat[i]!, lng: this.lng[i]! };
  }

  /** Closest road node to `p`. Searches grid rings outward until a hit can't be beaten. */
  nearestNode(p: GeoPoint): number {
    const ci = Math.floor(p.lat / CELL_DEG);
    const cj = Math.floor(p.lng / CELL_DEG);
    let best = -1;
    let bestDist = Infinity;
    for (let ring = 0; ring < 200; ring++) {
      for (let di = -ring; di <= ring; di++) {
        for (let dj = -ring; dj <= ring; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue; // only the ring's border
          for (const i of this.grid.get(`${ci + di}:${cj + dj}`) ?? []) {
            const d = haversineMeters(p, this.point(i));
            if (d < bestDist) {
              bestDist = d;
              best = i;
            }
          }
        }
      }
      // Anything in the next ring is at least `ring` cells away; stop once that can't beat the best.
      if (best !== -1 && bestDist < ring * CELL_DEG * 96_000) break;
    }
    if (best === -1) throw new Error('nearestNode: graph is empty');
    return best;
  }

  private cellKey(lat: number, lng: number): string {
    return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;
  }
}
