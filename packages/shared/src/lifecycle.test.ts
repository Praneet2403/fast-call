import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isTerminal,
  REQUEST_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
} from './lifecycle.js';
import type { RequestState } from './types.js';

describe('request lifecycle', () => {
  it('has exactly three terminal states', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['CANCELLED', 'COMPLETED', 'EXPIRED']);
  });

  it('follows the happy path from CREATED to COMPLETED', () => {
    const path: RequestState[] = ['CREATED', 'MATCHING', 'OFFERED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'COMPLETED'];
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });

  it('goes back to MATCHING on decline, timeout or a stale unit, but never from CREATED', () => {
    for (const from of ['OFFERED', 'ASSIGNED', 'EN_ROUTE'] as const) expect(canTransition(from, 'MATCHING')).toBe(true);
    expect(canTransition('CREATED', 'OFFERED')).toBe(false);
  });

  it('lets every non-terminal state except ARRIVED be cancelled', () => {
    for (const s of REQUEST_STATES) {
      expect(canTransition(s, 'CANCELLED'), s).toBe(!isTerminal(s) && s !== 'ARRIVED');
    }
  });

  it('only expires while searching for a unit', () => {
    expect(REQUEST_STATES.filter((s) => canTransition(s, 'EXPIRED'))).toEqual(['MATCHING']);
  });

  it('rejects every move out of a terminal state', () => {
    for (const from of TERMINAL_STATES) {
      for (const to of REQUEST_STATES) expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
    }
  });

  it('rejects every pair not in the table (exhaustive 9×9 check)', () => {
    let legal = 0;
    for (const from of REQUEST_STATES) {
      for (const to of REQUEST_STATES) {
        const allowed = TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(allowed);
        if (allowed) legal++;
        else expect(() => assertTransition(from, to)).toThrow(`illegal transition ${from} → ${to}`);
      }
    }
    expect(legal).toBe(15); // 2 + 3 + 3 + 3 + 3 + 1: a guard against silent edits to the table
  });

  it('never allows a state to transition to itself', () => {
    for (const s of REQUEST_STATES) expect(canTransition(s, s)).toBe(false);
  });
});
