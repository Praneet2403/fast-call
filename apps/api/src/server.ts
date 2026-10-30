import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { ApiConfig } from './config.js';
import { parseAgentMessage } from './messages.js';
import { buildSnapshot } from './snapshot.js';
import type { FleetStore } from './store.js';

export interface IngestCounters {
  received: number;
  accepted: number;
  outOfOrder: number;
  rejected: number;
}

export async function buildServer(config: ApiConfig, store: FleetStore) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(websocket);

  const counters: IngestCounters = { received: 0, accepted: 0, outOfOrder: 0, rejected: 0 };
  const dashboards = new Set<WebSocket>();
  let lastSnapshotBytes = 0;
  let lastSnapshotBuildMs = 0;

  app.get('/health', async () => ({ ok: true }));

  app.get('/stats', async () => ({
    ingest: counters,
    dashboards: dashboards.size,
    lastSnapshotBytes,
    lastSnapshotBuildMs,
  }));

  // Agent devices (the simulator) stream registrations and ping batches here.
  app.get('/ws/agents', { websocket: true }, (socket, req) => {
    req.log.info('agent channel connected');

    // Process one frame at a time so a burst can't pile up unbounded concurrent Redis work.
    let queue = Promise.resolve();
    socket.on('message', (data: Buffer) => {
      queue = queue.then(() => handleAgentFrame(data.toString())).catch((err) => req.log.error(err));
    });
    socket.on('close', () => req.log.info('agent channel closed'));
  });

  async function handleAgentFrame(raw: string) {
    const result = parseAgentMessage(raw);
    if (!result.ok) {
      counters.rejected++;
      return;
    }
    counters.rejected += result.rejectedPings;

    const msg = result.message;
    if (msg.type === 'register') {
      await store.register(msg.agents);
      app.log.info({ agents: msg.agents.length }, 'agents registered');
      return;
    }
    counters.received += msg.pings.length;
    const accepted = await store.applyPings(msg.pings);
    counters.accepted += accepted;
    counters.outOfOrder += msg.pings.length - accepted;
  }

  // Ops dashboards receive one batched fleet snapshot per interval, never raw pings.
  app.get('/ws/dashboard', { websocket: true }, (socket) => {
    dashboards.add(socket);
    socket.on('close', () => dashboards.delete(socket));
  });

  let broadcasting = false;
  const timer = setInterval(async () => {
    if (dashboards.size === 0 || broadcasting) return; // skip a tick rather than overlap
    broadcasting = true;
    try {
      const started = performance.now();
      const snapshot = buildSnapshot(await store.readFleet(), Date.now(), config.heartbeatTtlSec);
      const payload = JSON.stringify(snapshot); // serialise once, send to every dashboard
      lastSnapshotBuildMs = Math.round(performance.now() - started);
      lastSnapshotBytes = Buffer.byteLength(payload);
      for (const ws of dashboards) if (ws.readyState === ws.OPEN) ws.send(payload);
    } catch (err) {
      app.log.error(err, 'snapshot failed');
    } finally {
      broadcasting = false;
    }
  }, config.snapshotIntervalMs);

  app.addHook('onClose', async () => clearInterval(timer));
  return app;
}
