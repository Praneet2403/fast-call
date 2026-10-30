/**
 * Downloads Jaipur's drivable roads from OpenStreetMap (Overpass API) and writes a compact graph.
 *
 *   pnpm --filter @fast-call/roads build-graph                 # fetch from Overpass
 *   pnpm --filter @fast-call/roads build-graph -- --input raw.json  # reuse a saved response
 *
 * The output is committed, so every seeded simulation runs on exactly the same map.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { isWithin, JAIPUR_BOUNDS } from '@fast-call/shared';
import type { RoadGraphFile } from '../src/format.js';

const HIGHWAY_TYPES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
];
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OUT = fileURLToPath(new URL('../data/jaipur-roads.json.gz', import.meta.url));

interface OsmNode { type: 'node'; id: number; lat: number; lon: number }
interface OsmWay { type: 'way'; id: number; nodes: number[] }
type OsmElement = OsmNode | OsmWay;

async function loadOsm(): Promise<OsmElement[]> {
  const inputFlag = process.argv.indexOf('--input');
  if (inputFlag !== -1) {
    const path = process.argv[inputFlag + 1]!;
    console.log(`reading ${path}`);
    return JSON.parse(readFileSync(path, 'utf8')).elements;
  }
  const b = JAIPUR_BOUNDS;
  const query =
    `[out:json][timeout:180];` +
    `way["highway"~"^(${HIGHWAY_TYPES.join('|')})$"]["access"!~"^(private|no)$"]["area"!="yes"]` +
    `(${b.minLat},${b.minLng},${b.maxLat},${b.maxLng});(._;>;);out skel qt;`;
  console.log('querying Overpass…');
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'User-Agent': 'fast-call-dispatch/0.1 (student project)' },
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { elements: OsmElement[] }).elements;
}

const elements = await loadOsm();
const coords = new Map<number, [number, number]>();
for (const e of elements) if (e.type === 'node') coords.set(e.id, [e.lat, e.lon]);
const ways = elements.filter((e): e is OsmWay => e.type === 'way');

// 1. Edges between consecutive way nodes, keeping only segments fully inside the service area.
const index = new Map<number, number>(); // OSM node id → dense index
const lat: number[] = [];
const lng: number[] = [];
const indexOf = (id: number) => {
  let i = index.get(id);
  if (i === undefined) {
    const [la, lo] = coords.get(id)!;
    i = lat.length;
    index.set(id, i);
    lat.push(la);
    lng.push(lo);
  }
  return i;
};
const inside = (id: number) => {
  const c = coords.get(id);
  return c !== undefined && isWithin(JAIPUR_BOUNDS, { lat: c[0], lng: c[1] });
};

const edgeSet = new Set<string>();
const rawEdges: [number, number][] = [];
for (const way of ways) {
  for (let k = 1; k < way.nodes.length; k++) {
    const a = way.nodes[k - 1]!;
    const b = way.nodes[k]!;
    if (a === b || !inside(a) || !inside(b)) continue;
    const ia = indexOf(a);
    const ib = indexOf(b);
    const key = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    rawEdges.push([ia, ib]);
  }
}

// 2. Keep the largest connected component, so a route exists between any two nodes.
const adjacency: number[][] = Array.from({ length: lat.length }, () => []);
for (const [a, b] of rawEdges) {
  adjacency[a]!.push(b);
  adjacency[b]!.push(a);
}
const component = new Int32Array(lat.length).fill(-1);
const sizes: number[] = [];
for (let start = 0; start < lat.length; start++) {
  if (component[start] !== -1) continue;
  const id = sizes.length;
  let size = 0;
  const stack = [start];
  component[start] = id;
  while (stack.length) {
    const n = stack.pop()!;
    size++;
    for (const m of adjacency[n]!) {
      if (component[m] === -1) {
        component[m] = id;
        stack.push(m);
      }
    }
  }
  sizes.push(size);
}
const main = sizes.indexOf(Math.max(...sizes));

// 3. Renumber the kept nodes densely and write the file.
const remap = new Int32Array(lat.length).fill(-1);
const out: RoadGraphFile = {
  version: 1,
  source: 'OpenStreetMap via Overpass API',
  license: '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
  fetchedAt: new Date().toISOString(),
  bbox: { ...JAIPUR_BOUNDS },
  highwayTypes: HIGHWAY_TYPES,
  latE6: [],
  lngE6: [],
  edges: [],
};
for (let i = 0; i < lat.length; i++) {
  if (component[i] !== main) continue;
  remap[i] = out.latE6.length;
  out.latE6.push(Math.round(lat[i]! * 1e6));
  out.lngE6.push(Math.round(lng[i]! * 1e6));
}
for (const [a, b] of rawEdges) {
  if (component[a] === main) out.edges.push(remap[a]!, remap[b]!);
}

const gz = gzipSync(JSON.stringify(out), { level: 9 });
writeFileSync(OUT, gz);
console.log(
  `ways=${ways.length} nodes=${lat.length} edges=${rawEdges.length} components=${sizes.length}\n` +
    `kept largest component: ${out.latE6.length} nodes (${((100 * out.latE6.length) / lat.length).toFixed(1)}%), ` +
    `${out.edges.length / 2} edges → ${OUT} (${(gz.length / 1024 / 1024).toFixed(2)} MB)`,
);
