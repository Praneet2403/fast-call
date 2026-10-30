/** Milliseconds since the Unix epoch. Numbers survive JSON round-trips; Date objects don't. */
export type Timestamp = number;

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** BLS = Basic Life Support (EMT, oxygen). ALS = Advanced Life Support (paramedic, monitor, drugs). */
export type Capability = 'BLS' | 'ALS';

/** P1 = life-threatening, P2 = urgent, P3 = non-urgent. */
export type Priority = 'P1' | 'P2' | 'P3';

export type AgentStatus =
  | 'OFFLINE'
  | 'AVAILABLE'
  | 'DISPATCHED' // offer sent, waiting for the crew to acknowledge
  | 'EN_ROUTE' // driving to the scene
  | 'AT_SCENE'
  | 'TRANSPORTING' // patient on board, driving to hospital
  | 'AT_HOSPITAL'; // handover, unit not yet free

export interface Agent {
  id: string;
  status: AgentStatus;
  capability: Capability;
  location: GeoPoint;
  lastSeenAt: Timestamp;
}

export type RequestState =
  | 'CREATED'
  | 'MATCHING'
  | 'OFFERED'
  | 'ASSIGNED'
  | 'EN_ROUTE'
  | 'ARRIVED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED';

/** Named DispatchRequest because `Request` is already a global (Fetch API) in Node. */
export interface DispatchRequest {
  id: string;
  location: GeoPoint;
  priority: Priority;
  requiredCapability: Capability;
  state: RequestState;
  createdAt: Timestamp;
}

export type OfferOutcome = 'PENDING' | 'ACKNOWLEDGED' | 'UNABLE' | 'TIMED_OUT' | 'CANCELLED';

export interface Offer {
  id: string;
  requestId: string;
  agentId: string;
  sentAt: Timestamp;
  expiresAt: Timestamp;
  outcome: OfferOutcome;
}

/** Sent by every agent every few seconds. Doubles as the heartbeat. */
export interface LocationPing {
  type: 'ping';
  agentId: string;
  lat: number;
  lng: number;
  ts: Timestamp;
}

export interface Hospital {
  id: string;
  name: string;
  location: GeoPoint;
  hasALSCare: boolean;
}
