import type { Bounds, GeoPoint } from './types.js';

export const EARTH_RADIUS_M = 6_371_000;

/**
 * Service area: walled city, Malviya Nagar, Mansarovar, Vaishali Nagar, Jagatpura, down to Sitapura.
 * minLat is 26.76 so the southern hospitals (Mahatma Gandhi, Bombay Hospital) are inside the box.
 */
export const JAIPUR_BOUNDS: Bounds = {
  minLat: 26.76,
  maxLat: 27.0,
  minLng: 75.7,
  maxLng: 75.9,
};

export const JAIPUR_CENTER: GeoPoint = { lat: 26.9124, lng: 75.7873 };

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Move `meters` from `from` towards `to`, stopping at `to`.
 * Linear interpolation in lat/lng: accurate enough over a city-sized area.
 */
export function moveTowards(from: GeoPoint, to: GeoPoint, meters: number): GeoPoint {
  const remaining = haversineMeters(from, to);
  if (remaining <= meters || remaining === 0) return { ...to };
  const f = meters / remaining;
  return {
    lat: from.lat + (to.lat - from.lat) * f,
    lng: from.lng + (to.lng - from.lng) * f,
  };
}

export function isWithin(bounds: Bounds, p: GeoPoint): boolean {
  return p.lat >= bounds.minLat && p.lat <= bounds.maxLat && p.lng >= bounds.minLng && p.lng <= bounds.maxLng;
}
