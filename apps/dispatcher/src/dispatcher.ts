import type { RequestRepo, ResolveResult } from '@fast-call/db';
import type {
  CallCancelledJobData,
  CrewStatus,
  CrewStatusJobData,
  OfferResponseJobData,
  OfferTimeoutJobData,
  RequestState,
} from '@fast-call/shared';
import type { DispatcherConfig } from './config.js';
import type { FleetOps } from './fleet.js';
import type { Metrics } from './metrics.js';

/** Delayed follow-up work; backed by BullMQ in production, recorded in tests. */
export interface Scheduler {
  matchLater(requestId: string, delayMs: number): Promise<void>;
  offerTimeout(offerId: string, delayMs: number): Promise<void>;
  /** Sweeper re-enqueue: deduplicated per time window, so repeated sweeps don't pile up jobs. */
  matchRescue(requestId: string): Promise<void>;
}

export type MatchOutcome =
  | { kind: 'offered'; agentId: string; offerId: string }
  | { kind: 'retry-later' }
  | { kind: 'expired'; reason: string }
  | { kind: 'skipped'; state: RequestState | 'missing' };

/** The call's progress once a crew is assigned, and the crew status that moves it to each step. */
const CALL_PATH: { state: RequestState; reportedBy?: CrewStatus; reason: string }[] = [
  { state: 'ASSIGNED', reason: '' },
  { state: 'EN_ROUTE', reportedBy: 'EN_ROUTE', reason: 'crew en route' },
  { state: 'ARRIVED', reportedBy: 'AT_SCENE', reason: 'crew on scene' },
  { state: 'COMPLETED', reportedBy: 'AT_HOSPITAL', reason: 'patient handed over at hospital' },
];

/**
 * Day 4 strategy: offer the call to the nearest free unit that can do the job.
 * Every handler is safe to run twice (BullMQ retries) or concurrently with others:
 * state changes go through guarded transactions, and units are claimed atomically.
 */
export class Dispatcher {
  constructor(
    private readonly repo: RequestRepo,
    private readonly fleet: FleetOps,
    private readonly scheduler: Scheduler,
    private readonly config: DispatcherConfig,
    private readonly metrics: Metrics,
  ) {}

  async handleMatch(requestId: string): Promise<MatchOutcome> {
    const started = performance.now();
    const call = await this.repo.get(requestId);
    if (!call) return { kind: 'skipped', state: 'missing' };

    if (call.state === 'CREATED') {
      await this.repo.transition(requestId, 'MATCHING', { reason: 'dispatcher picked up call', onlyFrom: ['CREATED'] });
    } else if (call.state !== 'MATCHING') {
      return { kind: 'skipped', state: call.state }; // stale or duplicate job
    }

    const tried = new Set(await this.repo.offeredAgents(requestId));
    if (tried.size >= this.config.maxOffers) {
      return this.expire(requestId, `no crew acknowledged after ${tried.size} offers`);
    }

    for (const radiusKm of this.config.searchRadiiKm) {
      const candidates = await this.fleet.nearbyAvailable(
        call.location, radiusKm, this.config.candidatesPerRing, call.requiredCapability, tried,
      );
      for (const c of candidates) {
        // Another worker may grab this unit between our search and our claim: then try the next.
        if (!(await this.fleet.claim(c.agentId, requestId, this.config.ackTimeoutMs + 30_000))) continue;

        const res = await this.repo.createOffer(requestId, c.agentId, this.config.ackTimeoutMs, {
          reason: `nearest free ${c.capability} unit, ${c.distanceKm.toFixed(2)} km`,
          score: c.distanceKm,
          breakdown: { distanceKm: c.distanceKm },
        });
        if (!res.created) {
          await this.fleet.unclaim(c.agentId, requestId); // call was cancelled meanwhile
          return { kind: 'skipped', state: res.current };
        }

        await this.fleet.publish({
          type: 'offer',
          offerId: res.offer.id,
          agentId: c.agentId,
          requestId,
          location: call.location,
          priority: call.priority,
          requiredCapability: call.requiredCapability,
          expiresAt: res.offer.expiresAt,
        });
        await this.scheduler.offerTimeout(res.offer.id, this.config.ackTimeoutMs);
        this.metrics.offerMade(performance.now() - started, radiusKm);
        return { kind: 'offered', agentId: c.agentId, offerId: res.offer.id };
      }
    }

    if (Date.now() - call.createdAt > this.config.maxWaitMs) {
      return this.expire(requestId, `no free unit within ${this.config.maxWaitMs / 1000}s`);
    }
    this.metrics.noUnitFree();
    await this.scheduler.matchLater(requestId, this.config.retryDelayMs);
    return { kind: 'retry-later' };
  }

  async handleOfferResponse(data: OfferResponseJobData): Promise<void> {
    const pending = await this.repo.getOffer(data.offerId);
    // A device may only answer offers made to it.
    if (!pending || pending.agentId !== data.agentId) return;
    await this.settle(await this.repo.resolveOffer(data.offerId, data.response === 'ACK' ? 'ACKNOWLEDGED' : 'UNABLE'));
  }

  async handleOfferTimeout(data: OfferTimeoutJobData): Promise<void> {
    await this.settle(await this.repo.resolveOffer(data.offerId, 'TIMED_OUT'));
  }

  async handleCallCancelled(data: CallCancelledJobData): Promise<void> {
    const call = await this.repo.get(data.requestId);
    if (!call || call.state !== 'CANCELLED') return;

    const pending = await this.repo.pendingOffer(data.requestId);
    // The call is no longer OFFERED, so resolveOffer marks the offer CANCELLED whatever we pass.
    if (pending) await this.settle(await this.repo.resolveOffer(pending.id, 'TIMED_OUT'));

    if (call.assignedAgentId) {
      await this.fleet.publish({
        type: 'offer.withdrawn', offerId: null, agentId: call.assignedAgentId, requestId: call.id, reason: 'call cancelled',
      });
      await this.fleet.setStatus(call.assignedAgentId, 'AVAILABLE');
    }
  }

  async handleCrewStatus(data: CrewStatusJobData): Promise<void> {
    const call = await this.repo.get(data.requestId);
    // Reports about a call this unit no longer holds (cancelled, or reassigned after it went silent)
    // don't move the call. But "I'm free again" always counts, or the unit would be stuck forever.
    if (!call || call.assignedAgentId !== data.agentId || call.state === 'CANCELLED') {
      if (data.status === 'AVAILABLE') await this.fleet.setCrewStatus(data.agentId, 'AVAILABLE', data.ts);
      return;
    }

    // Jobs run in parallel, so reports can be processed out of order. Walk the call forward to the
    // reported step (AT_SCENE before EN_ROUTE applies both); a late, older report changes nothing.
    const target = CALL_PATH.findIndex((s) => s.reportedBy === data.status);
    let at = CALL_PATH.findIndex((s) => s.state === call.state);
    while (target !== -1 && at !== -1 && at < target) {
      const step = CALL_PATH[at + 1]!;
      const res = await this.repo.transition(call.id, step.state, {
        reason: step.reason, agentId: data.agentId, onlyFrom: [CALL_PATH[at]!.state],
      });
      if (!res.applied) break; // someone else moved it; their job will finish the walk
      at++;
      if (step.state === 'COMPLETED') this.metrics.callCompleted();
    }
    await this.fleet.setCrewStatus(data.agentId, data.status, data.ts);
  }

  /**
   * The unit driving to this call has gone silent (no GPS heartbeat). Send someone else.
   * Calls already ARRIVED are left alone: the crew is with the patient, not lost.
   */
  async reassignLostUnit(requestId: string, agentId: string): Promise<boolean> {
    const res = await this.repo.transition(requestId, 'MATCHING', {
      reason: `assigned unit ${agentId} went silent (no GPS heartbeat); reassigning`,
      agentId,
      onlyFrom: ['ASSIGNED', 'EN_ROUTE'],
    });
    if (!res.applied) return false;
    // OFFLINE until the unit itself reports AVAILABLE again; it is never offered calls meanwhile.
    await this.fleet.setStatus(agentId, 'OFFLINE');
    await this.fleet.publish({
      type: 'offer.withdrawn', offerId: null, agentId, requestId, reason: 'reassigned: lost contact with unit',
    });
    await this.scheduler.matchLater(requestId, 0);
    this.metrics.reassigned();
    return true;
  }

  /** Side effects after an offer is settled (exactly once, by whoever won the race). */
  private async settle(res: ResolveResult): Promise<void> {
    if (!res.resolved) return;
    const { offer } = res;

    switch (res.outcome) {
      case 'ACKNOWLEDGED': {
        await this.fleet.release(offer.agentId, offer.requestId);
        const call = await this.repo.get(offer.requestId);
        await this.fleet.publish({
          type: 'assigned', offerId: offer.id, agentId: offer.agentId, requestId: offer.requestId, location: call!.location,
        });
        this.metrics.acknowledged();
        return;
      }
      case 'UNABLE':
      case 'TIMED_OUT': {
        await this.fleet.unclaim(offer.agentId, offer.requestId);
        await this.fleet.publish({
          type: 'offer.withdrawn', offerId: offer.id, agentId: offer.agentId, requestId: offer.requestId,
          reason: res.outcome === 'UNABLE' ? 'crew unable' : 'no acknowledgement in time',
        });
        if (res.outcome === 'TIMED_OUT') this.metrics.timedOut();
        else this.metrics.unable();
        await this.scheduler.matchLater(offer.requestId, 0); // offer it to the next unit
        return;
      }
      case 'CANCELLED': {
        await this.fleet.unclaim(offer.agentId, offer.requestId);
        await this.fleet.publish({
          type: 'offer.withdrawn', offerId: offer.id, agentId: offer.agentId, requestId: offer.requestId, reason: 'call cancelled',
        });
        return;
      }
    }
  }

  private async expire(requestId: string, reason: string): Promise<MatchOutcome> {
    const res = await this.repo.transition(requestId, 'EXPIRED', { reason, onlyFrom: ['MATCHING'] });
    if (res.applied) this.metrics.expired();
    return { kind: 'expired', reason };
  }
}
