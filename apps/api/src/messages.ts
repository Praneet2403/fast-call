import { z } from 'zod';
import type { AgentChannelMessage } from '@fast-call/shared';

// Loose geographic sanity check; the service-area check happens later, in dispatch.
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const agentId = z.string().regex(/^A-\d{4,6}$/);

const ping = z.object({
  type: z.literal('ping'),
  agentId,
  lat,
  lng,
  ts: z.number().int().positive(),
});

const register = z.object({
  type: z.literal('register'),
  agents: z.array(z.object({ agentId, capability: z.enum(['BLS', 'ALS']) })).max(50_000),
});

/** Batch-level shape only; each ping is validated on its own so one bad ping doesn't sink the batch. */
const pingBatch = z.object({
  type: z.literal('pings'),
  pings: z.array(z.unknown()).max(50_000),
});

const message = z.discriminatedUnion('type', [register, pingBatch]);

export type ParseResult =
  | { ok: true; message: AgentChannelMessage; rejectedPings: number }
  | { ok: false; error: string };

export function parseAgentMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }

  const parsed = message.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid message' };

  if (parsed.data.type === 'register') return { ok: true, message: parsed.data, rejectedPings: 0 };

  const pings = [];
  let rejectedPings = 0;
  for (const p of parsed.data.pings) {
    const result = ping.safeParse(p);
    if (result.success) pings.push(result.data);
    else rejectedPings++;
  }
  return { ok: true, message: { type: 'pings', pings }, rejectedPings };
}
