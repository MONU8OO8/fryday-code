/**
 * The normal transport: HTTP to the core that served this page. Authentication is the HttpOnly
 * session cookie core sets, so no secret is ever built into or readable by the UI bundle.
 */
import type { Transport } from './transportTypes';

export const transport = {
  async request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  openStream(url, onData) {
    // EventSource reconnects by itself.
    const source = new EventSource(url);
    source.onmessage = (e) => onData(String(e.data));
    return () => source.close();
  },
  rawFetch: (url, init) => fetch(url, init),
} satisfies Transport;
