/**
 * How the UI reaches core. The normal build talks to core over HTTP (coreTransport.ts); the
 * public demo build (VITE_DEMO=1) swaps in an in-browser replay (demo/backend.ts). Which one is
 * used is decided when the bundle is built (the `@transport` alias in vite.config.ts), so a
 * normal bundle never holds the demo.
 */
export interface Transport {
  /** Calls `/api${path}` and returns the JSON body; throws an Error with the body text when it fails. */
  request(method: string, path: string, body?: unknown): Promise<any>;
  /** Listens to a server-sent event stream; each message's data goes to `onData`. Returns a close function. */
  openStream(url: string, onData: (data: string) => void): () => void;
  /** A plain fetch, for the few calls that need the raw response (uploads, system info). */
  rawFetch(url: string, init?: RequestInit): Promise<Response>;
}
