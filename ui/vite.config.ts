import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// The UI is always served by core at /ui/ (core sets the session cookie with index.html),
// so there is no standalone dev server: `npm run dev` rebuilds into core/public on change.
//
// The public demo (`npm run build:demo`, or VITE_DEMO=1) is the same UI with core swapped for
// an in-browser replay of a recorded task (src/demo/backend.ts, through the `@transport` alias),
// plus the landing page (landing/index.html). It builds into dist-demo/: the landing page at /,
// the app at /app/. VITE_BASE sets where the site is served from (default /; /fryday-code/ for
// GitHub Pages). The normal build never includes the demo or its recording.
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo' || process.env['VITE_DEMO'] === '1';
  const base = demo ? `/${(process.env['VITE_BASE'] ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/') : '/ui/';
  return {
    base,
    plugins: [react(), ...(demo ? [demoPages()] : [])],
    define: { 'import.meta.env.VITE_DEMO': JSON.stringify(demo ? '1' : '') },
    resolve: {
      alias: [
        { find: /^@transport$/, replacement: path.resolve(__dirname, demo ? './src/demo/backend.ts' : './src/hooks/coreTransport.ts') },
        { find: '@', replacement: path.resolve(__dirname, './src') },
      ],
    },
    build: demo
      ? {
          outDir: 'dist-demo',
          emptyOutDir: true,
          // One bundle with the recording in it (about 125 KB of JSON); fine for a static demo.
          chunkSizeWarningLimit: 800,
          rollupOptions: { input: { app: path.resolve(__dirname, 'index.html'), landing: path.resolve(__dirname, 'landing/index.html') } },
        }
      : {
          outDir: '../core/public',   // built UI served by core/server.ts from /ui
          emptyOutDir: true,
        },
  };
});

/** The demo site's layout: the landing page becomes /index.html and the app /app/index.html. */
function demoPages(): Plugin {
  const moves: Record<string, string> = { 'landing/index.html': 'index.html', 'index.html': 'app/index.html' };
  return {
    name: 'fryday-demo-pages',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.entries(moves).map(([from, to]) => {
        const asset = bundle[from];
        if (!asset || asset.type !== 'asset') throw new Error(`demo build: ${from} was not built`);
        delete bundle[from];
        return { to, source: asset.source };
      });
      for (const { to, source } of html) this.emitFile({ type: 'asset', fileName: to, source });
    },
  };
}
