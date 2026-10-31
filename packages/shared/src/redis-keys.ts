/**
 * Redis layout for live fleet state, shared by the ingest API and the dispatcher:
 *   agents:geo          GEO set   agentId → position (GEOSEARCH for nearby units)
 *   agents:lastSeen     HASH      agentId → ts of the newest accepted ping
 *   agents:status       HASH      agentId → AgentStatus
 *   agents:capability   HASH      agentId → BLS | ALS
 *   agents:statusTs     HASH      agentId → device ts of the newest crew status report
 *   agent:{id}:hb       STRING    with TTL; missing key = unit is stale
 *   agent:{id}:lock     STRING    requestId holding the unit while an offer is open (with TTL)
 *   zones:available     HASH      H3 cell → free units in it (rewritten every second by the API)
 * Fleet-wide hashes let a snapshot read all 10k units in 4 commands instead of 10k.
 */
export const REDIS_KEYS = {
  geo: 'agents:geo',
  lastSeen: 'agents:lastSeen',
  status: 'agents:status',
  capability: 'agents:capability',
  statusTs: 'agents:statusTs',
  heartbeat: (agentId: string) => `agent:${agentId}:hb`,
  lock: (agentId: string) => `agent:${agentId}:lock`,
  zonesAvailable: 'zones:available',
} as const;
