/**
 * Data connections — the MCP servers Claude Code knows on this machine, and which of
 * them the API tester may read from. Everything is off until it is turned on here.
 */

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import { useCoreApi } from '../hooks/useSse';
import { Badge, Button, Card, type BadgeTone } from '../ui';

type Env = 'production' | 'staging' | 'local' | 'unknown';
type Access = 'read_only' | 'read_write' | 'unknown';
type Check = 'sql' | 'mongo' | 'plain';

export interface DataConnection {
  name: string;
  transport: string;
  canDiscover: boolean;
  guessedEnv: Env;
  envKind: Env;
  access: Access;
  enabled: boolean;
  changed: boolean;
  present: boolean;
  tools: Array<{ name: string; description: string; suggested: Check; risky: boolean }>;
  allowed: Array<{ tool: string; check: Check }>;
  projects: string[];
  checkedAt: number | null;
}
export interface ServerNotes {
  name: string;
  looksLikeDatabase: boolean;
  notes: string[];
}
interface ProjectName { id: string; name: string }

const ENV_TONE: Record<Env, BadgeTone> = { production: 'bad', staging: 'warn', local: 'ok', unknown: 'neutral' };
const CHECK_LABEL: Record<Check, string> = {
  sql: 'one SELECT, SHOW, EXPLAIN or DESCRIBE at a time',
  mongo: 'no stage that writes or runs code',
  plain: 'no check on what is passed',
};
const select = 'rounded-lg border border-hud-border bg-hud-surface px-2 py-1 text-sm text-hud-bright focus:border-hud-cyan focus:outline-none focus:ring-4 focus:ring-hud-cyan/15';

function message(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text;
  }
}

function status(c: DataConnection): { text: string; style: string } {
  if (!c.present) return { text: 'No longer in Claude Code', style: 'text-hud-dim' };
  if (c.changed) return { text: 'Changed since you reviewed it: nothing is granted', style: 'text-hud-amber' };
  if (c.enabled && c.allowed.length > 0 && c.projects.length > 0) return { text: `The app tester may read it on ${c.projects.length} project${c.projects.length === 1 ? '' : 's'}`, style: 'text-hud-green' };
  if (c.enabled) return { text: 'On, but no tool or no project is chosen yet', style: 'text-hud-amber' };
  return { text: 'No agent can use it', style: 'text-hud-dim' };
}

function Row({ connection, notes, projects, onChanged }: {
  connection: DataConnection;
  notes: ServerNotes | undefined;
  projects: ProjectName[];
  onChanged: (next: DataConnection) => void;
}) {
  const c = connection;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [envKind, setEnvKind] = useState<Env>(c.envKind);
  const [access, setAccess] = useState<Access>(c.access);
  const [enabled, setEnabled] = useState(c.enabled);
  const [tools, setTools] = useState<Record<string, Check>>(() => Object.fromEntries(c.allowed.map((a) => [a.tool, a.check])));
  const [granted, setGranted] = useState<string[]>(c.projects);
  const api = useCoreApi();

  useEffect(() => {
    setEnvKind(c.envKind);
    setAccess(c.access);
    setEnabled(c.enabled);
    setTools(Object.fromEntries(c.allowed.map((a) => [a.tool, a.check])));
    setGranted(c.projects);
  }, [c]);

  const run = async (work: () => Promise<{ connection: DataConnection }>) => {
    setBusy(true);
    setError('');
    try {
      onChanged((await work()).connection);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const discover = () => {
    if (!window.confirm(`List the tools of ${c.name}?\n\nThis starts the server once, the way Claude Code starts it, with whatever access it has. Nothing is sent to it except the question "which tools do you have?".`)) return;
    void run(() => api.post(`/connections/data/${encodeURIComponent(c.name)}/discover`, {}));
  };
  const save = () => void run(() => api.put(`/connections/data/${encodeURIComponent(c.name)}`, {
    envKind, access, enabled, projects: granted,
    tools: Object.entries(tools).map(([tool, check]) => ({ tool, check })),
  }));

  const s = status(c);
  const production = c.guessedEnv === 'production' || envKind === 'production';
  const reviewed = c.checkedAt !== null && !c.changed;
  const canTurnOn = !production && envKind !== 'unknown' && access === 'read_only';

  return (
    <div className="p-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 rounded-lg text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
        {open ? <ChevronDown aria-hidden className="h-4 w-4 text-hud-dim" /> : <ChevronRight aria-hidden className="h-4 w-4 text-hud-dim" />}
        <span className="font-mono text-xs font-semibold text-hud-bright">{c.name}</span>
        <Badge tone={ENV_TONE[c.envKind]}>{c.envKind === 'unknown' ? 'Environment not stated' : c.envKind[0]!.toUpperCase() + c.envKind.slice(1)}</Badge>
        {notes?.looksLikeDatabase && <span className="text-xs text-hud-dim">database</span>}
        <span className={clsx('ml-auto text-xs', s.style)}>{s.text}</span>
      </button>
      {notes?.notes.map((n) => <div key={n} className="ml-6 mt-0.5 text-xs text-hud-amber">It {n}.</div>)}

      {open && (
        <div className="ml-6 mt-3 space-y-3 text-sm">
          {production && (
            <div className="flex items-start gap-2 text-hud-red">
              <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>Its name says production. A production connection is never given to an agent, and it cannot be relabelled here.</span>
            </div>
          )}
          {!c.canDiscover && c.present && (
            <div className="text-hud-dim">This server is not a local program (or its name cannot be part of a tool name), so FryDay Code cannot list its tools yet. Only servers that start as a command are supported for agents so far.</div>
          )}

          {!production && c.canDiscover && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={discover} disabled={busy}>
                  {busy ? 'Working…' : reviewed ? 'List its tools again' : 'List its tools'}
                </Button>
                <span className="text-xs text-hud-dim">
                  {c.changed ? 'Its definition changed in Claude Code, so everything you chose is void until you list its tools again.'
                    : reviewed ? `${c.tools.length} tools, listed ${new Date(c.checkedAt!).toLocaleString()}.`
                    : 'Nothing can be chosen until its tools are listed.'}
                </span>
              </div>

              {reviewed && (
                <>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <label className="flex items-center gap-2 text-hud-bright">
                      It points at
                      <select className={select} value={envKind} onChange={(e) => setEnvKind(e.target.value as Env)}>
                        <option value="unknown">— choose —</option>
                        <option value="local">a local database</option>
                        <option value="staging">staging</option>
                        <option value="production">production</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-hud-bright">
                      Its database user
                      <select className={select} value={access} onChange={(e) => setAccess(e.target.value as Access)}>
                        <option value="unknown">— choose —</option>
                        <option value="read_only">can only read</option>
                        <option value="read_write">can also write</option>
                      </select>
                    </label>
                  </div>
                  <p className="text-xs text-hud-dim">
                    FryDay Code checks every call (see each tool below), but a server runs outside the sandbox with its own access.
                    The real guarantee is a database user that can only read, so a connection that can write is not given to an agent.
                  </p>

                  <div>
                    <h4 className="mb-1 text-sm font-semibold text-hud-bright">Tools the app tester gets</h4>
                    <div className="divide-y divide-hud-border rounded-xl border border-hud-border">
                      {c.tools.map((t) => (
                        <label key={t.name} className={clsx('flex items-start gap-2 p-2', t.risky && 'opacity-60')}>
                          <input type="checkbox" className="mt-1 h-4 w-4 rounded accent-hud-cyan" disabled={t.risky} checked={tools[t.name] !== undefined}
                            onChange={(e) => setTools((prev) => {
                              const next = { ...prev };
                              if (e.target.checked) next[t.name] = t.suggested; else delete next[t.name];
                              return next;
                            })} />
                          <span className="min-w-0">
                            <code className="font-mono text-xs text-hud-bright">{t.name}</code>{' '}
                            <span className="text-xs text-hud-dim">
                              {t.risky ? '— looks like it changes data or where the server points; never given to an agent' : `— ${CHECK_LABEL[t.suggested]}`}
                            </span>
                            {t.description && <span className="block text-xs text-hud-dim truncate">{t.description}</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h4 className="mb-1 text-sm font-semibold text-hud-bright">On which projects</h4>
                    {projects.length === 0 && <div className="text-hud-dim text-xs">No projects yet.</div>}
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {projects.map((p) => (
                        <label key={p.id} className="flex items-center gap-1.5 text-hud-bright text-sm">
                          <input type="checkbox" className="h-4 w-4 rounded accent-hud-cyan" checked={granted.includes(p.id)}
                            onChange={(e) => setGranted((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id)))} />
                          {p.name}
                        </label>
                      ))}
                    </div>
                  </div>

                  <label className="flex items-start gap-2 text-hud-bright">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 rounded accent-hud-cyan" checked={enabled} disabled={!canTurnOn && !enabled} onChange={(e) => setEnabled(e.target.checked)} />
                    <span>
                      Let the app tester use this connection.{' '}
                      {!canTurnOn && <span className="text-hud-dim">Say that it is local or staging and that its user can only read first.</span>}
                    </span>
                  </label>

                  <Button onClick={save} disabled={busy}>Save</Button>
                </>
              )}
            </>
          )}
          {error && <p role="alert" className="text-hud-red">{error}</p>}
        </div>
      )}
    </div>
  );
}

export default function DataConnections({ connections, notes, onChanged }: {
  connections: DataConnection[];
  notes: ServerNotes[];
  onChanged: (next: DataConnection) => void;
}) {
  const [projects, setProjects] = useState<ProjectName[]>([]);
  const api = useCoreApi();
  useEffect(() => {
    api.get('/projects').then((d) => setProjects((d.repos ?? []).map((r: ProjectName) => ({ id: r.id, name: r.name })))).catch(() => setProjects([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (connections.length === 0) return null;
  return (
    <Card padding="none" className="divide-y divide-hud-border">
      {connections.map((c) => (
        <Row key={c.name} connection={c} notes={notes.find((n) => n.name === c.name)} projects={projects} onChanged={onChanged} />
      ))}
    </Card>
  );
}
