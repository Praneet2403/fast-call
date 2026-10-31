import { allServiceZones, zoneOf } from '@fast-call/shared';
import type { CallRow, Capability, DisplayStatus, FleetRow, FleetSnapshotMessage, RequestState, ZoneRow } from '@fast-call/shared';
import type { RawFleet } from './store.js';

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]!;
}

/** Pure: turns raw Redis state into the message dashboards receive. */
export function buildSnapshot(
  raw: RawFleet,
  now: number,
  heartbeatTtlSec: number,
  calls: CallRow[] = [],
  finishedLastHour: Partial<Record<RequestState, number>> = {},
): FleetSnapshotMessage {
  const staleAfterMs = heartbeatTtlSec * 1000;
  const agents: FleetRow[] = [];
  const freshness: number[] = [];
  let available = 0;
  let stale = 0;
  let als = 0;
  // Start every service zone at zero so coverage gaps show up as zones with 0 free units.
  const zones = new Map<string, { available: number; units: number }>(allServiceZones().map((c) => [c, { available: 0, units: 0 }]));

  for (const [id, lng, lat] of raw.positions) {
    const lastSeenAt = Number(raw.lastSeen[id] ?? 0);
    const age = now - lastSeenAt;
    const capability = (raw.capability[id] ?? 'BLS') as Capability;
    let status = (raw.status[id] ?? 'OFFLINE') as DisplayStatus;

    if (age > staleAfterMs) {
      status = 'STALE';
      stale++;
    } else {
      freshness.push(age);
      if (status === 'AVAILABLE') available++;
    }
    if (capability === 'ALS') als++;
    if (status !== 'STALE') {
      const cell = zoneOf({ lat, lng });
      const z = zones.get(cell) ?? { available: 0, units: 0 };
      z.units++;
      if (status === 'AVAILABLE') z.available++;
      zones.set(cell, z);
    }
    agents.push([id, round6(lng), round6(lat), status, capability, lastSeenAt]);
  }

  freshness.sort((a, b) => a - b);
  const zoneRows: ZoneRow[] = [...zones].map(([cell, z]) => [cell, z.available, z.units]);
  const serviceZones = allServiceZones();
  const live: Partial<Record<RequestState, number>> = {};
  for (const c of calls) live[c[3]] = (live[c[3]] ?? 0) + 1;
  const staleUnits = new Set(agents.filter((a) => a[3] === 'STALE').map((a) => a[0]));
  const needsAttention = calls.filter((c) => c[3] === 'ARRIVED' && c[5] !== null && staleUnits.has(c[5])).map((c) => c[0]);
  return {
    type: 'fleet.snapshot',
    ts: now,
    stats: {
      total: agents.length,
      available,
      stale,
      als,
      bls: agents.length - als,
      freshnessP50Ms: percentile(freshness, 50),
      freshnessP95Ms: percentile(freshness, 95),
      uncoveredZones: serviceZones.filter((c) => (zones.get(c)?.available ?? 0) === 0).length,
      totalZones: serviceZones.length,
    },
    agents,
    zones: zoneRows,
    calls,
    callStats: {
      live,
      completedLastHour: finishedLastHour.COMPLETED ?? 0,
      expiredLastHour: finishedLastHour.EXPIRED ?? 0,
      cancelledLastHour: finishedLastHour.CANCELLED ?? 0,
      needsAttention,
    },
  };
}

/** ~11 cm precision is plenty and trims the JSON. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
