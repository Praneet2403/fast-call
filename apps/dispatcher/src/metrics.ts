/** In-process counters plus a rolling window of dispatch decision latencies. */
export class Metrics {
  offers = 0;
  acks = 0;
  timeouts = 0;
  unables = 0;
  expiries = 0;
  completed = 0;
  noUnitRetries = 0;
  private latencies: number[] = [];
  private readonly ringHits = new Map<number, number>();

  /** Time from picking up the job to the offer being published. */
  offerMade(ms: number, radiusKm: number): void {
    this.offers++;
    this.latencies.push(ms);
    if (this.latencies.length > 10_000) this.latencies.splice(0, 5_000);
    this.ringHits.set(radiusKm, (this.ringHits.get(radiusKm) ?? 0) + 1);
  }
  acknowledged(): void {
    this.acks++;
  }
  timedOut(): void {
    this.timeouts++;
  }
  unable(): void {
    this.unables++;
  }
  expired(): void {
    this.expiries++;
  }
  callCompleted(): void {
    this.completed++;
  }
  noUnitFree(): void {
    this.noUnitRetries++;
  }

  /** Nearest-rank percentiles of decision latency (ms). */
  latency(): { p50: number; p95: number; p99: number; n: number } {
    const xs = [...this.latencies].sort((a, b) => a - b);
    const at = (p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]! : 0);
    return { p50: at(50), p95: at(95), p99: at(99), n: xs.length };
  }

  summary(): string {
    const l = this.latency();
    const rings = [...this.ringHits].map(([km, n]) => `${km}km:${n}`).join(' ');
    return (
      `offers=${this.offers} acks=${this.acks} timeouts=${this.timeouts} unable=${this.unables} ` +
      `expired=${this.expiries} completed=${this.completed} noUnitRetries=${this.noUnitRetries} ` +
      `decision p50=${l.p50.toFixed(1)}ms p95=${l.p95.toFixed(1)}ms p99=${l.p99.toFixed(1)}ms (n=${l.n}) rings[${rings}]`
    );
  }
}
