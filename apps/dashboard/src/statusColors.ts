import type { DisplayStatus } from '@fast-call/shared';

export const STATUS_COLORS: Record<DisplayStatus, string> = {
  AVAILABLE: '#16a34a',
  DISPATCHED: '#f59e0b',
  EN_ROUTE: '#2563eb',
  AT_SCENE: '#dc2626',
  TRANSPORTING: '#7c3aed',
  AT_HOSPITAL: '#db2777',
  OFFLINE: '#6b7280',
  STALE: '#9ca3af',
};

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  AVAILABLE: 'Available',
  DISPATCHED: 'Dispatched',
  EN_ROUTE: 'En route',
  AT_SCENE: 'At scene',
  TRANSPORTING: 'Transporting',
  AT_HOSPITAL: 'At hospital',
  OFFLINE: 'Offline',
  STALE: 'Stale GPS',
};
