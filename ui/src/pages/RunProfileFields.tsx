/**
 * The run profile of a project: how FryDay Code starts it as a running service so the
 * API tester and the UI tester can use it. Part of the project form.
 */

import { useState } from 'react';
import { Field } from '../ui';

export interface RunProfile {
  command: string;
  port: number | null;
  readyPath: string;
  readyTimeoutSec: number;
  env: Record<string, string>;
  envFile: string | null;
  api: boolean;
  ui: boolean;
  uiPath: string;
}

export const emptyRunProfile = (): RunProfile => ({
  command: '', port: null, readyPath: '/', readyTimeoutSec: 60, env: {}, envFile: null, api: true, ui: false, uiPath: '/',
});

const envToText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

/** One line that says what the profile does, for the project list. */
export function describeRunProfile(profile: RunProfile | null): string {
  if (!profile) return 'not run';
  const testers = [profile.api ? 'App tester' : '', profile.ui ? 'Page tester' : ''].filter(Boolean).join(' + ');
  return `${profile.command} · ${testers}`;
}

export default function RunProfileFields({ value, onChange }: { value: RunProfile | null; onChange: (next: RunProfile | null) => void }) {
  const set = (change: Partial<RunProfile>) => onChange({ ...(value ?? emptyRunProfile()), ...change });
  // The text as typed: a half-written line is not a value yet, but must not vanish.
  const [envText, setEnvText] = useState(() => envToText(value?.env ?? {}));
  const code = 'font-mono text-xs';
  const check = 'mt-0.5 h-4 w-4 rounded accent-hud-cyan';

  return (
    <fieldset className="rounded-xl border border-hud-border p-4 space-y-3">
      <legend className="px-1.5 text-sm font-semibold text-hud-bright">Trying it out running</legend>
      <label className="flex items-start gap-2 text-sm text-hud-bright">
        <input type="checkbox" className={check} checked={value !== null} onChange={(e) => onChange(e.target.checked ? emptyRunProfile() : null)} />
        <span>
          Start this project and have tester agents use it before I am asked to approve.{' '}
          <span className="text-hud-dim">Without this, a change is checked by the commands above and by review only.</span>
        </span>
      </label>

      {value && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Command that starts it" className={code} value={value.command} placeholder="npm start" onChange={(e) => set({ command: e.target.value })}
              hint="Run in the repository folder, in a sandbox: no internet, your home folder unreadable." />
            <Field label="Port" className={code} inputMode="numeric" value={value.port ?? ''} placeholder="empty: FryDay picks one and passes it as PORT"
              onChange={(e) => { const n = parseInt(e.target.value, 10); set({ port: Number.isFinite(n) ? n : null }); }}
              hint="Give a number only if the service cannot read its port from PORT." />
            <Field label="Path that answers when it is up" className={code} value={value.readyPath} placeholder="/" onChange={(e) => set({ readyPath: e.target.value })} />
            <Field label="Wait for it at most (seconds)" inputMode="numeric" value={value.readyTimeoutSec}
              onChange={(e) => { const n = parseInt(e.target.value, 10); set({ readyTimeoutSec: Number.isFinite(n) ? n : 60 }); }} />
          </div>

          <div className="space-y-2 text-sm text-hud-bright">
            <label className="flex items-start gap-2">
              <input type="checkbox" className={check} checked={value.api} onChange={(e) => set({ api: e.target.checked })} />
              <span>App tester <span className="text-hud-dim">sends requests to it and checks the answers; it can also read data you grant it on the Connections page.</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className={check} checked={value.ui} onChange={(e) => set({ ui: e.target.checked })} />
              <span>Page tester <span className="text-hud-dim">opens its pages in Chrome, clicks through them and takes screenshots. The browser can open this service only, so fonts or scripts loaded from other sites will be missing.</span></span>
            </label>
          </div>
          {value.ui && (
            <Field label="Page the tester starts on" className={code} wrapperClassName="sm:w-1/2" value={value.uiPath} placeholder="/" onChange={(e) => set({ uiPath: e.target.value })} />
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field as="textarea" label="Environment values (NAME=value, one per line)" className={`${code} h-20`} value={envText} placeholder={'NODE_ENV=test\nDATABASE_URL=file:./dev.db'}
              onChange={(e) => { setEnvText(e.target.value); set({ env: textToEnv(e.target.value) }); }}
              hint="Stored and shown as they are: not for secrets." />
            <Field label="File with local values" className={code} value={value.envFile ?? ''} placeholder="none, for example .env.test"
              onChange={(e) => set({ envFile: e.target.value.trim() ? e.target.value.trim() : null })}
              hint="NAME=value lines, read when the service starts and never copied to an agent. Use local or test values only: the code under test can read them." />
          </div>
        </>
      )}
    </fieldset>
  );
}
