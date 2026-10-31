import { useEffect, useRef, useState } from 'react';
import type { DashboardMessage, FleetSnapshotMessage } from '@fast-call/shared';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * Subscribes to the dashboard channel and reconnects with backoff.
 * The full snapshot is handed to `onSnapshot` (the map updates imperatively),
 * while only the small stats object goes into React state. Re-rendering React for
 * 10k map points every second would be wasted work.
 */
export function useFleetSocket(onSnapshot: (s: FleetSnapshotMessage) => void) {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [snapshot, setSnapshot] = useState<Pick<FleetSnapshotMessage, 'stats' | 'ts' | 'callStats'> | null>(null);
  const [bytes, setBytes] = useState(0);
  const handler = useRef(onSnapshot);
  handler.current = onSnapshot;

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let backoff = 500;
    let disposed = false;

    const connect = () => {
      setConnection('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/dashboard`);
      ws.onopen = () => {
        backoff = 500;
        setConnection('open');
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as DashboardMessage;
        if (msg.type !== 'fleet.snapshot') return;
        handler.current(msg);
        setSnapshot({ stats: msg.stats, ts: msg.ts, callStats: msg.callStats });
        setBytes((e.data as string).length);
      };
      ws.onclose = () => {
        if (disposed) return;
        setConnection('closed');
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 10_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { connection, snapshot, bytes };
}
