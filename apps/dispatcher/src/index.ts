import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createSql, migrate, RequestRepo } from '@fast-call/db';
import { DISPATCH_QUEUE } from '@fast-call/shared';
import type { CallCancelledJobData, CrewStatusJobData, MatchJobData, OfferResponseJobData, OfferTimeoutJobData } from '@fast-call/shared';
import { loadConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import type { Scheduler } from './dispatcher.js';
import { FleetOps } from './fleet.js';
import { Metrics } from './metrics.js';
import { Sweeper } from './sweeper.js';

const config = loadConfig();
const instanceId = `dispatcher-${process.pid}-${randomUUID().slice(0, 8)}`;
const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { svc: 'dispatcher', instance: instanceId } });

const url = new URL(config.redisUrl);
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  db: Number(url.pathname.slice(1) || 0),
  maxRetriesPerRequest: null,
};

const sql = createSql();
await migrate(sql);
const redis = new Redis(config.redisUrl);
const queue = new Queue(DISPATCH_QUEUE, { connection });
const KEEP = { removeOnComplete: 1000, removeOnFail: 5000 };

const scheduler: Scheduler = {
  async matchLater(requestId, delayMs) {
    // Unique id per retry: BullMQ ignores an add() whose id matches a job it still remembers.
    await queue.add('match', { requestId } satisfies MatchJobData, { delay: delayMs, jobId: `match-${requestId}-${Date.now()}`, ...KEEP });
  },
  async offerTimeout(offerId, delayMs) {
    await queue.add('offer-timeout', { offerId } satisfies OfferTimeoutJobData, { delay: delayMs, jobId: `timeout-${offerId}`, ...KEEP });
  },
  async matchRescue(requestId) {
    // At most one rescue job per call per 30 s window, however often the sweeper runs.
    const window = Math.floor(Date.now() / 30_000);
    await queue.add('match', { requestId } satisfies MatchJobData, { jobId: `match-${requestId}-rescue-${window}`, ...KEEP });
  },
};

const metrics = new Metrics();
const repo = new RequestRepo(sql);
const fleet = new FleetOps(redis);
const dispatcher = new Dispatcher(repo, fleet, scheduler, config, metrics);
const sweeper = new Sweeper(repo, fleet, scheduler, dispatcher, { stallMs: config.stallMs, offerGraceMs: config.offerGraceMs });

const worker = new Worker(
  DISPATCH_QUEUE,
  async (job) => {
    switch (job.name) {
      case 'match': {
        const { requestId } = job.data as MatchJobData;
        const outcome = await dispatcher.handleMatch(requestId);
        // One structured line per decision, keyed by requestId so a call's whole story is greppable.
        if (outcome.kind === 'offered') log.info({ requestId, agentId: outcome.agentId, offerId: outcome.offerId }, 'offered');
        else if (outcome.kind === 'expired') log.warn({ requestId, reason: outcome.reason }, 'call expired');
        return outcome;
      }
      case 'offer-response':
        return dispatcher.handleOfferResponse(job.data as OfferResponseJobData);
      case 'offer-timeout':
        return dispatcher.handleOfferTimeout(job.data as OfferTimeoutJobData);
      case 'crew-status':
        return dispatcher.handleCrewStatus(job.data as CrewStatusJobData);
      case 'call-cancelled':
        return dispatcher.handleCallCancelled(job.data as CallCancelledJobData);
      default:
        throw new Error(`unknown job ${job.name}`);
    }
  },
  { connection, concurrency: config.concurrency },
);
worker.on('failed', (job, err) => log.error({ job: job?.name, jobId: job?.id, data: job?.data, err: err.message }, 'job failed'));

// Only the leader sweeps; if it dies, its key expires and another instance takes over.
let sweeping = false;
const sweepTimer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    if (!(await fleet.tryLead(instanceId, config.sweepIntervalMs * 3))) return;
    const report = await sweeper.sweep();
    if (Object.values(report).some((n) => n > 0)) log.warn(report, 'sweeper repaired state');
  } catch (err) {
    log.error({ err: (err as Error).message }, 'sweep failed');
  } finally {
    sweeping = false;
  }
}, config.sweepIntervalMs);

log.info(
  { concurrency: config.concurrency, ackTimeoutMs: config.ackTimeoutMs, ringsKm: config.searchRadiiKm, sweepEveryMs: config.sweepIntervalMs },
  'dispatcher up',
);
const statsTimer = setInterval(() => log.info({ stats: metrics.summary() }, 'stats'), 10_000);

async function shutdown() {
  clearInterval(statsTimer);
  clearInterval(sweepTimer);
  await worker.close(); // finish in-flight jobs first
  await queue.close();
  redis.disconnect();
  await sql.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
