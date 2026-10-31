import { beforeAll, describe, expect, it } from 'vitest';
import { haversineMeters, HOSPITALS } from '@fast-call/shared';
import type { OfferCommand } from '@fast-call/shared';
import { RoadGraph } from '@fast-call/roads';
import { SimAgent } from './agent.js';
import type { CrewContext } from './agent.js';
import { createRng } from './rng.js';
import type { Rng } from './rng.js';

let graph: RoadGraph;
beforeAll(() => {
  graph = RoadGraph.load();
});

/** A crew "random" stream that always answers ACK and picks the shortest delays. */
const steadyCrew: Rng = { next: () => 0.5, range: (min) => min, int: (min) => min, chance: () => false };

function crewOn(startNode: number, crewRng: Rng = steadyCrew) {
  const ctx: CrewContext = { hospitalNodes: HOSPITALS.map((h) => graph.nearestNode(h.location)), crewRng };
  return new SimAgent('A-0001', 'ALS', startNode, createRng(1), graph, ctx);
}

const offerFor = (agent: SimAgent, sceneNode: number): OfferCommand => ({
  type: 'offer',
  offerId: '11111111-1111-4111-8111-111111111111',
  agentId: agent.id,
  requestId: '22222222-2222-4222-8222-222222222222',
  location: graph.point(sceneNode),
  priority: 'P1',
  requiredCapability: 'ALS',
  expiresAt: 0,
});

describe('crew working a call', () => {
  it('acks, drives to the scene, treats, transports to the nearest hospital, and is free again', () => {
    const start = graph.nearestNode({ lat: 26.9124, lng: 75.7873 });
    const scene = graph.nearestNode({ lat: 26.9, lng: 75.8 });
    const agent = crewOn(start);
    const offer = offerFor(agent, scene);
    let now = 1_000_000;

    agent.receiveOffer(offer, now);
    expect(agent.status).toBe('DISPATCHED');
    const sent: string[] = [];
    // Run up to 2 simulated hours, one second at a time, recording what the crew reports.
    for (let i = 0; i < 7200 && sent.at(-1) !== 'status:AVAILABLE'; i++) {
      now += 1000;
      agent.step(1000, now);
      for (const m of agent.outbox) sent.push(m.type === 'status' ? `status:${m.status}` : `answer:${m.response}`);
      if (agent.outbox.some((m) => m.type === 'offer.response')) {
        agent.receiveAssigned({ type: 'assigned', offerId: offer.offerId, agentId: agent.id, requestId: offer.requestId, location: offer.location }, now);
        for (const m of agent.outbox.splice(1)) sent.push(m.type === 'status' ? `status:${m.status}` : '');
      }
      agent.outbox = [];
      if (agent.phase === 'ON_SCENE') expect(haversineMeters(agent.position, graph.point(scene))).toBeLessThan(1);
    }

    expect(sent).toEqual([
      'answer:ACK',
      'status:EN_ROUTE',
      'status:AT_SCENE',
      'status:TRANSPORTING',
      'status:AT_HOSPITAL',
      'status:AVAILABLE',
    ]);
    expect(agent.status).toBe('AVAILABLE');
    expect(agent.mission).toBeNull();
  });

  it('ignores a second offer while one is pending, and stands down when the offer is withdrawn', () => {
    const agent = crewOn(graph.nearestNode({ lat: 26.9124, lng: 75.7873 }));
    const offer = offerFor(agent, 100);
    agent.receiveOffer(offer, 0);
    agent.receiveOffer({ ...offer, offerId: '33333333-3333-4333-8333-333333333333' }, 0);
    expect(agent.pendingOffer?.offerId).toBe(offer.offerId);
    agent.receiveWithdrawn({ type: 'offer.withdrawn', offerId: offer.offerId, agentId: agent.id, requestId: offer.requestId, reason: 'timeout' }, 0);
    expect(agent.status).toBe('AVAILABLE');
  });
});
