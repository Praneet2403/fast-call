import type {
  AgentChannelMessage,
  AgentCommand,
  CrewStatusMessage,
  LocationPing,
  OfferResponseMessage,
  RegisterMessage,
} from '@fast-call/shared';
import type { PingSink } from './fleet.js';

const MAX_BACKOFF_MS = 10_000;

/**
 * The crews' connection to the ingest service: one WebSocket carrying every unit.
 *  - Pings are buffered during a tick and sent as one batch frame on flush(). While disconnected
 *    they are dropped (and counted): replaying stale positions would mislead the dispatcher.
 *  - Crew messages (offer answers, status reports) are the opposite: losing "I'm available again"
 *    would strand a unit, so they queue while disconnected and are sent on reconnect.
 *  - Commands from the dispatcher (offers, assignments) arrive on the same socket.
 */
export class WebSocketSink implements PingSink {
  sent = 0;
  dropped = 0;
  controlSent = 0;
  onCommand: ((cmd: AgentCommand) => void) | undefined;
  private buffer: LocationPing[] = [];
  private controlQueue: (OfferResponseMessage | CrewStatusMessage)[] = [];
  private ws: WebSocket | undefined;
  private backoffMs = 500;
  private closed = false;

  constructor(
    private readonly url: string,
    /** Read at (re)connect time so the server learns each unit's current status. */
    private readonly roster: () => RegisterMessage['agents'],
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      console.log(`[sim] connected to ${this.url}`);
      this.backoffMs = 500;
      // Re-register on every (re)connect: the server may have restarted with empty state.
      this.write({ type: 'register', agents: this.roster() });
      for (const msg of this.controlQueue.splice(0)) this.sendControl(msg);
    });
    ws.addEventListener('message', (event) => {
      try {
        this.onCommand?.(JSON.parse(String(event.data)) as AgentCommand);
      } catch (err) {
        console.warn(`[sim] bad command from server: ${(err as Error).message}`);
      }
    });
    ws.addEventListener('close', () => {
      if (this.closed) return;
      console.log(`[sim] disconnected, retrying in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    });
    ws.addEventListener('error', () => {
      // 'close' always follows 'error'; reconnect is handled there.
    });
  }

  send(ping: LocationPing): void {
    this.buffer.push(ping);
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    if (this.connected) {
      this.write({ type: 'pings', pings: this.buffer });
      this.sent += this.buffer.length;
    } else {
      this.dropped += this.buffer.length;
    }
    this.buffer = [];
  }

  sendControl(msg: OfferResponseMessage | CrewStatusMessage): void {
    if (!this.connected) {
      this.controlQueue.push(msg);
      return;
    }
    this.write(msg);
    this.controlSent++;
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private write(msg: AgentChannelMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }
}
