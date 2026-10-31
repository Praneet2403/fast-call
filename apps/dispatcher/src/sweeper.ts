import type { RequestRepo } from '@fast-call/db';
import type { Dispatcher, Scheduler } from './dispatcher.js';
import type { FleetOps } from './fleet.js';

export interface SweeperConfig {
  /** A CREATED/MATCHING call with no progress for this long gets a fresh match job. */
  stallMs: number;
  /** Extra time past an offer's expiry before the sweeper settles it itself. */
  offerGraceMs: number;
}

export interface SweepReport {
  rescuedCalls: number;
  overdueOffers: number;
  reassignedCalls: number;
  freedUnits: number;
}

/**
 * The safety net. The normal flow is event-driven (jobs, timeouts, crew reports); this loop finds
 * anything that event flow lost (a crashed worker, a dropped job, a unit that went dark) and puts
 * it back on track. Every action it takes is idempotent, so a sweep racing normal work is harmless.
 */
export class Sweeper {
  constructor(
    private readonly repo: RequestRepo,
    private readonly fleet: FleetOps,
    private readonly scheduler: Scheduler,
    private readonly dispatcher: Dispatcher,
    private readonly config: SweeperConfig,
  ) {}

  async sweep(): Promise<SweepReport> {
    const report: SweepReport = { rescuedCalls: 0, overdueOffers: 0, reassignedCalls: 0, freedUnits: 0 };

    // 1. Calls that stopped moving: e.g. the API crashed between saving the call and queueing it,
    //    or a worker died holding the match job.
    for (const call of await this.repo.stalledCalls(this.config.stallMs)) {
      await this.scheduler.matchRescue(call.id);
      report.rescuedCalls++;
    }

    // 2. Offers whose timeout job never fired: settle them as timed out (this also re-matches the call).
    for (const offerId of await this.repo.overdueOffers(this.config.offerGraceMs)) {
      await this.dispatcher.handleOfferTimeout({ offerId });
      report.overdueOffers++;
    }

    // 3. Units driving to a call that went silent: reassign the call to someone else.
    const driving = await this.repo.callsBeingDrivenTo();
    const alive = await this.fleet.alive([...new Set(driving.map((c) => c.agentId))]);
    for (const call of driving) {
      if (!alive.has(call.agentId) && (await this.dispatcher.reassignLostUnit(call.id, call.agentId))) {
        report.reassignedCalls++;
      }
    }

    // 4. Units stuck in DISPATCHED with no lock and no call: a worker crashed between claiming the
    //    unit and creating the offer. Order matters: read the lock-less units *before* the busy set,
    //    so a unit whose ACK lands in between is seen as busy, not as an orphan.
    const lockless = await this.fleet.dispatchedWithoutLock();
    if (lockless.length > 0) {
      const busy = await this.repo.busyAgentIds();
      for (const agentId of lockless) {
        if (!busy.has(agentId) && (await this.fleet.freeOrphan(agentId))) report.freedUnits++;
      }
    }
    return report;
  }
}
