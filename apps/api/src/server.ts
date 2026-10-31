import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { RequestRepo } from '@fast-call/db';
import type { AgentCommand } from '@fast-call/shared';
import type { ApiConfig } from './config.js';
import { parseAgentMessage } from './messages.js';
import type { DispatchQueue } from './queue.js';
import { registerRequestRoutes } from './routes/requests.js';
import { buildSnapshot } from './snapshot.js';
import type { FleetStore } from './store.js';

/** Source of dispatcher → crew commands (Redis pub/sub in production; absent in route tests). */
export interface CommandFeed {
  onCommand(handler: (raw: string) => void): void;
}

export interface ServerDeps {
  store: FleetStore;
  requests: RequestRepo;
  queue: DispatchQueue;
  commands?: CommandFeed;
}

export interface IngestCounters {
  received: number;
  accepted: number;
  outOfOrder: number;
  rejected: number;
}

export async function buildServer(config: ApiConfig, deps: ServerDeps) {
  const { store } = deps;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(websocket);
  registerRequestRoutes(app, deps);

  const counters: IngestCounters = { received: 0, accepted: 0, outOfOrder: 0, rejected: 0 };
  /** Which socket each crew is on. The simulator multiplexes every unit over one socket. */
  const crewSockets = new Map<string, WebSocket>();
  const relay = { delivered: 0, undeliverable: 0, crewMessages: 0 };
  const dashboards = new Set<WebSocket>();
  let lastSnapshotBytes = 0;
  let lastSnapshotBuildMs = 0;

  app.get('/health', async () => ({ ok: true }));

  app.get('/stats', async () => ({
    ingest: counters,
    relay,
    crewsConnected: crewSockets.size,
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
      queue = queue.then(() => handleAgentFrame(data.toString(), socket)).catch((err) => req.log.error(err));
    });
    socket.on('close', () => {
      for (const [agentId, ws] of crewSockets) if (ws === socket) crewSockets.delete(agentId);
      req.log.info('agent channel closed');
    });
  });

  async function handleAgentFrame(raw: string, socket: WebSocket) {
    const result = parseAgentMessage(raw);
    if (!result.ok) {
      counters.rejected++;
      return;
    }
    counters.rejected += result.rejectedPings;

    const msg = result.message;
    if (msg.type === 'register') {
      await store.register(msg.agents);
      for (const { agentId } of msg.agents) crewSockets.set(agentId, socket);
      app.log.info({ agents: msg.agents.length }, 'agents registered');
      return;
    }
    // Crew answers and status reports go to the dispatcher, which owns every dispatch decision.
    if (msg.type === 'offer.response') {
      relay.crewMessages++;
      await deps.queue.enqueueOfferResponse({ offerId: msg.offerId, agentId: msg.agentId, response: msg.response });
      return;
    }
    if (msg.type === 'status') {
      relay.crewMessages++;
      await deps.queue.enqueueCrewStatus({ agentId: msg.agentId, status: msg.status, requestId: msg.requestId, ts: msg.ts });
      return;
    }
    counters.received += msg.pings.length;
    const accepted = await store.applyPings(msg.pings);
    counters.accepted += accepted;
    counters.outOfOrder += msg.pings.length - accepted;
  }

  // Dispatcher → crew: offers, assignments and withdrawals, forwarded to the unit's socket.
  deps.commands?.onCommand((raw) => {
    let agentId: string | undefined;
    try {
      agentId = (JSON.parse(raw) as AgentCommand).agentId;
    } catch {
      return;
    }
    const ws = agentId ? crewSockets.get(agentId) : undefined;
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(raw);
      relay.delivered++;
    } else {
      relay.undeliverable++; // crew offline: the offer simply times out and the call is re-matched
    }
  });

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
      const [fleet, calls, finished] = await Promise.all([
        store.readFleet(),
        deps.requests.liveCalls(),
        deps.requests.finishedLastHour(),
      ]);
      const snapshot = buildSnapshot(fleet, Date.now(), config.heartbeatTtlSec, calls, finished);
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
