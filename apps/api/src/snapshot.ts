import type { Capability, DisplayStatus, FleetRow, FleetSnapshotMessage } from '@fast-call/shared';
import type { RawFleet } from './store.js';

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]!;
}

/** Pure: turns raw Redis state into the message dashboards receive. */
export function buildSnapshot(raw: RawFleet, now: number, heartbeatTtlSec: number): FleetSnapshotMessage {
  const staleAfterMs = heartbeatTtlSec * 1000;
  const agents: FleetRow[] = [];
  const freshness: number[] = [];
  let available = 0;
  let stale = 0;
  let als = 0;

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
    agents.push([id, round6(lng), round6(lat), status, capability, lastSeenAt]);
  }

  freshness.sort((a, b) => a - b);
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
    },
    agents,
  };
}

/** ~11 cm precision is plenty and trims the JSON. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
