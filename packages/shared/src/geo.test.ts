import { describe, expect, it } from 'vitest';
import { haversineMeters, isWithin, JAIPUR_BOUNDS, JAIPUR_CENTER, moveTowards } from './geo.js';

describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters(JAIPUR_CENTER, JAIPUR_CENTER)).toBe(0);
  });

  it('measures one degree of latitude as ~111.2 km', () => {
    const d = haversineMeters({ lat: 26, lng: 75.8 }, { lat: 27, lng: 75.8 });
    expect(d).toBeCloseTo(111_195, -1);
  });

  it('is symmetric', () => {
    const a = { lat: 26.85, lng: 75.75 };
    const b = { lat: 26.95, lng: 75.85 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe('moveTowards', () => {
  const from = { lat: 26.85, lng: 75.75 };
  const to = { lat: 26.95, lng: 75.85 };

  it('moves exactly the requested distance', () => {
    const p = moveTowards(from, to, 500);
    expect(haversineMeters(from, p)).toBeCloseTo(500, 0);
  });

  it('never overshoots the target', () => {
    expect(moveTowards(from, to, 1e9)).toEqual(to);
  });
});

describe('isWithin', () => {
  it('accepts the city centre and rejects Delhi', () => {
    expect(isWithin(JAIPUR_BOUNDS, JAIPUR_CENTER)).toBe(true);
    expect(isWithin(JAIPUR_BOUNDS, { lat: 28.61, lng: 77.21 })).toBe(false);
  });
});
