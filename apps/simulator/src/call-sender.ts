import type { CallSpec } from './calls.js';

const MAX_ATTEMPTS = 3;

/**
 * Sends generated calls to POST /requests. Each call gets one Idempotency-Key that is reused
 * on every retry, so a timeout or dropped connection can never create the same emergency twice.
 */
export class CallSender {
  created = 0;
  replayed = 0;
  failed = 0;
  private seq = 0;

  constructor(
    private readonly apiUrl: string,
    /** Unique per simulator run, so keys from a previous run are never reused. */
    private readonly runId: string,
  ) {}

  send(call: CallSpec): void {
    const key = `sim-${this.runId}-${++this.seq}`;
    void this.post(call, key, 1);
  }

  private async post(call: CallSpec, key: string, attempt: number): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          lat: call.location.lat,
          lng: call.location.lng,
          priority: call.priority,
          requiredCapability: call.requiredCapability,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 201) this.created++;
      else if (res.status === 200) this.replayed++;
      else if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      else {
        this.failed++; // 4xx: retrying the same body won't help
        console.warn(`[sim] call rejected (${res.status}): ${await res.text()}`);
      }
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        setTimeout(() => void this.post(call, key, attempt + 1), 250 * 2 ** attempt);
      } else {
        this.failed++;
        console.warn(`[sim] call ${key} failed after ${attempt} attempts: ${(err as Error).message}`);
      }
    }
  }
}
