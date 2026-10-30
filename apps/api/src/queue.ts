import { Queue } from 'bullmq';
import { DISPATCH_QUEUE } from '@fast-call/shared';
import type { MatchJobData } from '@fast-call/shared';

export interface DispatchQueue {
  enqueueMatch(requestId: string): Promise<void>;
  close(): Promise<void>;
}

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
  const queue = new Queue<MatchJobData>(DISPATCH_QUEUE, { connection: redisConnection(redisUrl) });
  return {
    async enqueueMatch(requestId) {
      await queue.add(
        'match',
        { requestId },
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
    close: () => queue.close(),
  };
}
