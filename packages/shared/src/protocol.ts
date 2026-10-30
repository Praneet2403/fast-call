import type { AgentStatus, Capability, LocationPing, Timestamp } from './types.js';

// ---- simulator (agent devices) → ingest: ws /ws/agents ----

/** Sent once per connection so ingest knows each unit's capability. */
export interface RegisterMessage {
  type: 'register';
  agents: { agentId: string; capability: Capability }[];
}

/** All pings produced in one simulator tick, sent as one frame instead of hundreds. */
export interface PingBatchMessage {
  type: 'pings';
  pings: LocationPing[];
}

export type AgentChannelMessage = RegisterMessage | PingBatchMessage;

// ---- ingest → dashboards: ws /ws/dashboard ----

/** STALE is derived, never stored: the unit's heartbeat has expired. */
export type DisplayStatus = AgentStatus | 'STALE';

/** Tuples instead of objects keep a 10k-agent snapshot roughly half the size. Lng first, like GeoJSON. */
export type FleetRow = [
  agentId: string,
  lng: number,
  lat: number,
  status: DisplayStatus,
  capability: Capability,
  lastSeenAt: Timestamp,
];

export interface FleetStats {
  total: number;
  available: number;
  stale: number;
  als: number;
  bls: number;
  /** Age of each unit's latest location: now − lastSeenAt. */
  freshnessP50Ms: number;
  freshnessP95Ms: number;
}

export interface FleetSnapshotMessage {
  type: 'fleet.snapshot';
  ts: Timestamp;
  stats: FleetStats;
  agents: FleetRow[];
}

export type DashboardMessage = FleetSnapshotMessage;
