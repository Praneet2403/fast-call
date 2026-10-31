import type { Redis } from 'ioredis';
import { AGENT_COMMANDS_CHANNEL, REDIS_KEYS } from '@fast-call/shared';
import type { AgentCommand, AgentStatus, Capability, GeoPoint } from '@fast-call/shared';

export interface Candidate {
  agentId: string;
  /** Straight-line distance; Day 6 replaces "nearest" with a road-ETA based score. */
  distanceKm: number;
  capability: Capability;
}

/**
 * Atomically claim a unit for one call. In a single Redis step it checks the unit is alive
 * (heartbeat key exists) and AVAILABLE, takes the lock (SET NX), and marks it DISPATCHED.
 * Two dispatcher workers racing for the same unit: exactly one gets 1, the other gets 0.
 */
const CLAIM_LUA = `
if redis.call('EXISTS', KEYS[3]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], ARGV[1]) ~= 'AVAILABLE' then return 0 end
if not redis.call('SET', KEYS[2], ARGV[2], 'NX', 'PX', ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'DISPATCHED')
return 1
`;

/** Undo a claim (offer refused / timed out / call cancelled), but only if we still own it. */
const UNCLAIM_LUA = `
local holder = redis.call('GET', KEYS[2])
if holder and holder ~= ARGV[2] then return 0 end
if redis.call('HGET', KEYS[1], ARGV[1]) == 'DISPATCHED' then redis.call('HSET', KEYS[1], ARGV[1], 'AVAILABLE') end
if holder then redis.call('DEL', KEYS[2]) end
return 1
`;

/** Compare-and-delete: release the lock only if it still holds our request id. */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/** Apply a crew status only if it's newer than the last one we applied (reports can arrive out of order). */
const STATUS_IF_NEWER_LUA = `
local last = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
if tonumber(ARGV[3]) <= last then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
`;

/** Become (or stay) leader: refresh the TTL if we hold the key, take it if nobody does. */
const LEAD_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`;

/** Free a unit stuck in DISPATCHED, unless something claimed it (took the lock) in the meantime. */
const FREE_ORPHAN_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('HGET', KEYS[1], ARGV[1]) ~= 'DISPATCHED' then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'AVAILABLE')
return 1
`;

type FleetRedis = Redis & {
  tryLead(key: string, instanceId: string, ttlMs: number): Promise<number>;
  freeOrphan(statusKey: string, lockKey: string, agentId: string): Promise<number>;
  statusIfNewer(statusKey: string, tsKey: string, agentId: string, status: string, ts: number): Promise<number>;
  claimUnit(statusKey: string, lockKey: string, hbKey: string, agentId: string, requestId: string, ttlMs: number): Promise<number>;
  unclaimUnit(statusKey: string, lockKey: string, agentId: string, requestId: string): Promise<number>;
  releaseLock(lockKey: string, requestId: string): Promise<number>;
};

export class FleetOps {
  private readonly redis: FleetRedis;

  constructor(
    redis: Redis,
    /**
     * Demo only: claim with a plain read-then-write instead of the atomic script.
     * Exists so the concurrency test can show the double-dispatch bug the lock prevents.
     */
    private readonly unsafeClaim = false,
  ) {
    this.redis = redis as FleetRedis;
    this.redis.defineCommand('claimUnit', { numberOfKeys: 3, lua: CLAIM_LUA });
    this.redis.defineCommand('unclaimUnit', { numberOfKeys: 2, lua: UNCLAIM_LUA });
    this.redis.defineCommand('releaseLock', { numberOfKeys: 1, lua: RELEASE_LUA });
    this.redis.defineCommand('statusIfNewer', { numberOfKeys: 2, lua: STATUS_IF_NEWER_LUA });
    this.redis.defineCommand('tryLead', { numberOfKeys: 1, lua: LEAD_LUA });
    this.redis.defineCommand('freeOrphan', { numberOfKeys: 2, lua: FREE_ORPHAN_LUA });
  }

  /**
   * Free, alive units that can do the job, nearest first.
   * GEOSEARCH can only limit by distance, not by status, so under load the nearest K units may
   * all be busy. If a full page comes back with nobody usable, widen the page (×4) and search the
   * same ring again, so a free unit just past the first K is never missed.
   */
  async nearbyAvailable(
    at: GeoPoint,
    radiusKm: number,
    count: number,
    required: Capability,
    exclude: ReadonlySet<string>,
  ): Promise<Candidate[]> {
    for (let page = count; ; page *= 4) {
      const hits = (await this.redis.geosearch(
        REDIS_KEYS.geo, 'FROMLONLAT', at.lng, at.lat, 'BYRADIUS', radiusKm, 'km', 'ASC', 'COUNT', page, 'WITHDIST',
      )) as [string, string][];
      const usable = await this.filterUsable(hits, required, exclude);
      if (usable.length > 0 || hits.length < page) return usable; // found someone, or the ring is exhausted
    }
  }

  private async filterUsable(
    hits: [string, string][],
    required: Capability,
    exclude: ReadonlySet<string>,
  ): Promise<Candidate[]> {
    const ids = hits.map(([id]) => id).filter((id) => !exclude.has(id));
    if (ids.length === 0) return [];

    const pipe = this.redis.pipeline();
    pipe.hmget(REDIS_KEYS.status, ...ids);
    pipe.hmget(REDIS_KEYS.capability, ...ids);
    for (const id of ids) pipe.exists(REDIS_KEYS.heartbeat(id));
    const res = (await pipe.exec())!;
    const statuses = res[0]![1] as (string | null)[];
    const caps = res[1]![1] as (Capability | null)[];
    const distance = new Map(hits.map(([id, d]) => [id, Number(d)]));

    return ids
      .map((agentId, i) => ({ agentId, i, distanceKm: distance.get(agentId)!, capability: caps[i] ?? 'BLS' }))
      .filter(({ i, capability }) =>
        statuses[i] === 'AVAILABLE' &&
        res[2 + i]![1] === 1 && // heartbeat alive
        (required === 'BLS' || capability === 'ALS'), // an ALS call needs an ALS unit; anyone can do BLS
      )
      .map(({ agentId, distanceKm, capability }) => ({ agentId, distanceKm, capability }));
  }

  async claim(agentId: string, requestId: string, ttlMs: number): Promise<boolean> {
    if (this.unsafeClaim) {
      // ❌ The bug: between this read and the write below, another worker can read AVAILABLE too.
      const status = await this.redis.hget(REDIS_KEYS.status, agentId);
      if (status !== 'AVAILABLE') return false;
      await this.redis.hset(REDIS_KEYS.status, agentId, 'DISPATCHED');
      return true;
    }
    const ok = await this.redis.claimUnit(
      REDIS_KEYS.status, REDIS_KEYS.lock(agentId), REDIS_KEYS.heartbeat(agentId), agentId, requestId, ttlMs,
    );
    return ok === 1;
  }

  async unclaim(agentId: string, requestId: string): Promise<void> {
    await this.redis.unclaimUnit(REDIS_KEYS.status, REDIS_KEYS.lock(agentId), agentId, requestId);
  }

  /** After an ACK: the unit stays non-AVAILABLE through its status, so the offer lock can go. */
  async release(agentId: string, requestId: string): Promise<void> {
    await this.redis.releaseLock(REDIS_KEYS.lock(agentId), requestId);
  }

  async setStatus(agentId: string, status: AgentStatus): Promise<void> {
    await this.redis.hset(REDIS_KEYS.status, agentId, status);
  }

  /** Returns false if a newer report for this unit was already applied. */
  async setCrewStatus(agentId: string, status: AgentStatus, ts: number): Promise<boolean> {
    return (await this.redis.statusIfNewer(REDIS_KEYS.status, REDIS_KEYS.statusTs, agentId, status, ts)) === 1;
  }

  // ---- used by the sweeper ----

  /** Only one dispatcher instance should sweep; the key's TTL hands over leadership if it dies. */
  async tryLead(instanceId: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.tryLead('dispatcher:sweeper-leader', instanceId, ttlMs)) === 1;
  }

  /** Which of these units still have a live GPS heartbeat. */
  async alive(agentIds: string[]): Promise<Set<string>> {
    if (agentIds.length === 0) return new Set();
    const pipe = this.redis.pipeline();
    for (const id of agentIds) pipe.exists(REDIS_KEYS.heartbeat(id));
    const res = (await pipe.exec())!;
    return new Set(agentIds.filter((_, i) => res[i]![1] === 1));
  }

  /** Units marked DISPATCHED that no longer hold an offer lock: candidates for being orphaned. */
  async dispatchedWithoutLock(): Promise<string[]> {
    const all = await this.redis.hgetall(REDIS_KEYS.status);
    const dispatched = Object.keys(all).filter((id) => all[id] === 'DISPATCHED');
    if (dispatched.length === 0) return [];
    const pipe = this.redis.pipeline();
    for (const id of dispatched) pipe.exists(REDIS_KEYS.lock(id));
    const res = (await pipe.exec())!;
    return dispatched.filter((_, i) => res[i]![1] === 0);
  }

  async freeOrphan(agentId: string): Promise<boolean> {
    return (await this.redis.freeOrphan(REDIS_KEYS.status, REDIS_KEYS.lock(agentId), agentId)) === 1;
  }

  async publish(command: AgentCommand): Promise<void> {
    await this.redis.publish(AGENT_COMMANDS_CHANNEL, JSON.stringify(command));
  }
}
