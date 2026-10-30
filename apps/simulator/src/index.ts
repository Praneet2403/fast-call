import { isWithin, JAIPUR_BOUNDS } from '@fast-call/shared';
import type { LocationPing } from '@fast-call/shared';
import { RoadGraph } from '@fast-call/roads';
import { CallSender } from './call-sender.js';
import { CallGenerator } from './calls.js';
import { loadConfig } from './config.js';
import { Fleet } from './fleet.js';
import type { PingSink } from './fleet.js';
import { createRng } from './rng.js';
import { WebSocketSink } from './ws-sink.js';

const config = loadConfig();
const rng = createRng(config.seed);

const setupStarted = performance.now();
const graph = RoadGraph.load();
const fleet = new Fleet(config, rng, graph);
console.log(
  `[sim] road graph ${graph.nodeCount} nodes; ${config.agentCount} initial routes planned in ` +
    `${Math.round(performance.now() - setupStarted)}ms`,
);

/** Offline sink (INGEST_URL=off): just counts pings. */
class CountingSink implements PingSink {
  sent = 0;
  dropped = 0;
  send(_ping: LocationPing): void {
    this.sent++;
  }
}

const sink =
  config.ingestUrl === 'off'
    ? new CountingSink()
    : new WebSocketSink(
        config.ingestUrl,
        fleet.agents.map((a) => ({ agentId: a.id, capability: a.capability })),
      );
if (sink instanceof WebSocketSink) sink.connect();

const startedAt = Date.now();
// Separate random stream for calls, so enabling calls never changes how the fleet moves.
const calls = config.callsPerMin > 0 ? new CallGenerator(createRng(config.seed ^ 0x9e3779b9), graph, config.callsPerMin) : null;
const callSender = new CallSender(config.apiUrl, String(startedAt));
let lastLogAt = startedAt;
let pingsSinceLog = 0;
let maxStepSinceLog = 0;

const alsCount = fleet.agents.filter((a) => a.capability === 'ALS').length;
console.log(
  `[sim] seed=${config.seed} agents=${config.agentCount} (ALS ${alsCount}, BLS ${config.agentCount - alsCount}) ` +
    `tick=${config.tickMs}ms ping=${config.pingIntervalMs}±${config.pingJitterMs}ms ingest=${config.ingestUrl} ` +
    `calls=${config.callsPerMin}/min avg → ${config.apiUrl}`,
);

fleet.schedulePings(startedAt);

const timer = setInterval(() => {
  const now = Date.now();
  const stats = fleet.tick(now, sink);
  pingsSinceLog += stats.pingsSent;
  maxStepSinceLog = Math.max(maxStepSinceLog, stats.maxStepMeters);
  for (const call of calls?.due(now, config.tickMs) ?? []) callSender.send(call);

  if (now - lastLogAt >= config.logEverySec * 1000) {
    const secs = (now - lastLogAt) / 1000;
    const outOfBounds = fleet.agents.filter((a) => !isWithin(JAIPUR_BOUNDS, a.position)).length;
    const sample = fleet.agents[0]!;
    console.log(
      `[sim] t=${Math.round((now - startedAt) / 1000)}s pings/s=${(pingsSinceLog / secs).toFixed(1)} ` +
        `sent=${sink.sent} dropped=${sink.dropped} maxStep=${maxStepSinceLog.toFixed(1)}m outOfBounds=${outOfBounds} ` +
        `${sample.id}@${sample.position.lat.toFixed(5)},${sample.position.lng.toFixed(5)} ` +
        `calls created=${callSender.created} replayed=${callSender.replayed} failed=${callSender.failed}`,
    );
    lastLogAt = now;
    pingsSinceLog = 0;
    maxStepSinceLog = 0;
  }

  if (config.durationSec > 0 && now - startedAt >= config.durationSec * 1000) shutdown();
}, config.tickMs);

function shutdown() {
  clearInterval(timer);
  if (sink instanceof WebSocketSink) sink.close();
  console.log(
    `[sim] stopped after ${Math.round((Date.now() - startedAt) / 1000)}s, sent=${sink.sent} dropped=${sink.dropped}`,
  );
  // Give the socket a moment to send its close frame.
  setTimeout(() => process.exit(0), 100);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
