import type { RequestState } from './types.js';

/**
 * The only legal moves for a dispatch request. Anything not listed here is rejected.
 *
 *   CREATED → MATCHING → OFFERED → ASSIGNED → EN_ROUTE → ARRIVED → COMPLETED
 *                ↑          │          │          │
 *                └──────────┴──────────┴──────────┘  decline / ack timeout / unit went stale
 *
 * Any non-terminal state except ARRIVED can be CANCELLED (once the crew is on scene,
 * the call is closed with COMPLETED instead). MATCHING → EXPIRED when no unit can be found.
 */
export const TRANSITIONS: Readonly<Record<RequestState, readonly RequestState[]>> = {
  CREATED: ['MATCHING', 'CANCELLED'],
  MATCHING: ['OFFERED', 'EXPIRED', 'CANCELLED'],
  OFFERED: ['ASSIGNED', 'MATCHING', 'CANCELLED'],
  ASSIGNED: ['EN_ROUTE', 'MATCHING', 'CANCELLED'],
  EN_ROUTE: ['ARRIVED', 'MATCHING', 'CANCELLED'],
  ARRIVED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const REQUEST_STATES = Object.keys(TRANSITIONS) as RequestState[];

export const TERMINAL_STATES: readonly RequestState[] = REQUEST_STATES.filter((s) => TRANSITIONS[s].length === 0);

export function isTerminal(state: RequestState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function canTransition(from: RequestState, to: RequestState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RequestState,
    readonly to: RequestState,
  ) {
    super(`illegal transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: RequestState, to: RequestState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
