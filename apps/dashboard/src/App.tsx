import { useCallback, useRef } from 'react';
import type { DisplayStatus, FleetSnapshotMessage } from '@fast-call/shared';
import { FleetMap } from './FleetMap';
import type { FleetMapHandle } from './FleetMap';
import { STATUS_COLORS, STATUS_LABELS } from './statusColors';
import { useFleetSocket } from './useFleetSocket';

const LEGEND: DisplayStatus[] = ['AVAILABLE', 'DISPATCHED', 'EN_ROUTE', 'AT_SCENE', 'TRANSPORTING', 'AT_HOSPITAL', 'STALE'];

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function App() {
  const mapRef = useRef<FleetMapHandle>(null);
  const onSnapshot = useCallback((s: FleetSnapshotMessage) => mapRef.current?.setFleet(s.agents), []);
  const { connection, snapshot, bytes } = useFleetSocket(onSnapshot);
  const stats = snapshot?.stats;

  return (
    <div className="app">
      <aside className="panel">
        <header>
          <h1>Fast Call</h1>
          <p className="subtitle">Ambulance dispatch · Jaipur</p>
          <span className={`conn conn-${connection}`}>
            {connection === 'open' ? 'Live' : connection === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </span>
        </header>

        <section className="cards">
          <Stat label="Units" value={stats?.total ?? '—'} />
          <Stat label="Available" value={stats?.available ?? '—'} tone="good" />
          <Stat label="ALS / BLS" value={stats ? `${stats.als} / ${stats.bls}` : '—'} />
          <Stat label="Stale GPS" value={stats?.stale ?? '—'} tone={stats?.stale ? 'warn' : undefined} />
          <Stat label="Freshness p50" value={stats ? seconds(stats.freshnessP50Ms) : '—'} />
          <Stat label="Freshness p95" value={stats ? seconds(stats.freshnessP95Ms) : '—'} />
        </section>

        <section>
          <h2>Unit status</h2>
          <ul className="legend">
            {LEGEND.map((s) => (
              <li key={s}>
                <span className="dot" style={{ background: STATUS_COLORS[s] }} />
                {STATUS_LABELS[s]}
              </li>
            ))}
            <li>
              <span className="dot dot-als" /> Larger, ringed = ALS
            </li>
            <li>
              <span className="dot dot-hospital" /> Hospital
            </li>
          </ul>
        </section>

        <footer>
          {snapshot ? `Snapshot ${new Date(snapshot.ts).toLocaleTimeString()} · ${(bytes / 1024).toFixed(0)} KB` : 'Waiting for data'}
        </footer>
      </aside>
      <FleetMap ref={mapRef} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'good' | 'warn' }) {
  return (
    <div className={`card ${tone ? `card-${tone}` : ''}`}>
      <div className="card-value">{value}</div>
      <div className="card-label">{label}</div>
    </div>
  );
}
