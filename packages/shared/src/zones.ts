import { cellToBoundary, latLngToCell, polygonToCells } from 'h3-js';
import { JAIPUR_BOUNDS } from './geo.js';
import type { GeoPoint } from './types.js';

/**
 * Coverage zones are H3 hexagons at resolution 7 (~5.2 km², ~1.2 km edge): roughly the area one
 * ambulance can cover within a few minutes. Hexagons tile without gaps and every neighbour is the
 * same distance away, which square grid cells don't give you.
 */
export const ZONE_RESOLUTION = 7;

export function zoneOf(p: GeoPoint): string {
  return latLngToCell(p.lat, p.lng, ZONE_RESOLUTION);
}

/** Zone outline as a closed GeoJSON ring ([lng, lat]). */
export function zoneBoundary(cell: string): [number, number][] {
  const ring = cellToBoundary(cell, true) as [number, number][];
  return [...ring, ring[0]!];
}

let serviceZones: string[] | undefined;

/** Every zone whose centre lies inside the Jaipur service area (computed once). */
export function allServiceZones(): string[] {
  if (!serviceZones) {
    const b = JAIPUR_BOUNDS;
    serviceZones = polygonToCells(
      [
        [b.minLat, b.minLng],
        [b.minLat, b.maxLng],
        [b.maxLat, b.maxLng],
        [b.maxLat, b.minLng],
      ],
      ZONE_RESOLUTION,
    );
  }
  return serviceZones;
}
