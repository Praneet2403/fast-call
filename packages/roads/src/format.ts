/**
 * On-disk road graph (data/jaipur-roads.json.gz).
 * Coordinates are integer micro-degrees (~11 cm) so the file compresses well and stays exact.
 * Edges are undirected node-index pairs. Edge lengths are computed at load time.
 */
export interface RoadGraphFile {
  version: 1;
  source: string;
  license: string;
  fetchedAt: string;
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  highwayTypes: string[];
  latE6: number[];
  lngE6: number[];
  /** Flat pairs: [a0, b0, a1, b1, …] */
  edges: number[];
}
