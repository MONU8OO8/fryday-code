/** What this install runs with (GET /api/system), asked once per page load and shared. */

import { useEffect, useState } from 'react';
import { transport } from '@transport';

export interface SystemInfo {
  version: string;
  /** `fryday-code demo`: stand-in agents on a sample project. */
  demo?: boolean;
}

let asked: Promise<SystemInfo | null> | null = null;

function ask(): Promise<SystemInfo | null> {
  asked ??= transport.rawFetch('/api/system', { credentials: 'same-origin' })
    .then((res) => (res.ok ? (res.json() as Promise<SystemInfo>) : null))
    .catch(() => null)
    .then((info) => { if (info === null) asked = null; return info; });
  return asked;
}

/** The install's system info; null until it is known (or when it could not be read). */
export function useSystem(): SystemInfo | null {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  useEffect(() => {
    let live = true;
    void ask().then((v) => { if (live) setInfo(v); });
    return () => { live = false; };
  }, []);
  return info;
}
