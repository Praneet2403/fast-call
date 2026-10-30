import type { AgentChannelMessage, Capability, LocationPing } from '@fast-call/shared';
import type { PingSink } from './fleet.js';

const MAX_BACKOFF_MS = 10_000;

/**
 * Streams pings to the ingest service over one WebSocket.
 * Pings are buffered during a tick and sent as a single batch frame on flush().
 * While disconnected, pings are dropped (and counted): a ping is only useful if it's fresh,
 * so replaying a backlog after reconnecting would just feed the dispatcher old positions.
 */
export class WebSocketSink implements PingSink {
  sent = 0;
  dropped = 0;
  private buffer: LocationPing[] = [];
  private ws: WebSocket | undefined;
  private backoffMs = 500;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly agents: { agentId: string; capability: Capability }[],
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
      this.write({ type: 'register', agents: this.agents });
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

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private write(msg: AgentChannelMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }
}
