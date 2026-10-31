function intEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

export interface DispatcherConfig {
  redisUrl: string;
  /** How long a crew has to acknowledge an offer. */
  ackTimeoutMs: number;
  /** Search rings in km: try close units first, widen only if nobody is free. */
  searchRadiiKm: number[];
  /** Candidates fetched per ring before filtering. */
  candidatesPerRing: number;
  /** Offers tried for one call before giving up. */
  maxOffers: number;
  /** A call nobody can take within this window is EXPIRED (escalated to a human dispatcher). */
  maxWaitMs: number;
  /** Delay before re-checking a call when no unit is free right now. */
  retryDelayMs: number;
  concurrency: number;
}

export function loadConfig(): DispatcherConfig {
  return {
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    ackTimeoutMs: intEnv('ACK_TIMEOUT_MS', 15_000),
    searchRadiiKm: (process.env.SEARCH_RADII_KM ?? '3,5,8').split(',').map(Number),
    candidatesPerRing: intEnv('CANDIDATES_PER_RING', 25),
    maxOffers: intEnv('MAX_OFFERS', 5),
    maxWaitMs: intEnv('MAX_WAIT_MS', 180_000),
    retryDelayMs: intEnv('RETRY_DELAY_MS', 2_000),
    concurrency: intEnv('CONCURRENCY', 32),
  };
}
