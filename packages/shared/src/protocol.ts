import type { AgentStatus, Capability, GeoPoint, LocationPing, Priority, RequestState, Timestamp } from './types.js';

// ---- crew devices (simulator) → ingest: ws /ws/agents ----

/** Sent on every (re)connect: each unit's capability and what it is doing right now. */
export interface RegisterMessage {
  type: 'register';
  agents: { agentId: string; capability: Capability; status?: AgentStatus }[];
}

/** All pings produced in one simulator tick, sent as one frame instead of hundreds. */
export interface PingBatchMessage {
  type: 'pings';
  pings: LocationPing[];
}

/** The crew's answer to an offer: ACK takes the call, UNABLE refuses it (vehicle fault, etc.). */
export interface OfferResponseMessage {
  type: 'offer.response';
  offerId: string;
  agentId: string;
  response: 'ACK' | 'UNABLE';
}

/** Status the crew reports while working a call (like the status buttons in a real ambulance). */
export type CrewStatus = Extract<AgentStatus, 'EN_ROUTE' | 'AT_SCENE' | 'TRANSPORTING' | 'AT_HOSPITAL' | 'AVAILABLE'>;

export interface CrewStatusMessage {
  type: 'status';
  agentId: string;
  status: CrewStatus;
  requestId: string;
  /** Device time of the report: lets the server drop reports that arrive out of order. */
  ts: Timestamp;
}

export type AgentChannelMessage = RegisterMessage | PingBatchMessage | OfferResponseMessage | CrewStatusMessage;

// ---- dispatcher → crew devices (via Redis pub/sub, relayed by ingest) ----

export const AGENT_COMMANDS_CHANNEL = 'agent-commands';

/** "Can you take this call?" The crew must answer before `expiresAt`. */
export interface OfferCommand {
  type: 'offer';
  offerId: string;
  agentId: string;
  requestId: string;
  location: GeoPoint;
  priority: Priority;
  requiredCapability: Capability;
  expiresAt: Timestamp;
}

/** The ACK was accepted: the call is yours, start driving. */
export interface AssignedCommand {
  type: 'assigned';
  offerId: string;
  agentId: string;
  requestId: string;
  location: GeoPoint;
}

/** The offer or assignment is void (timed out, or the call was cancelled). Go back to standby. */
export interface OfferWithdrawnCommand {
  type: 'offer.withdrawn';
  offerId: string | null;
  agentId: string;
  requestId: string;
  reason: string;
}

export type AgentCommand = OfferCommand | AssignedCommand | OfferWithdrawnCommand;

// ---- API → dispatcher: BullMQ queue `dispatch` ----

export const DISPATCH_QUEUE = 'dispatch';

/** Job "match": find and offer a unit for this request. */
export interface MatchJobData {
  requestId: string;
}

/** Job "offer-response": the crew answered an offer. */
export interface OfferResponseJobData {
  offerId: string;
  agentId: string;
  response: 'ACK' | 'UNABLE';
}

/** Job "offer-timeout": delayed; fires if the crew never answered. */
export interface OfferTimeoutJobData {
  offerId: string;
}

/** Job "call-cancelled": free whichever unit was offered or assigned the call. */
export interface CallCancelledJobData {
  requestId: string;
}

/** Job "crew-status": the crew reported progress on a call. */
export interface CrewStatusJobData {
  agentId: string;
  status: CrewStatus;
  requestId: string;
  ts: Timestamp;
}

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

/** A live call; agentId is the assigned unit, or the unit currently being offered the call. */
export type CallRow = [
  requestId: string,
  lng: number,
  lat: number,
  state: RequestState,
  priority: Priority,
  agentId: string | null,
  createdAt: Timestamp,
];

/** Coverage per H3 zone: how many units are free in it right now, and how many are in it at all. */
export type ZoneRow = [cell: string, available: number, units: number];

export interface FleetStats {
  total: number;
  available: number;
  stale: number;
  als: number;
  bls: number;
  /** Age of each unit's latest location: now − lastSeenAt. */
  freshnessP50Ms: number;
  freshnessP95Ms: number;
  /** Service-area zones with no free unit inside them right now. */
  uncoveredZones: number;
  totalZones: number;
}

export interface CallStats {
  /** Calls not yet finished, by state. */
  live: Partial<Record<RequestState, number>>;
  /** Finished in the last hour. */
  completedLastHour: number;
  expiredLastHour: number;
  cancelledLastHour: number;
  /**
   * Calls whose crew is on scene but whose unit has gone silent. The system deliberately does not
   * send a second ambulance (the crew is probably with the patient), so a human must look.
   */
  needsAttention: string[];
}

export interface FleetSnapshotMessage {
  type: 'fleet.snapshot';
  ts: Timestamp;
  stats: FleetStats;
  agents: FleetRow[];
  calls: CallRow[];
  callStats: CallStats;
  zones: ZoneRow[];
}

export type DashboardMessage = FleetSnapshotMessage;
