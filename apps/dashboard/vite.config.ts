import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin WebSocket in dev: the browser talks to Vite, Vite forwards /ws to the API.
    proxy: { '/ws': { target: 'ws://127.0.0.1:4000', ws: true } },
  },
});
