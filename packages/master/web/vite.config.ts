import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Everything is inlined/bundled locally — this app must never reach for a
    // CDN at runtime, because the shop network has no internet.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5100,
    proxy: {
      '/api': 'http://localhost:4100',
      '/socket.io': { target: 'http://localhost:4100', ws: true },
    },
  },
});
