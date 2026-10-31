import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl } from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { FeatureCollection, LineString, Point, Polygon } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { HOSPITALS, JAIPUR_BOUNDS, zoneBoundary } from '@fast-call/shared';
import type { CallRow, FleetRow, FleetSnapshotMessage, ZoneRow } from '@fast-call/shared';
import { CALL_STATE_COLORS, STATUS_COLORS } from './statusColors';

export interface FleetMapHandle {
  setSnapshot(snapshot: FleetSnapshotMessage): void;
}

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

// MapLibre decodes tiles and GeoJSON in a Web Worker loaded from a separate file. Vite's
// dependency pre-bundling moves maplibre-gl but not that file, so the worker 404s and the map
// stays blank. Bundling the worker as its own entry (?worker&url) fixes dev and production.
setWorkerUrl(maplibreWorkerUrl);

const statusColor = [
  'match',
  ['get', 'status'],
  ...Object.entries(STATUS_COLORS).flat(),
  '#000000',
] as unknown as ExpressionSpecification;

function toGeoJSON(rows: FleetRow[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: rows.map(([id, lng, lat, status, capability]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] }, // GeoJSON is [lng, lat]
      properties: { id, status, capability },
    })),
  };
}

const callColor = [
  'match',
  ['get', 'state'],
  ...Object.entries(CALL_STATE_COLORS).flat(),
  '#000000',
] as unknown as ExpressionSpecification;

function callsGeoJSON(calls: CallRow[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: calls.map(([id, lng, lat, state, priority, agentId, createdAt]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { id, state, priority, agentId, createdAt },
    })),
  };
}

/** A line from each call to the unit offered or assigned to it: dashed while still only offered. */
function linksGeoJSON(calls: CallRow[], agents: FleetRow[]): FeatureCollection<LineString> {
  const positions = new Map(agents.map(([id, lng, lat]) => [id, [lng, lat]]));
  return {
    type: 'FeatureCollection',
    features: calls.flatMap(([id, lng, lat, state, , agentId]) => {
      const unit = agentId ? positions.get(agentId) : undefined;
      if (!unit) return [];
      return [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [unit, [lng, lat]] }, properties: { id, state } }];
    }) as FeatureCollection<LineString>['features'],
  };
}

/** Zone outlines never change, so compute each hexagon's polygon once. */
const boundaryCache = new Map<string, [number, number][]>();
function zonesGeoJSON(zones: ZoneRow[]): FeatureCollection<Polygon> {
  return {
    type: 'FeatureCollection',
    features: zones.map(([cell, available, units]) => {
      let ring = boundaryCache.get(cell);
      if (!ring) boundaryCache.set(cell, (ring = zoneBoundary(cell)));
      return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { cell, available, units } };
    }),
  };
}

const hospitalsGeoJSON: FeatureCollection<Point> = {
  type: 'FeatureCollection',
  features: HOSPITALS.map((h) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [h.location.lng, h.location.lat] },
    properties: { name: h.name },
  })),
};

export const FleetMap = forwardRef<FleetMapHandle>(function FleetMap(_, ref) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const pending = useRef<FleetSnapshotMessage | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  const apply = (m: MapLibreMap, snap: FleetSnapshotMessage) => {
    m.getSource<GeoJSONSource>('zones')?.setData(zonesGeoJSON(snap.zones));
    m.getSource<GeoJSONSource>('agents')?.setData(toGeoJSON(snap.agents));
    m.getSource<GeoJSONSource>('calls')?.setData(callsGeoJSON(snap.calls));
    m.getSource<GeoJSONSource>('links')?.setData(linksGeoJSON(snap.calls, snap.agents));
  };

  useImperativeHandle(ref, () => ({
    setSnapshot(snap) {
      const m = map.current;
      if (m?.getSource('agents')) apply(m, snap);
      else pending.current = snap; // style not loaded yet; apply on load
    },
  }));

  useEffect(() => {
    let m: MapLibreMap;
    try {
      m = new MapLibreMap({
        container: container.current!,
        style: STYLE_URL,
        bounds: [
          [JAIPUR_BOUNDS.minLng, JAIPUR_BOUNDS.minLat],
          [JAIPUR_BOUNDS.maxLng, JAIPUR_BOUNDS.maxLat],
        ],
        fitBoundsOptions: { padding: 24 },
        maxBounds: [
          [JAIPUR_BOUNDS.minLng - 0.15, JAIPUR_BOUNDS.minLat - 0.15],
          [JAIPUR_BOUNDS.maxLng + 0.15, JAIPUR_BOUNDS.maxLat + 0.15],
        ],
      });
    } catch (err) {
      // No WebGL (old GPU, some VMs, headless browsers): keep the rest of the dashboard alive.
      setMapError(err instanceof Error ? err.message : String(err));
      return;
    }
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __fastCallMap?: MapLibreMap }).__fastCallMap = m; // for e2e checks
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');

    m.on('load', () => {
      m.addSource('service-area', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [JAIPUR_BOUNDS.minLng, JAIPUR_BOUNDS.minLat],
                [JAIPUR_BOUNDS.maxLng, JAIPUR_BOUNDS.minLat],
                [JAIPUR_BOUNDS.maxLng, JAIPUR_BOUNDS.maxLat],
                [JAIPUR_BOUNDS.minLng, JAIPUR_BOUNDS.maxLat],
                [JAIPUR_BOUNDS.minLng, JAIPUR_BOUNDS.minLat],
              ],
            ],
          },
        },
      });
      m.addLayer({
        id: 'service-area',
        type: 'line',
        source: 'service-area',
        paint: { 'line-color': '#0f172a', 'line-width': 1, 'line-dasharray': [3, 3], 'line-opacity': 0.4 },
      });

      // Coverage: red = no free unit in this ~5 km² zone, amber = down to the last one.
      m.addSource('zones', { type: 'geojson', data: zonesGeoJSON([]) });
      m.addLayer({
        id: 'zones-fill',
        type: 'fill',
        source: 'zones',
        paint: {
          'fill-color': ['step', ['get', 'available'], '#dc2626', 1, '#f59e0b', 2, '#16a34a'],
          'fill-opacity': ['step', ['get', 'available'], 0.22, 1, 0.12, 2, 0],
        },
      });
      m.addLayer({
        id: 'zones-line',
        type: 'line',
        source: 'zones',
        paint: { 'line-color': '#0f172a', 'line-opacity': 0.08, 'line-width': 1 },
      });

      // Unit-to-call links go under the units; calls go on top of everything.
      m.addSource('links', { type: 'geojson', data: linksGeoJSON([], []) });
      m.addLayer({
        id: 'links-offered',
        type: 'line',
        source: 'links',
        filter: ['==', ['get', 'state'], 'OFFERED'],
        paint: { 'line-color': '#f59e0b', 'line-width': 2, 'line-dasharray': [2, 2] },
      });
      m.addLayer({
        id: 'links-assigned',
        type: 'line',
        source: 'links',
        filter: ['!=', ['get', 'state'], 'OFFERED'],
        paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-opacity': 0.8 },
      });

      m.addSource('agents', { type: 'geojson', data: toGeoJSON([]) });
      m.addLayer({
        id: 'agents',
        type: 'circle',
        source: 'agents',
        paint: {
          'circle-color': statusColor,
          // ALS units are drawn larger with a dark ring so they stand out from BLS.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'capability'], 'ALS', 3.5, 2.5], 15, ['match', ['get', 'capability'], 'ALS', 8, 6]],
          'circle-stroke-width': ['match', ['get', 'capability'], 'ALS', 1.2, 0],
          'circle-stroke-color': '#0f172a',
          'circle-opacity': ['match', ['get', 'status'], 'STALE', 0.45, 0.9],
        },
      });

      m.addSource('hospitals', { type: 'geojson', data: hospitalsGeoJSON });
      m.addLayer({
        id: 'hospitals',
        type: 'circle',
        source: 'hospitals',
        paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': '#dc2626', 'circle-stroke-width': 3 },
      });
      m.addLayer({
        id: 'hospital-labels',
        type: 'symbol',
        source: 'hospitals',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
        },
        paint: { 'text-color': '#991b1b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });

      m.addSource('calls', { type: 'geojson', data: callsGeoJSON([]) });
      m.addLayer({
        id: 'calls',
        type: 'circle',
        source: 'calls',
        paint: {
          // Bigger = more urgent. White centre with a thick state-coloured ring reads as "incident".
          'circle-radius': ['match', ['get', 'priority'], 'P1', 9, 'P2', 7, 5.5],
          'circle-color': '#ffffff',
          'circle-stroke-color': callColor,
          'circle-stroke-width': ['match', ['get', 'priority'], 'P1', 4, 3],
        },
      });
      if (pending.current) apply(m, pending.current);
      pending.current = null;

      const popup = new Popup({ closeButton: false, closeOnClick: false });
      m.on('mouseenter', 'calls', (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        m.getCanvas().style.cursor = 'pointer';
        const p = f.properties as { id: string; state: string; priority: string; agentId?: string; createdAt: number };
        const waited = Math.round((Date.now() - p.createdAt) / 1000);
        popup
          .setLngLat((f.geometry as Point).coordinates as [number, number])
          .setHTML(`<strong>${p.priority} call</strong> · ${p.state}<br/>${p.agentId ? `unit ${p.agentId}<br/>` : ''}open ${waited}s`)
          .addTo(m);
      });
      m.on('mouseleave', 'calls', () => {
        m.getCanvas().style.cursor = '';
        popup.remove();
      });

      m.on('mouseenter', 'agents', (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        m.getCanvas().style.cursor = 'pointer';
        const { id, status, capability } = f.properties as { id: string; status: string; capability: string };
        popup
          .setLngLat((f.geometry as Point).coordinates as [number, number])
          .setHTML(`<strong>${id}</strong> · ${capability}<br/>${status}`)
          .addTo(m);
      });
      m.on('mouseleave', 'agents', () => {
        m.getCanvas().style.cursor = '';
        popup.remove();
      });
    });

    return () => m.remove();
  }, []);

  return (
    <div ref={container} className="map">
      {mapError && (
        <div className="map-error">
          <strong>Map unavailable</strong>
          <span>This browser can't run WebGL, which the map needs. Live stats still work.</span>
          <code>{mapError}</code>
        </div>
      )}
    </div>
  );
});
