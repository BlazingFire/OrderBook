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
    // The Windows 7 Office build runs Electron 22, which is Chromium 108.
    // docs/WINDOWS7.md.
    target: 'chrome108',
    assetsInlineLimit: 0,
  },
  server: {
    port: 5200,
    proxy: {
      '/api': 'http://localhost:4200',
      /*
       * Cached product images are served from `/uploads/images/…`
       * (`office/src/http/app.ts`), not from `/api`. Without this line every
       * product photo 404s for anybody evaluating the panel through the dev
       * server — which reads as "there is no product image flow" and was
       * reported as exactly that.
       */
      '/uploads': 'http://localhost:4200',
    },
  },
});
