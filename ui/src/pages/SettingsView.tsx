import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { useCoreApi } from '../hooks/useSse';
import { Badge, Button, Card, PageHeader, Section, controlClass } from '../ui';
import { look, fmtTokens, parseTokens, countedTokens, modelName } from '../agents';

/** Token limits are whole numbers of counted tokens (input + output + cache writes). */
interface RoleSettings { engine: 'claude' | 'cursor'; cursorModel: string; model: string; effort: string; tokenLimit: number; timeoutMinutes: number }
interface Settings {
  roles: Record<string, RoleSettings>;
  coderEscalation: { fromRound: number; model: string } | null;
  taskTokenLimit: number;
  maxRounds: number;
  stagingApprovals: 'once' | 'each_step';
  maxAgents: number;
  installDomains: string[];
  alerts: { mac: boolean };
}
interface SettingsPayload {
  settings: Settings;
  defaults: Settings;
  models: string[];
  efforts: string[];
  roles: string[];
  cursorRoles: string[];
  modelOverride: string | null;
}
interface SystemInfo {
  version: string;
  home: string;
  platform: string;
  claudeBin: string;
  agentAuth: 'api_key' | 'cli_login';
}

const ROLE_LABEL: Record<string, { name: string; job: string }> = {
  fryday: { name: 'FryDay', job: 'answers you in chat' },
  analyst: { name: 'Understander', job: 'understands the task, finds the project and branch, asks what is unclear' },
  planner: { name: 'Planner', job: 'design and acceptance criteria' },
  coder: { name: 'Builder', job: 'writes the change' },
  tester: { name: 'Checker', job: 'checks the change against the criteria' },
  api_tester: { name: 'App tester', job: 'uses the running service through its API and reads granted data' },
  ui_tester: { name: 'Page tester', job: 'uses the pages in a browser and takes screenshots' },
  reflector: { name: 'Reflector', job: 'reads a finished task and proposes lessons for you to approve' },
  system: { name: 'System', job: 'small internal runs' },
};
interface RoleUsage { role: string; runs: number; budgetStops: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

const cell = `${controlClass()} !w-auto px-2 py-1`;

/** How a limit is written in its box: "1.5M" when that is exact, else the whole number. */
const tokensText = (n: number) => (parseTokens(fmtTokens(n)) === n ? fmtTokens(n) : n.toLocaleString('en-US'));

/** A token count box: takes "1.5M", "400k" or a plain number, and saves a whole number on blur. */
function TokenInput({ value, label, onSave, onBad }: { value: number; label: string; onSave: (n: number) => void; onBad: (text: string) => void }) {
  return (
    <input
      aria-label={label} className={clsx(cell, '!w-24')} type="text" inputMode="decimal" placeholder="e.g. 400k"
      defaultValue={tokensText(value)} key={`${label}-${value}`}
      onBlur={(e) => {
        const text = e.target.value.trim();
        if (text === tokensText(value)) return;
        const n = parseTokens(text);
        if (n === null) { e.target.value = tokensText(value); onBad(text); return; }
        if (n !== value) onSave(n);
      }}
    />
  );
}

export default function SettingsView() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [week, setWeek] = useState<Record<string, RoleUsage>>({});
  const api = useCoreApi();

  useEffect(() => {
    api.get('/settings').then(setData).catch((err) => setError(String(err instanceof Error ? err.message : err)));
    api.get('/system').then(setInfo).catch(() => {});
    api.get('/usage/by-role?days=7').then((d) => setWeek(Object.fromEntries((d.roles ?? []).map((r: RoleUsage) => [r.role, r])))).catch(() => {});
  }, []);

  /** Save one change at once; show what the server now has. */
  const save = async (change: Partial<Settings> | { roles: Record<string, Partial<RoleSettings>> }, what: string) => {
    setError('');
    try {
      const res = await api.put('/settings', change);
      setData((d) => (d ? { ...d, settings: res.settings } : d));
      setSaved(`${what} saved`);
      window.setTimeout(() => setSaved(''), 2500);
    } catch (err) {
      let message = String(err instanceof Error ? err.message : err);
      try { message = JSON.parse(message).error ?? message; } catch { /* not JSON */ }
      setError(message);
    }
  };
  const badTokens = (text: string) => setError(`"${text}" is not a token count. Write it like 400k, 1.5M or 250000.`);
  const num = (value: string, min: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? n : null;
  };

  if (!data) return <div className="p-6 text-sm text-hud-dim">{error || 'Loading…'}</div>;
  const s = data.settings;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <PageHeader title="Agents" subtitle="Which engine, model and limits each agent uses. The defaults work; change them when you know why."
        actions={(error || saved) && <span role={error ? 'alert' : 'status'} className={clsx('text-sm', error ? 'text-hud-red' : 'text-hud-green')}>{error || saved}</span>} />

      {data.modelOverride && (
        <div role="status" className="rounded-xl border border-hud-amber/50 p-3 text-sm text-hud-amber">
          FRYDAY_MODEL is set, so every agent runs on {modelName(data.modelOverride)} whatever is chosen below.
        </div>
      )}

      <Section title="Agents">
      <Card padding="none" className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hud-border text-left text-xs text-hud-dim">
              <th scope="col" className="p-3 font-medium">Agent</th>
              <th scope="col" className="p-3 font-medium">Engine</th>
              <th scope="col" className="p-3 font-medium">Model</th>
              <th scope="col" className="p-3 font-medium">Effort</th>
              <th scope="col" className="p-3 font-medium">Token limit per run</th>
              <th scope="col" className="p-3 font-medium">Time limit (min)</th>
              <th scope="col" className="p-3 font-medium">Last 7 days</th>
            </tr>
          </thead>
          <tbody>
            {data.roles.filter((r) => r !== 'system').map((role) => {
              const rs = s.roles[role]!;
              const label = ROLE_LABEL[role] ?? { name: role, job: '' };
              const set = (change: Partial<RoleSettings>) => save({ roles: { [role]: change } }, label.name);
              return (
                <tr key={role} className="border-b border-hud-border last:border-0">
                  <td className="p-3 align-top">
                    <div className="flex items-center gap-1.5 font-medium text-hud-bright">
                      {(() => { const Icon = look(role).icon; return <Icon aria-hidden className="h-4 w-4" style={{ color: look(role).color }} />; })()}
                      {label.name}
                    </div>
                    <div className="max-w-[16rem] text-xs text-hud-dim">{label.job}</div>
                  </td>
                  <td className="p-3 align-top">
                    {data.cursorRoles.includes(role) ? (
                      <select aria-label={`${label.name} engine`} className={cell} value={rs.engine} onChange={(e) => set({ engine: e.target.value as RoleSettings['engine'] })}>
                        <option value="claude">Claude Code</option>
                        <option value="cursor">Cursor CLI</option>
                      </select>
                    ) : <span className="text-hud-dim" title="Agents that change code or reach a running service run only on Claude Code, where every tool call passes FryDay's guard.">Claude Code</span>}
                    {rs.engine === 'cursor' && (
                      <div className="mt-1" title="Cursor has no FryDay guard on each tool call. It reads a throwaway copy of the code, in ask mode, inside a sandbox around the whole program that reaches only Cursor's servers.">
                        <Badge tone="warn">Reduced isolation</Badge>
                      </div>
                    )}
                  </td>
                  {rs.engine === 'cursor' ? (
                    <>
                      <td className="p-3 align-top">
                        <input
                          aria-label={`${label.name} Cursor model`} className={clsx(cell, '!w-36')} defaultValue={rs.cursorModel} key={`${role}-cm-${rs.cursorModel}`}
                          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== rs.cursorModel) void set({ cursorModel: v }); }}
                        />
                        <div className="mt-1 text-xs text-hud-dim">A Cursor model name, or auto</div>
                      </td>
                      <td className="p-3 align-top text-hud-dim">None</td>
                      <td className="p-3 align-top">
                        <TokenInput value={rs.tokenLimit} label={`${label.name} token limit per run`} onSave={(n) => void set({ tokenLimit: n })} onBad={badTokens} />
                        <div className="mt-1 text-xs text-hud-dim" title="Cursor reports tokens only when it finishes, so its time limit is what stops it.">Uses your Cursor plan</div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="p-3 align-top">
                        <select aria-label={`${label.name} model`} className={cell} value={rs.model} onChange={(e) => set({ model: e.target.value })}>
                          {data.models.map((m) => <option key={m} value={m}>{modelName(m)}</option>)}
                        </select>
                      </td>
                      <td className="p-3 align-top">
                        <select aria-label={`${label.name} effort`} className={cell} value={rs.effort} onChange={(e) => set({ effort: e.target.value })}>
                          {data.efforts.map((e) => <option key={e} value={e}>{e}</option>)}
                        </select>
                      </td>
                      <td className="p-3 align-top">
                        <TokenInput value={rs.tokenLimit} label={`${label.name} token limit per run`} onSave={(n) => void set({ tokenLimit: n })} onBad={badTokens} />
                      </td>
                    </>
                  )}
                  <td className="p-3 align-top">
                    <input
                      aria-label={`${label.name} time limit in minutes`} className={clsx(cell, '!w-20')} type="number" min="1" step="1"
                      defaultValue={rs.timeoutMinutes} key={`${role}-t-${rs.timeoutMinutes}`}
                      onBlur={(e) => { const n = num(e.target.value, 1); if (n !== null && n !== rs.timeoutMinutes) void set({ timeoutMinutes: Math.round(n) }); }}
                    />
                  </td>
                  <td className="whitespace-nowrap p-3 align-top text-xs text-hud-dim">
                    {week[role] ? (
                      <>
                        <div><span className="font-medium text-hud-bright">{fmtTokens(countedTokens(week[role]!))} tokens</span> in {week[role]!.runs} run{week[role]!.runs === 1 ? '' : 's'}</div>
                        <div>{fmtTokens(countedTokens(week[role]!) / week[role]!.runs)} a run, {fmtTokens(week[role]!.cacheReadTokens)} reused</div>
                        {week[role]!.budgetStops > 0 && (
                          <div className="font-medium text-hud-amber" title="These runs stopped at the token limit per run and asked you to continue. If that keeps happening, raise the limit.">
                            {week[role]!.budgetStops} hit the limit
                          </div>
                        )}
                      </>
                    ) : <span>No runs</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      </Section>

      <Section title="Tasks">
      <Card padding="none" className="divide-y divide-hud-border text-sm">
        <label className="flex flex-wrap items-center gap-3 p-4">
          <span className="min-w-[14rem] flex-1 text-hud-bright">Token budget per task <span className="block text-xs text-hud-dim">When a task has used this many tokens, it pauses and asks you.</span></span>
          <TokenInput value={s.taskTokenLimit} label="Token budget per task" onSave={(n) => void save({ taskTokenLimit: n }, 'Task token budget')} onBad={badTokens} />
        </label>
        <label className="flex flex-wrap items-center gap-3 p-4">
          <span className="min-w-[14rem] flex-1 text-hud-bright">Approvals on the way to staging
            <span className="block text-xs text-hud-dim">One yes: your approval of a change also deploys it to the staging server and answers the pipeline's own staging prompt. Every step: the merge, the deploy and each prompt are asked one by one. Production is never deployed either way.</span>
          </span>
          <select className={clsx(cell, '!w-36')} value={s.stagingApprovals} aria-label="Approvals on the way to staging"
            onChange={(e) => void save({ stagingApprovals: e.target.value as Settings['stagingApprovals'] }, 'Approvals on the way to staging')}>
            <option value="once">One yes</option>
            <option value="each_step">Every step</option>
          </select>
        </label>
        <label className="flex flex-wrap items-center gap-3 p-4">
          <span className="min-w-[14rem] flex-1 text-hud-bright">Builder rounds before the task comes back to you</span>
          <input className={clsx(cell, '!w-20')} type="number" min="1" max="20" step="1" defaultValue={s.maxRounds} key={`mr-${s.maxRounds}`}
            onBlur={(e) => { const n = num(e.target.value, 1); if (n !== null && n !== s.maxRounds) void save({ maxRounds: Math.round(n) }, 'Rounds'); }} />
        </label>
        <label className="flex flex-wrap items-center gap-3 p-4">
          <span className="min-w-[14rem] flex-1 text-hud-bright">Agents running at the same time</span>
          <input className={clsx(cell, '!w-20')} type="number" min="1" max="16" step="1" defaultValue={s.maxAgents} key={`ma-${s.maxAgents}`}
            onBlur={(e) => { const n = num(e.target.value, 1); if (n !== null && n !== s.maxAgents) void save({ maxAgents: Math.round(n) }, 'Agents at once'); }} />
        </label>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <span className="min-w-[14rem] flex-1 text-hud-bright">Stronger model for the Builder after repeated send-backs</span>
          <label className="flex items-center gap-1.5 text-hud-dim">From round
            <input className={clsx(cell, '!w-16')} type="number" min="2" max="20" step="1" disabled={!s.coderEscalation}
              defaultValue={s.coderEscalation?.fromRound ?? 3} key={`ce-${s.coderEscalation?.fromRound}`}
              onBlur={(e) => { const n = num(e.target.value, 2); if (s.coderEscalation && n !== null && n !== s.coderEscalation.fromRound) void save({ coderEscalation: { ...s.coderEscalation, fromRound: Math.round(n) } }, 'Escalation'); }} />
          </label>
          <select aria-label="Escalation model" className={cell} value={s.coderEscalation?.model ?? ''}
            onChange={(e) => void save({ coderEscalation: e.target.value ? { fromRound: s.coderEscalation?.fromRound ?? 3, model: e.target.value } : null }, 'Escalation')}>
            <option value="">off</option>
            {data.models.map((m) => <option key={m} value={m}>{modelName(m)}</option>)}
          </select>
        </div>
      </Card>
      </Section>

      <Section title="Dependency installs">
      <Card padding="none">
        <label className="block p-4 text-sm">
          <span className="font-medium text-hud-bright">Hosts an install may reach</span>
          <span className="mb-2 mt-0.5 block text-xs text-hud-dim">
            When your own node_modules cannot be reused, a project's install command runs in the sandbox and can reach only these hosts. Separate them with commas.
          </span>
          <input className={clsx(cell, '!w-full font-mono text-xs')} defaultValue={s.installDomains.join(', ')} key={`id-${s.installDomains.join(',')}`}
            onBlur={(e) => {
              const hosts = e.target.value.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
              if (hosts.join(',') !== s.installDomains.join(',')) void save({ installDomains: hosts }, 'Install hosts');
            }} />
        </label>
      </Card>
      </Section>

      <Section title="Alerts">
      <Card padding="none">
        <label className="flex items-start gap-3 p-4 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 rounded accent-hud-cyan" checked={s.alerts.mac} onChange={(e) => void save({ alerts: { mac: e.target.checked } }, 'Desktop notifications')} />
          <span>
            <span className="font-medium text-hud-bright">Desktop notifications</span>
            <span className="mt-0.5 block text-xs text-hud-dim">
              When a task asks you something, waits for your decision, stops, fails or is deployed. A toast in this app always appears, and the Chat space gets the same message when it is set up.
            </span>
          </span>
        </label>
      </Card>
      </Section>

      <div>
        <Button variant="secondary" size="sm" icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />} onClick={() => void save(data.defaults, 'Defaults')}>Back to defaults</Button>
      </div>

      {info && (
        <Section title="This install">
          <Card padding="none" className="divide-y divide-hud-border text-sm">
            {([
              ['Version', info.version],
              ['State folder', info.home],
              ['Claude Code CLI', info.claudeBin],
              ['Agents sign in with', info.agentAuth === 'api_key' ? 'an API key (ANTHROPIC_API_KEY)' : "the Claude Code CLI's own login"],
              ['Platform', info.platform],
            ] as Array<[string, string]>).map(([label, value]) => (
              <div key={label} className="flex flex-wrap gap-x-3 gap-y-0.5 p-4">
                <span className="w-52 flex-shrink-0 text-hud-dim">{label}</span>
                <span className={clsx('min-w-0 flex-1 break-all text-hud-bright', ['State folder', 'Claude Code CLI'].includes(label) && 'font-mono text-xs')}>{value}</span>
              </div>
            ))}
          </Card>
        </Section>
      )}
    </div>
  );
}
