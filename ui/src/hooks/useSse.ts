import { useEffect, useRef, useCallback } from 'react';
import { transport } from '@transport';

export type SseHandler = (event: Record<string, unknown>) => void;

/**
 * One EventSource per URL, shared by every component that listens to it. A browser keeps
 * only a few connections open per host; a page with a stream per panel would starve its
 * own API calls.
 */
interface Shared {
  close: () => void;
  handlers: Set<{ current: SseHandler }>;
}
const shared = new Map<string, Shared>();

function subscribe(url: string, handler: { current: SseHandler }): () => void {
  let entry = shared.get(url);
  if (!entry) {
    const handlers = new Set<{ current: SseHandler }>();
    const close = transport.openStream(url, (raw) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw);
      } catch {
        return; // a keepalive comment
      }
      for (const h of handlers) {
        try {
          h.current(data);
        } catch (err) {
          console.error('event handler failed', err);
        }
      }
    });
    entry = { close, handlers };
    shared.set(url, entry);
  }
  entry.handlers.add(handler);
  return () => {
    const current = shared.get(url);
    if (!current) return;
    current.handlers.delete(handler);
    if (current.handlers.size === 0) {
      current.close();
      shared.delete(url);
    }
  };
}

export function useSse(url: string, onEvent: SseHandler, deps: unknown[] = []) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => subscribe(url, handlerRef),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url, ...deps]);
}

/**
 * Calls the core API (or, in the public demo build, its in-browser replay: see transportTypes.ts).
 */
export function useCoreApi() {
  const request = useCallback((method: string, path: string, body?: unknown) => transport.request(method, path, body), []);

  return {
    get: (path: string) => request('GET', path),
    post: (path: string, body: unknown) => request('POST', path, body),
    patch: (path: string, body: unknown) => request('PATCH', path, body),
    put: (path: string, body: unknown) => request('PUT', path, body),
    del: (path: string) => request('DELETE', path),
  };
}
