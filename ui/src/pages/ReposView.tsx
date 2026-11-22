/**
 * Projects — the repositories FryDay Code works on. Add one from a folder on this
 * machine or from a Git URL; FryDay suggests its facts and you confirm them.
 */

import { useState, useEffect, type FormEvent } from 'react';
import { GitBranch, Plus, Pencil, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { useCoreApi } from '../hooks/useSse';
import RunProfileFields, { describeRunProfile, type RunProfile } from './RunProfileFields';
import { Button, Badge, Card, EmptyState, Field, PageHeader } from '../ui';
import DeployerFields, { describeDeployer, type Deployer } from './DeployerFields';

interface Project {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  prodBranch: string;
  stgBranch: string | null;
  testCmd: string | null;
  lintCmd: string | null;
  typecheckCmd: string | null;
  installCmd: string | null;
  runProfile: RunProfile | null;
  deployer: string | null;
  deployerConfig: Deployer | null;
  verified: boolean;
  notes: string;
}
interface Detection {
  facts: Project;
  notes: string[];
  problems: string[];
}

function message(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  try {
    const body = JSON.parse(text) as { error?: string; issues?: string[] };
    return [body.error, ...(body.issues ?? [])].filter(Boolean).join(' — ') || text;
  } catch {
    return text;
  }
}

/** The facts of one project, editable. Used for a new project and for an existing one. */
function ProjectForm({ initial, isNew, onSave, onCancel }: {
  initial: Project;
  isNew: boolean;
  onSave: (p: Project) => Promise<void>;
  onCancel: () => void;
}) {
  const [p, setP] = useState<Project>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (change: Partial<Project>) => setP((prev) => ({ ...prev, ...change }));
  const orNull = (v: string) => (v.trim() ? v.trim() : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(p);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, value: string, onChange: (v: string) => void, opts: { placeholder?: string; hint?: string; disabled?: boolean; code?: boolean } = {}) => (
    <Field label={label} className={opts.code ? 'font-mono text-xs' : undefined} value={value} disabled={opts.disabled} placeholder={opts.placeholder}
      hint={opts.hint} onChange={(e) => onChange(e.target.value)} />
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {field('Name', p.name, (v) => set({ name: v }))}
        {field('Id', p.id, (v) => set({ id: v }), { disabled: !isNew, hint: isNew ? 'Lowercase letters, digits, dashes.' : undefined, code: true })}
      </div>
      {field('Clone on this computer', p.localPath, () => {}, { disabled: true, code: true })}
      <div className="grid gap-3 sm:grid-cols-2">
        {field('Production branch', p.prodBranch, (v) => set({ prodBranch: v }), { hint: 'Tasks branch from this.', code: true })}
        {field('Staging branch', p.stgBranch ?? '', (v) => set({ stgBranch: orNull(v) }), { placeholder: 'none', hint: 'Empty: tasks stop after review.', code: true })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field('Test command', p.testCmd ?? '', (v) => set({ testCmd: orNull(v) }), { placeholder: 'none', code: true })}
        {field('Typecheck command', p.typecheckCmd ?? '', (v) => set({ typecheckCmd: orNull(v) }), { placeholder: 'none', code: true })}
        {field('Lint command (must only report, not fix)', p.lintCmd ?? '', (v) => set({ lintCmd: orNull(v) }), { placeholder: 'none', code: true })}
        {field('Install command', p.installCmd ?? '', (v) => set({ installCmd: orNull(v) }), { placeholder: 'none', hint: 'Used when your own node_modules cannot be reused.', code: true })}
      </div>
      <RunProfileFields value={p.runProfile ?? null} onChange={(runProfile) => set({ runProfile })} />
      <DeployerFields kind={p.deployer} value={p.deployerConfig} hasStaging={Boolean(p.stgBranch)} onChange={(deployer, deployerConfig) => set({ deployer, deployerConfig })} />
      <label className="flex items-start gap-2 text-sm text-hud-bright">
        <input type="checkbox" className="mt-0.5 h-4 w-4 rounded accent-hud-cyan" checked={p.verified} onChange={(e) => set({ verified: e.target.checked })} />
        <span>I have checked these facts. <span className="text-hud-dim">Tasks only start on projects you have confirmed.</span></span>
      </label>
      {error && <p role="alert" className="text-sm text-hud-red">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add project' : 'Save'}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** Find a repository (folder or URL), then confirm what FryDay worked out about it. */
function AddProject({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) {
  const [source, setSource] = useState<'folder' | 'url'>('folder');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState<Detection | null>(null);
  const api = useCoreApi();

  const look = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      setFound(source === 'folder' ? await api.post('/projects/detect', { path: value.trim() }) : await api.post('/projects/clone', { url: value.trim() }));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-4 border-hud-cyan/40">
      <div className="mb-3 flex items-center">
        <h2 className="text-sm font-semibold text-hud-bright">Add a project</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-lg p-1 text-hud-dim hover:text-hud-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60"><X className="h-4 w-4" aria-hidden /></button>
      </div>

      {!found && (
        <form onSubmit={look} className="space-y-3">
          <div className="inline-flex text-sm" role="group" aria-label="Where the project is">
            {(['folder', 'url'] as const).map((s) => (
              <button key={s} type="button" onClick={() => { setSource(s); setError(''); }} aria-pressed={source === s}
                className={clsx('border px-3 py-1.5 first:rounded-l-lg last:rounded-r-lg last:border-l-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
                  source === s ? 'border-hud-cyan bg-hud-cyan/10 font-semibold text-hud-cyan' : 'border-hud-border text-hud-dim hover:text-hud-bright')}>
                {s === 'folder' ? 'A folder on this computer' : 'A Git URL'}
              </button>
            ))}
          </div>
          <Field label={source === 'folder' ? 'Path to the clone' : 'Git URL'} className="font-mono text-xs" autoFocus value={value} onChange={(e) => setValue(e.target.value)}
            placeholder={source === 'folder' ? '~/code/my-repo' : 'git@github.com:owner/repo.git  or  https://github.com/owner/repo.git'}
            hint={source === 'folder'
              ? 'Your clone is only read. Tasks work in separate copies and never touch your checkout.'
              : 'Cloned with your own git setup into FryDay Code\'s folder. Nothing is pushed.'}
            error={error || undefined} />
          <Button type="submit" disabled={!value.trim() || busy}>
            {busy ? (source === 'folder' ? 'Looking…' : 'Cloning…') : source === 'folder' ? 'Look at it' : 'Clone and look at it'}
          </Button>
        </form>
      )}

      {found && (
        <>
          {found.problems.length > 0 && (
            <div role="alert" className="mb-3 space-y-1 rounded-xl border border-hud-red/40 p-3 text-sm text-hud-red">
              {found.problems.map((x) => <div key={x}>{x}</div>)}
            </div>
          )}
          <div className="mb-4 space-y-1 rounded-xl border border-hud-border p-3 text-sm text-hud-dim">
            <div className="font-semibold text-hud-bright">What FryDay found</div>
            {found.notes.map((x) => <div key={x}>{x}</div>)}
          </div>
          <ProjectForm initial={found.facts} isNew onCancel={onClose}
            onSave={async (p) => { await api.post('/projects', strip(p)); onAdded(); }} />
        </>
      )}
    </Card>
  );
}

/** What the API accepts for a project: no nulls for optional text it treats as "unset" is fine, but no unknown keys. */
function strip(p: Project): Record<string, unknown> {
  const { id, name, localPath, remoteUrl, prodBranch, stgBranch, testCmd, lintCmd, typecheckCmd, installCmd, verified, notes } = p;
  // A deployer needs a staging branch; without one it is dropped rather than refused.
  const deploys = Boolean(stgBranch) && p.deployer === 'jenkins' && p.deployerConfig;
  return {
    id, name, localPath, remoteUrl, prodBranch, stgBranch, testCmd, lintCmd, typecheckCmd, installCmd, runProfile: p.runProfile ?? null,
    deployer: deploys ? 'jenkins' : null, deployerConfig: deploys ? p.deployerConfig : null, verified, notes,
  };
}

export default function ReposView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  /** Data connections the API tester may read, by project. */
  const [reads, setReads] = useState<Record<string, string[]>>({});
  const api = useCoreApi();

  const refresh = () => {
    api.get('/connections/data').then((d) => {
      const map: Record<string, string[]> = {};
      for (const c of (d.dataConnections ?? []) as Array<{ name: string; enabled: boolean; changed: boolean; projects: string[] }>) {
        if (!c.enabled || c.changed) continue;
        for (const p of c.projects) map[p] = [...(map[p] ?? []), c.name];
      }
      setReads(map);
    }).catch(() => {});
    return api.get('/projects').then((d) => setProjects(d.repos ?? [])).catch((err) => setError(message(err)));
  };
  useEffect(() => { void refresh(); }, []);

  const act = async (work: () => Promise<unknown>) => {
    setError('');
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  };
  const remove = (p: Project) => {
    if (!window.confirm(`Remove ${p.name} from FryDay Code?\n\nYour clone at ${p.localPath} is not touched.`)) return;
    void act(() => api.del(`/projects/${p.id}`));
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <PageHeader title="Projects"
        subtitle={`${projects.filter((r) => r.verified).length} of ${projects.length} confirmed. The code FryDay Code may work on.`}
        actions={!adding && <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setAdding(true)}>Add project</Button>} />

      {error && <p role="alert" className="text-sm text-hud-red">{error}</p>}
      {adding && <AddProject onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void refresh(); }} />}
      {projects.length === 0 && !adding && (
        <Card><EmptyState icon={<GitBranch className="h-5 w-5" />} title="No projects yet" text="Add a repository to give FryDay Code something to work on."
          action={<Button onClick={() => setAdding(true)}>Add project</Button>} /></Card>
      )}

      <div className="space-y-3">
        {projects.map((p) => (
          <Card key={p.id} padding="sm" className={clsx('p-4', !p.verified && 'border-hud-amber/50')}>
            {editing === p.id ? (
              <ProjectForm initial={p} isNew={false} onCancel={() => setEditing(null)}
                onSave={async (next) => { const { id: _id, ...facts } = strip(next); await api.patch(`/projects/${p.id}`, facts); setEditing(null); await refresh(); }} />
            ) : (
              <div className="flex flex-wrap items-start gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-center gap-2">
                    <h2 className="font-semibold text-hud-bright">{p.name}</h2>
                    <Badge tone={p.verified ? 'ok' : 'warn'} dot>{p.verified ? 'Confirmed' : 'Not confirmed yet'}</Badge>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-hud-dim">
                    <dt>Branches</dt>
                    <dd>production <code className="font-mono text-xs text-hud-cyan">{p.prodBranch}</code>, staging <code className="font-mono text-xs text-hud-cyan">{p.stgBranch ?? 'none'}</code></dd>
                    {p.stgBranch && (<><dt>Deploys</dt><dd className={p.deployer ? 'text-hud-bright' : ''}>{describeDeployer(p.deployer, p.deployerConfig)}</dd></>)}
                    <dt>Checks</dt>
                    <dd className="flex flex-wrap gap-x-3">
                      {([['test', p.testCmd], ['typecheck', p.typecheckCmd], ['lint', p.lintCmd]] as Array<[string, string | null]>).map(([label, cmd]) => (
                        <span key={label}>{label} <code className={clsx('font-mono text-xs', cmd ? 'text-hud-bright' : 'text-hud-dim')}>{cmd ?? 'not checked'}</code></span>
                      ))}
                    </dd>
                    <dt>Tried out running</dt>
                    <dd>
                      <span className={p.runProfile ? 'text-hud-bright' : ''}>{describeRunProfile(p.runProfile ?? null)}</span>
                      {p.runProfile?.api && (
                        <span className="ml-3">reads <span className={reads[p.id]?.length ? 'text-hud-bright' : ''}>{reads[p.id]?.join(', ') || 'no data connection'}</span></span>
                      )}
                    </dd>
                    <dt>Folder</dt>
                    <dd className="truncate font-mono text-xs">{p.localPath}</dd>
                  </dl>
                  {p.notes && <p className={clsx('mt-2 text-sm', p.verified ? 'text-hud-dim' : 'text-hud-amber')}>{p.notes}</p>}
                </div>
                <div className="flex flex-shrink-0 flex-wrap gap-2">
                  <Button size="sm" variant={p.verified ? 'secondary' : 'primary'} onClick={() => void act(() => api.post(`/projects/${p.id}/verify`, { verified: !p.verified }))}>
                    {p.verified ? 'Unconfirm' : 'Confirm'}
                  </Button>
                  <Button size="sm" variant="secondary" icon={<Pencil className="h-3.5 w-3.5" aria-hidden />} onClick={() => setEditing(p.id)}>Edit</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />} onClick={() => remove(p)}>Remove</Button>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
