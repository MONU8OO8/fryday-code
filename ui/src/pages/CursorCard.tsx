/**
 * The Cursor CLI as an engine for read-only agents: whether it can run, and the owner's
 * Cursor API key. The key is kept by core and never shown again.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Cpu, ShieldAlert } from 'lucide-react';
import { useCoreApi } from '../hooks/useSse';
import { Button, Card, Field } from '../ui';
import ConnectionHead from './ConnectionHead';

interface RunnerView {
  id: string;
  label: string;
  caps: { guardHook: boolean; structuredOutput: boolean; osSandbox: 'shell' | 'whole-process' | 'none'; budgetStop: boolean; roles: string[] };
  available: boolean;
  why: string | null;
}
interface Runners { runners: RunnerView[]; cursor: { installed: boolean; keySet: boolean } }

function message(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  try { return (JSON.parse(text) as { error?: string }).error ?? text; } catch { return text; }
}

const SANDBOX: Record<RunnerView['caps']['osSandbox'], string> = {
  shell: 'its shell commands run in the OS sandbox',
  'whole-process': 'the whole program runs in the OS sandbox',
  none: 'no OS sandbox',
};

export default function CursorCard() {
  const [r, setR] = useState<Runners | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const api = useCoreApi();

  useEffect(() => { api.get('/runners').then(setR).catch((e) => setError(message(e))); }, []);

  const run = async (work: () => Promise<Runners>) => {
    setBusy(true); setError('');
    try { setR(await work()); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const saveKey = (e: FormEvent) => { e.preventDefault(); void run(async () => { const next = await api.put('/runners/cursor/key', { key }); setKey(''); return next; }); };

  if (!r) return error ? <p role="alert" className="text-sm text-hud-red">{error}</p> : null;
  const cursor = r.runners.find((x) => x.id === 'cursor');
  return (
    <Card className="space-y-4">
      {r.runners.map((x) => (
        <div key={x.id}>
          <ConnectionHead icon={<Cpu className="h-4 w-4" />} title={x.label} tone={x.available ? 'ok' : 'neutral'} state={x.available ? 'Ready' : 'Not available'} />
          <p className="mt-1 text-xs text-hud-dim">
            Used for: {x.caps.roles.length === 0 ? 'no agents' : x.caps.roles.length > 4 ? 'every agent' : `only ${x.caps.roles.join(', ')}`}.
          </p>
          <p className="mt-1 text-xs text-hud-dim">
            {x.caps.guardHook ? 'FryDay checks every tool call' : 'No FryDay check on each tool call'} · {SANDBOX[x.caps.osSandbox]} · {x.caps.structuredOutput ? 'answers in a fixed format' : 'its answer is read from its last message'} · {x.caps.budgetStop ? 'stopped at its token limit per run' : 'uses its own plan. Cursor reports tokens only when it finishes, so its time limit is what stops it.'}
            {!x.available && x.why && <span className="block text-hud-amber">Why not: {x.why}.</span>}
          </p>
        </div>
      ))}

      {cursor && (
        <div className="border-t border-hud-border pt-4">
          <div className="flex items-start gap-2 text-sm text-hud-bright">
            <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-hud-amber" />
            <span>
              The Cursor CLI can be chosen for the Understander and the Planner on the Agents page. It is <span className="font-semibold text-hud-amber">reduced isolation</span>: FryDay cannot check each of its tool calls,
              so it gets a throwaway copy of the code, runs in ask mode, and the whole program is sandboxed: it can read only that copy and its own empty home, and reach only Cursor's servers.
              It never writes code, runs tests or reaches a service.
            </span>
          </div>
          <p className="mt-2 text-xs text-hud-dim">
            {r.cursor.installed ? <><code className="font-mono">cursor-agent</code> is installed.</> : <><code className="font-mono">cursor-agent</code> is not installed on this computer.</>}{' '}
            It runs with its own empty home, so your Cursor sign-in is not used: it needs a User API key from the Cursor dashboard (Integrations).
          </p>
          <form onSubmit={saveKey} className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="Cursor API key" wrapperClassName="min-w-[16rem] flex-1" className="font-mono text-xs" type="password" value={key} onChange={(e) => setKey(e.target.value)}
              placeholder={r.cursor.keySet ? 'a key is set; paste a new one to replace it' : 'Cursor API key'} autoComplete="off" />
            <Button type="submit" disabled={busy || !key.trim()}>Save</Button>
            {r.cursor.keySet && (
              <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm('Forget the Cursor API key? Agents set to Cursor stop being able to start.')) void run(() => api.del('/runners/cursor/key')); }}>Forget key</Button>
            )}
          </form>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-hud-red">{error}</p>}
    </Card>
  );
}
