import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Map as MapLibreMap, NavigationControl, Popup } from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { HOSPITALS, JAIPUR_BOUNDS, JAIPUR_CENTER } from '@fast-call/shared';
import type { FleetRow } from '@fast-call/shared';
import { STATUS_COLORS } from './statusColors';

export interface FleetMapHandle {
  setFleet(rows: FleetRow[]): void;
}

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

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
  const pending = useRef<FleetRow[] | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    setFleet(rows) {
      const source = map.current?.getSource<GeoJSONSource>('agents');
      if (source) source.setData(toGeoJSON(rows));
      else pending.current = rows; // style not loaded yet; apply on load
    },
  }));

  useEffect(() => {
    let m: MapLibreMap;
    try {
      m = new MapLibreMap({
        container: container.current!,
        style: STYLE_URL,
        center: [JAIPUR_CENTER.lng, JAIPUR_CENTER.lat],
        zoom: 11.3,
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

      m.addSource('agents', { type: 'geojson', data: toGeoJSON(pending.current ?? []) });
      pending.current = null;
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

      const popup = new Popup({ closeButton: false, closeOnClick: false });
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
