function intEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

export interface ApiConfig {
  port: number;
  host: string;
  redisUrl: string;
  /** A unit with no ping for this long is considered stale (heartbeat key expires). */
  heartbeatTtlSec: number;
  /** How often dashboards receive a fleet snapshot. */
  snapshotIntervalMs: number;
}

export function loadConfig(): ApiConfig {
  return {
    port: intEnv('PORT', 4000),
    host: process.env.HOST ?? '127.0.0.1',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    heartbeatTtlSec: intEnv('HEARTBEAT_TTL_SEC', 15),
    snapshotIntervalMs: intEnv('SNAPSHOT_INTERVAL_MS', 1000, 100),
  };
}
