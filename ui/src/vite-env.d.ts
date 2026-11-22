/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the public demo build (npm run build:demo): the in-browser replay instead of core. */
  readonly VITE_DEMO?: string;
  /** Where the demo site is served from, e.g. /fryday-code/ on GitHub Pages (default /). */
  readonly VITE_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
