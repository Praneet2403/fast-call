import { isWithin, JAIPUR_BOUNDS } from '@fast-call/shared';
import type { LocationPing } from '@fast-call/shared';
import { loadConfig } from './config.js';
import { Fleet } from './fleet.js';
import type { PingSink } from './fleet.js';
import { createRng } from './rng.js';

const config = loadConfig();
const rng = createRng(config.seed);
const fleet = new Fleet(config, rng, JAIPUR_BOUNDS);

/** Day 1 sink: just counts pings. Day 2 swaps this for a WebSocket sink to the ingest service. */
class CountingSink implements PingSink {
  count = 0;
  last: LocationPing | undefined;
  send(ping: LocationPing): void {
    this.count++;
    this.last = ping;
  }
}

const sink = new CountingSink();
const startedAt = Date.now();
let lastLogAt = startedAt;
let pingsSinceLog = 0;
let maxStepSinceLog = 0;

const alsCount = fleet.agents.filter((a) => a.capability === 'ALS').length;
console.log(
  `[sim] seed=${config.seed} agents=${config.agentCount} (ALS ${alsCount}, BLS ${config.agentCount - alsCount}) ` +
    `tick=${config.tickMs}ms ping=${config.pingIntervalMs}±${config.pingJitterMs}ms`,
);

fleet.schedulePings(startedAt);

const timer = setInterval(() => {
  const now = Date.now();
  const stats = fleet.tick(now, sink);
  pingsSinceLog += stats.pingsSent;
  maxStepSinceLog = Math.max(maxStepSinceLog, stats.maxStepMeters);

  if (now - lastLogAt >= config.logEverySec * 1000) {
    const secs = (now - lastLogAt) / 1000;
    const outOfBounds = fleet.agents.filter((a) => !isWithin(JAIPUR_BOUNDS, a.position)).length;
    const sample = fleet.agents[0]!;
    console.log(
      `[sim] t=${Math.round((now - startedAt) / 1000)}s pings/s=${(pingsSinceLog / secs).toFixed(1)} ` +
        `maxStep=${maxStepSinceLog.toFixed(1)}m outOfBounds=${outOfBounds} ` +
        `${sample.id}@${sample.position.lat.toFixed(5)},${sample.position.lng.toFixed(5)}`,
    );
    lastLogAt = now;
    pingsSinceLog = 0;
    maxStepSinceLog = 0;
  }

  if (config.durationSec > 0 && now - startedAt >= config.durationSec * 1000) shutdown();
}, config.tickMs);

function shutdown() {
  clearInterval(timer);
  console.log(`[sim] stopped after ${Math.round((Date.now() - startedAt) / 1000)}s, ${sink.count} pings sent`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
