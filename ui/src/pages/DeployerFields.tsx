/**
 * How a project's staging branch is deployed: the Jenkins job, the parameter that names
 * the branch, and the stage that counts as the staging deploy. Part of the project form.
 */

import { useState } from 'react';
import clsx from 'clsx';
import { Field } from '../ui';

export interface Deployer {
  job: string;
  branchParam: string | null;
  params: Record<string, string>;
  stage: string | null;
  timeoutMinutes: number;
}

const empty = (): Deployer => ({ job: '', branchParam: 'BRANCH', params: {}, stage: null, timeoutMinutes: 60 });
const toText = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join('\n');
function fromText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function describeDeployer(kind: string | null, d: Deployer | null): string {
  if (kind !== 'jenkins' || !d) return 'yourself';
  return `Jenkins · ${d.job}${d.stage ? ` · until "${d.stage}"` : ''}`;
}

export default function DeployerFields({ kind, value, hasStaging, onChange }: {
  kind: string | null;
  value: Deployer | null;
  hasStaging: boolean;
  onChange: (kind: string | null, value: Deployer | null) => void;
}) {
  const on = kind === 'jenkins';
  const d = value ?? empty();
  const set = (change: Partial<Deployer>) => onChange('jenkins', { ...d, ...change });
  const [paramsText, setParamsText] = useState(() => toText(d.params));
  const code = 'font-mono text-xs';

  return (
    <fieldset className="rounded-xl border border-hud-border p-4 space-y-3">
      <legend className="px-1.5 text-sm font-semibold text-hud-bright">Deploying staging</legend>
      <label className={clsx('flex items-start gap-2 text-sm text-hud-bright', !hasStaging && 'opacity-60')}>
        <input type="checkbox" className="mt-0.5 h-4 w-4 rounded accent-hud-cyan" checked={on} disabled={!hasStaging} onChange={(e) => onChange(e.target.checked ? 'jenkins' : null, e.target.checked ? d : null)} />
        <span>
          After a merge into staging, offer to deploy it with a Jenkins job.{' '}
          <span className="text-hud-dim">{hasStaging ? 'Every deploy still needs your yes. Set up Jenkins itself on the Connections page.' : 'Give the project a staging branch first.'}</span>
        </span>
      </label>
      {on && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Jenkins job" className={code} value={d.job} placeholder="team/service-deploy" onChange={(e) => set({ job: e.target.value })}
              hint="With its folders, as in the job's address." />
            <Field label="Parameter that names the branch" className={code} value={d.branchParam ?? ''} placeholder="none: the job always builds staging"
              onChange={(e) => set({ branchParam: e.target.value.trim() || null })} hint="FryDay sets it to the staging branch." />
            <Field label="Stage that is the staging deploy" className={code} value={d.stage ?? ''} placeholder="e.g. Deploy to STG; empty: the whole build"
              onChange={(e) => set({ stage: e.target.value.trim() || null })} hint="Once it succeeds the deploy is done; later stages (production) are not FryDay's." />
            <Field label="Follow it for at most (minutes)" inputMode="numeric" value={d.timeoutMinutes}
              onChange={(e) => { const n = parseInt(e.target.value, 10); set({ timeoutMinutes: Number.isFinite(n) ? n : 60 }); }} />
          </div>
          <Field as="textarea" label="Other parameters (NAME=value, one per line)" className={`${code} h-16`} value={paramsText} placeholder="ENV=stg"
            onChange={(e) => { setParamsText(e.target.value); set({ params: fromText(e.target.value) }); }} hint="Stored and shown as they are: not for secrets." />
        </>
      )}
    </fieldset>
  );
}
