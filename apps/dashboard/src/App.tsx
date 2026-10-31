import { useCallback, useRef } from 'react';
import type { DisplayStatus, FleetSnapshotMessage, RequestState } from '@fast-call/shared';
import { FleetMap } from './FleetMap';
import type { FleetMapHandle } from './FleetMap';
import { STATUS_COLORS, STATUS_LABELS } from './statusColors';
import { useFleetSocket } from './useFleetSocket';

const LEGEND: DisplayStatus[] = ['AVAILABLE', 'DISPATCHED', 'EN_ROUTE', 'AT_SCENE', 'TRANSPORTING', 'AT_HOSPITAL', 'STALE'];

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function App() {
  const mapRef = useRef<FleetMapHandle>(null);
  const onSnapshot = useCallback((s: FleetSnapshotMessage) => mapRef.current?.setSnapshot(s), []);
  const { connection, snapshot, bytes } = useFleetSocket(onSnapshot);
  const stats = snapshot?.stats;
  const calls = snapshot?.callStats;
  const live = (...states: RequestState[]) => (calls ? states.reduce((n, st) => n + (calls.live[st] ?? 0), 0) : '—');

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
          <Stat
            label="Zones with no free unit"
            value={stats ? `${stats.uncoveredZones} / ${stats.totalZones}` : '—'}
            tone={stats && stats.uncoveredZones > stats.totalZones * 0.2 ? 'warn' : undefined}
          />
        </section>

        {calls && calls.needsAttention.length > 0 && (
          <section className="alert">
            <strong>{calls.needsAttention.length} on-scene call{calls.needsAttention.length > 1 ? 's' : ''} need a supervisor</strong>
            <span>The crew is on scene but their unit has gone silent. No second ambulance is sent automatically.</span>
          </section>
        )}

        <section>
          <h2>Calls</h2>
          <div className="cards">
            <Stat label="Waiting for a unit" value={live('CREATED', 'MATCHING')} tone={calls && live('CREATED', 'MATCHING') ? 'warn' : undefined} />
            <Stat label="Offered" value={live('OFFERED')} />
            <Stat label="Unit on the way" value={live('ASSIGNED', 'EN_ROUTE')} />
            <Stat label="On scene" value={live('ARRIVED')} />
            <Stat label="Completed (1 h)" value={calls?.completedLastHour ?? '—'} tone="good" />
            <Stat
              label="Expired / cancelled (1 h)"
              value={calls ? `${calls.expiredLastHour} / ${calls.cancelledLastHour}` : '—'}
              tone={calls?.expiredLastHour ? 'warn' : undefined}
            />
          </div>
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
            <li>
              <span className="dot dot-call" /> Call (bigger = more urgent)
            </li>
            <li>
              <span className="zone zone-gap" /> Zone with no free unit
            </li>
            <li>
              <span className="zone zone-thin" /> Zone down to its last unit
            </li>
            <li>
              <span className="link link-offered" /> Offered to unit
            </li>
            <li>
              <span className="link link-assigned" /> Unit assigned
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
