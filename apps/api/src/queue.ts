import { Queue } from 'bullmq';
import { DISPATCH_QUEUE } from '@fast-call/shared';
import type { CallCancelledJobData, CrewStatusJobData, MatchJobData, OfferResponseJobData } from '@fast-call/shared';

export interface DispatchQueue {
  enqueueMatch(requestId: string): Promise<void>;
  enqueueOfferResponse(data: OfferResponseJobData): Promise<void>;
  enqueueCrewStatus(data: CrewStatusJobData): Promise<void>;
  enqueueCallCancelled(data: CallCancelledJobData): Promise<void>;
  close(): Promise<void>;
}

const KEEP = { removeOnComplete: 1000, removeOnFail: 5000 };

export function redisConnection(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db: Number(url.pathname.slice(1) || 0),
    maxRetriesPerRequest: null, // required by BullMQ for blocking commands
  };
}

export function createDispatchQueue(redisUrl: string): DispatchQueue {
  const queue = new Queue(DISPATCH_QUEUE, { connection: redisConnection(redisUrl) });
  return {
    async enqueueMatch(requestId) {
      await queue.add(
        'match',
        { requestId } satisfies MatchJobData,
        {
          // Deterministic job id: enqueueing the same request twice (a retried POST, the Day 5
          // sweeper) is a no-op while the job exists, so a call is never matched twice in parallel.
          jobId: `match-${requestId}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 500 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    },
    async enqueueOfferResponse(data) {
      // One answer per offer is enough; duplicates (device retries) are dropped by the job id.
      await queue.add('offer-response', data, { jobId: `response-${data.offerId}`, attempts: 5, ...KEEP });
    },
    async enqueueCrewStatus(data) {
      await queue.add('crew-status', data, { jobId: `status-${data.requestId}-${data.status}`, attempts: 5, ...KEEP });
    },
    async enqueueCallCancelled(data) {
      await queue.add('call-cancelled', data, { jobId: `cancelled-${data.requestId}`, attempts: 5, ...KEEP });
    },
    close: () => queue.close(),
  };
}
