import type { Hospital } from './types.js';

/**
 * Receiving hospitals. Coordinates from OpenStreetMap (Nominatim), looked up 2026-10-31.
 * All are tertiary-care hospitals with emergency/ICU, so every one can receive an ALS patient.
 * TODO: Asian Cancer Hospital is not in OSM yet; add once its location is confirmed.
 */
export const HOSPITALS: readonly Hospital[] = [
  { id: 'H-SMS', name: 'SMS Hospital', location: { lat: 26.90602, lng: 75.8161 }, hasALSCare: true },
  { id: 'H-APEX', name: 'Apex Hospital', location: { lat: 26.85475, lng: 75.82527 }, hasALSCare: true },
  { id: 'H-RUHS', name: 'RUHS Hospital', location: { lat: 26.80193, lng: 75.82945 }, hasALSCare: true },
  {
    id: 'H-JEEVAN',
    name: 'Jeevan Rekha Superspeciality Hospital',
    location: { lat: 26.8008, lng: 75.86206 }, // confirmed against Google Maps

    hasALSCare: true,
  },
  { id: 'H-BOMBAY', name: 'Bombay Hospital', location: { lat: 26.78194, lng: 75.8634 }, hasALSCare: true },
  {
    id: 'H-MGH',
    name: 'Mahatma Gandhi Hospital',
    location: { lat: 26.76998, lng: 75.8545 },
    hasALSCare: true,
  },
];
