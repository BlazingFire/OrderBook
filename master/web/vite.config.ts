import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* The shipped version, injected at build time so the footer and the update
 * screen cannot drift from the package that produced them. */
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
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
