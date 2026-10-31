import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createSql, migrate, RequestRepo } from '@fast-call/db';
import { DISPATCH_QUEUE } from '@fast-call/shared';
import type { CallCancelledJobData, CrewStatusJobData, MatchJobData, OfferResponseJobData, OfferTimeoutJobData } from '@fast-call/shared';
import { loadConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import type { Scheduler } from './dispatcher.js';
import { FleetOps } from './fleet.js';
import { Metrics } from './metrics.js';

const config = loadConfig();
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

const scheduler: Scheduler = {
  async matchLater(requestId, delayMs) {
    // Unique id per retry: BullMQ ignores an add() whose id matches a job it still remembers.
    await queue.add('match', { requestId } satisfies MatchJobData, {
      delay: delayMs,
      jobId: `match-${requestId}-${Date.now()}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  },
  async offerTimeout(offerId, delayMs) {
    await queue.add('offer-timeout', { offerId } satisfies OfferTimeoutJobData, {
      delay: delayMs,
      jobId: `timeout-${offerId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  },
};

const metrics = new Metrics();
const dispatcher = new Dispatcher(new RequestRepo(sql), new FleetOps(redis), scheduler, config, metrics);

const worker = new Worker(
  DISPATCH_QUEUE,
  async (job) => {
    switch (job.name) {
      case 'match':
        return dispatcher.handleMatch((job.data as MatchJobData).requestId);
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

worker.on('failed', (job, err) => console.error(`[dispatcher] ${job?.name} ${job?.id} failed: ${err.message}`));
console.log(
  `[dispatcher] up: concurrency=${config.concurrency} ack timeout=${config.ackTimeoutMs}ms rings=${config.searchRadiiKm.join('/')}km`,
);
const statsTimer = setInterval(() => console.log(`[dispatcher] ${metrics.summary()}`), 10_000);

async function shutdown() {
  clearInterval(statsTimer);
  await worker.close(); // finish in-flight jobs first
  await queue.close();
  redis.disconnect();
  await sql.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
