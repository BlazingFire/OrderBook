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
  // A symlinked workspace package: leave it as source so its .tsx, .css and
  // .woff2 graph is transpiled like local code. Pre-bundling would take font
  // emission away from `assetsInlineLimit: 0` below, and this app must never
  // reach for a CDN — the shop network has no internet.
  optimizeDeps: { exclude: ['@orderbook/ui'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Vite's default browser list with Chrome raised from 87 to 108, the floor:
    // Chrome 109 on a Windows 7 PC opens this UI over the LAN, the same engine
    // as the Win7 Office build's Electron 22. The rest stay so a Safari or
    // Firefox on the LAN keeps its down-levelling and its -webkit- CSS
    // prefixes. docs/WINDOWS7.md.
    target: ['es2020', 'chrome108', 'edge88', 'firefox78', 'safari14'],
    // Everything is inlined/bundled locally — this app must never reach for a
    // CDN at runtime, because the shop network has no internet.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5100,
    proxy: {
      '/api': 'http://localhost:4100',
      // Avatars are mounted at `/uploads/avatars` and images at
      // `/uploads/images` — outside `/api`, so unproxied they 404 through the
      // dev server while working perfectly in the packaged app.
      '/uploads': 'http://localhost:4100',
      '/socket.io': { target: 'http://localhost:4100', ws: true },
    },
  },
});
