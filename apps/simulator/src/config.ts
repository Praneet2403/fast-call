function intEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

function floatEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n) || n < min || n > max) {
    throw new Error(`${name} must be a number in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

export interface SimConfig {
  agentCount: number;
  seed: number;
  /** Fixed simulation step. Movement depends only on seed + tick count, so runs are replayable. */
  tickMs: number;
  pingIntervalMs: number;
  /** Each ping is scheduled at interval ± jitter so agents don't all fire in the same tick. */
  pingJitterMs: number;
  /** Share of the fleet that is ALS (the rest is BLS). */
  alsShare: number;
  logEverySec: number;
  /** Stop after this many seconds. 0 = run forever. */
  durationSec: number;
  /** Ingest WebSocket URL, or "off" to run without sending pings anywhere. */
  ingestUrl: string;
  /** Average emergency calls per minute over a day (shaped by time of day). 0 = no calls. */
  callsPerMin: number;
  /** Base URL of the request API. */
  apiUrl: string;
  chaos: ChaosConfig;
}

/** Failure injection, all off by default. */
export interface ChaosConfig {
  /** Share of units whose device dies (no pings, no messages, ignores commands). Also used by SIGUSR2. */
  killPct: number;
  /** Kill `killPct` of the fleet this many seconds after start. 0 = only on SIGUSR2. */
  killAtSec: number;
  /** Dead devices come back after this long. 0 = never. */
  reviveAfterSec: number;
  /** Probability that any single ping is lost. */
  dropPct: number;
  /** Probability that a ping is delayed by `delayMs` (so it arrives after newer ones). */
  delayPct: number;
  delayMs: number;
}

export function loadConfig(): SimConfig {
  const config: SimConfig = {
    agentCount: intEnv('AGENT_COUNT', 1000, 1),
    seed: intEnv('SEED', 42),
    tickMs: intEnv('TICK_MS', 1000, 50),
    pingIntervalMs: intEnv('PING_INTERVAL_MS', 4000, 100),
    pingJitterMs: intEnv('PING_JITTER_MS', 1000),
    alsShare: floatEnv('ALS_SHARE', 0.3, 0, 1),
    logEverySec: intEnv('LOG_EVERY_SEC', 5, 1),
    durationSec: intEnv('DURATION_SEC', 0),
    ingestUrl: process.env.INGEST_URL ?? 'ws://127.0.0.1:4000/ws/agents',
    callsPerMin: floatEnv('CALLS_PER_MIN', 6, 0, 10_000),
    apiUrl: process.env.API_URL ?? 'http://127.0.0.1:4000',
    chaos: {
      killPct: floatEnv('CHAOS_KILL_PCT', 0.1, 0, 1),
      killAtSec: intEnv('CHAOS_KILL_AT_SEC', 0),
      reviveAfterSec: intEnv('CHAOS_REVIVE_AFTER_SEC', 0),
      dropPct: floatEnv('CHAOS_DROP_PCT', 0, 0, 1),
      delayPct: floatEnv('CHAOS_DELAY_PCT', 0, 0, 1),
      delayMs: intEnv('CHAOS_DELAY_MS', 8_000),
    },
  };
  if (config.pingJitterMs >= config.pingIntervalMs) {
    throw new Error('PING_JITTER_MS must be smaller than PING_INTERVAL_MS');
  }
  return config;
}
