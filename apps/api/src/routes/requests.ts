import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { IllegalTransitionError, isWithin, JAIPUR_BOUNDS } from '@fast-call/shared';
import type { RequestRepo } from '@fast-call/db';
import type { DispatchQueue } from '../queue.js';

const createBody = z.object({
  lat: z.number(),
  lng: z.number(),
  priority: z.enum(['P1', 'P2', 'P3']),
  requiredCapability: z.enum(['BLS', 'ALS']),
});

const cancelBody = z.object({ reason: z.string().min(1).max(200).optional() }).optional();

/** Opaque client token: 8–128 chars, URL-safe. */
const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

const requestId = z.uuid();

export function registerRequestRoutes(app: FastifyInstance, deps: { requests: RequestRepo; queue: DispatchQueue }) {
  const { requests, queue } = deps;

  /**
   * POST /requests: a new emergency call.
   * 201 created · 200 replay of an earlier identical call · 400 bad input
   * 422 key reused with a different body (per the IETF Idempotency-Key draft) or outside the service area
   */
  app.post('/requests', async (req, reply) => {
    const key = idempotencyKey.safeParse(req.headers['idempotency-key']);
    if (!key.success) return reply.code(400).send({ error: 'Idempotency-Key header is required (8-128 URL-safe chars)' });

    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });

    const { lat, lng, priority, requiredCapability } = body.data;
    if (!isWithin(JAIPUR_BOUNDS, { lat, lng })) {
      return reply.code(422).send({ error: 'location is outside the Jaipur service area' });
    }

    const result = await requests.create({ idempotencyKey: key.data, location: { lat, lng }, priority, requiredCapability });

    if (result.kind === 'conflict') {
      return reply.code(422).send({ error: 'Idempotency-Key was already used with a different request body' });
    }
    // Enqueue on the first create, and again on a replay while the call is still CREATED: if we
    // crashed between the DB commit and the enqueue, the client's retry heals it. The job id
    // dedupes, so a healthy request is never matched twice.
    if (result.kind === 'created' || result.request.state === 'CREATED') await queue.enqueueMatch(result.request.id);

    reply.header('location', `/requests/${result.request.id}`);
    if (result.kind === 'existing') reply.header('idempotent-replayed', 'true');
    return reply.code(result.kind === 'created' ? 201 : 200).send(result.request);
  });

  app.get('/requests/:id', async (req, reply) => {
    const id = requestId.safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: 'id must be a UUID' });
    const request = await requests.get(id.data);
    if (!request) return reply.code(404).send({ error: 'request not found' });
    return { request, events: await requests.events(id.data) };
  });

  /** POST /requests/:id/cancel · 200 cancelled · 404 unknown · 409 already finished or crew on scene */
  app.post('/requests/:id/cancel', async (req, reply) => {
    const id = requestId.safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: 'id must be a UUID' });
    const body = cancelBody.safeParse(req.body ?? undefined);
    if (!body.success) return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });

    const existing = await requests.get(id.data);
    if (!existing) return reply.code(404).send({ error: 'request not found' });
    try {
      await requests.transition(id.data, 'CANCELLED', { reason: body.data?.reason ?? 'cancelled by caller' });
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return reply.code(409).send({ error: `cannot cancel a request in state ${err.from}`, state: err.from });
      }
      throw err;
    }
    return requests.get(id.data);
  });
}
