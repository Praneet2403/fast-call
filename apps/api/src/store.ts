import { Redis } from 'ioredis';
import { REDIS_KEYS } from '@fast-call/shared';
import type { AgentStatus, Capability, LocationPing } from '@fast-call/shared';

export const KEYS = REDIS_KEYS;

/**
 * Applies one ping atomically, and only if it's newer than the last one we accepted.
 * Doing the "is it newer?" check inside Lua avoids a read-then-write race between
 * two ingest workers handling pings for the same unit.
 */
const APPLY_PING_LUA = `
local last = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if tonumber(ARGV[4]) <= last then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
redis.call('GEOADD', KEYS[2], ARGV[2], ARGV[3], ARGV[1])
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5])
return 1
`;

type FleetRedis = Redis & {
  applyPing(
    lastSeenKey: string,
    geoKey: string,
    hbKey: string,
    agentId: string,
    lng: number,
    lat: number,
    ts: number,
    ttlSec: number,
  ): Promise<number>;
};

export interface RawFleet {
  positions: [agentId: string, lng: number, lat: number][];
  lastSeen: Record<string, string>;
  status: Record<string, string>;
  capability: Record<string, string>;
}

export class FleetStore {
  readonly redis: FleetRedis;

  constructor(redisUrl: string, private readonly heartbeatTtlSec: number) {
    const redis = new Redis(redisUrl, { lazyConnect: true }) as FleetRedis;
    redis.defineCommand('applyPing', { numberOfKeys: 3, lua: APPLY_PING_LUA });
    this.redis = redis;
  }

  connect(): Promise<void> {
    return this.redis.connect();
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * Records each unit's capability. The device's own status wins when it sends one (it knows if
   * it is mid-call); otherwise a brand-new unit starts AVAILABLE (HSETNX keeps any existing status).
   */
  async register(agents: { agentId: string; capability: Capability; status?: AgentStatus }[]): Promise<void> {
    const pipe = this.redis.pipeline();
    for (const { agentId, capability, status } of agents) {
      pipe.hset(KEYS.capability, agentId, capability);
      if (status) pipe.hset(KEYS.status, agentId, status);
      else pipe.hsetnx(KEYS.status, agentId, 'AVAILABLE' satisfies AgentStatus);
    }
    await pipe.exec();
  }

  /** Applies a batch in one round trip. Returns how many pings were accepted (the rest were out of order). */
  async applyPings(pings: LocationPing[]): Promise<number> {
    if (pings.length === 0) return 0;
    const pipe = this.redis.pipeline() as ReturnType<Redis['pipeline']> & {
      applyPing: (...args: Parameters<FleetRedis['applyPing']>) => unknown;
    };
    for (const p of pings) {
      pipe.applyPing(KEYS.lastSeen, KEYS.geo, KEYS.heartbeat(p.agentId), p.agentId, p.lng, p.lat, p.ts, this.heartbeatTtlSec);
    }
    const results = (await pipe.exec()) ?? [];
    let accepted = 0;
    for (const [err, value] of results) {
      if (err) throw err;
      if (value === 1) accepted++;
    }
    return accepted;
  }

  /** Reads the whole live fleet in one pipeline (4 commands). */
  async readFleet(): Promise<RawFleet> {
    const results = await this.redis
      .pipeline()
      .zrange(KEYS.geo, 0, '-1')
      .hgetall(KEYS.lastSeen)
      .hgetall(KEYS.status)
      .hgetall(KEYS.capability)
      .exec();
    if (!results) throw new Error('readFleet: pipeline returned nothing');
    for (const [err] of results) if (err) throw err;

    const ids = results[0]![1] as string[];
    const coords = ids.length ? await this.redis.geopos(KEYS.geo, ...ids) : [];
    const positions: RawFleet['positions'] = [];
    ids.forEach((id, i) => {
      const c = coords[i];
      if (c) positions.push([id, Number(c[0]), Number(c[1])]);
    });

    return {
      positions,
      lastSeen: results[1]![1] as Record<string, string>,
      status: results[2]![1] as Record<string, string>,
      capability: results[3]![1] as Record<string, string>,
    };
  }
}
