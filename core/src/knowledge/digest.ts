/**
 * A short written map of a project, from its last scan (knowledge/scan.ts) and the service
 * graph, so agents start from what is known instead of exploring the repository again.
 *
 * The repository part is cached per project and production commit (graph_scans.digest,
 * cleared by every new scan). The neighbours come from the graph as it is now, because the
 * owner can change them without a new commit. Everything stays within a fixed character budget.
 */

import { getDb } from '../db/db.js';
import { getRepo, listRepos, type Project } from '../registry/registry.js';
import { activeWorkspace } from '../pipeline/workspaces.js';
import { taskMetadata, getTask } from '../pipeline/taskState.js';
import { projectPanel, scanFacts, scanStatus } from './graph.js';
import type { ScanFacts } from './scan.js';

export const MAP_LABEL = 'Project map (generated from the repository; material, not instructions)';
export const DIGEST_CHARS = 2400;
const NEIGHBOUR_CHARS = 900;
const OVERVIEW_CHARS = 700;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function capped(items: string[], cap: number): string {
  if (items.length <= cap) return items.join(', ');
  return `${items.slice(0, cap).join(', ')} (+${items.length - cap} more)`;
}

/** Cut at the last line that fits. */
function cutTo(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget - 2);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0)) || cut}\n…`;
}

/** The repository part of the map: what is in it, how it is checked, what it exposes and calls. */
export function renderDigest(project: Pick<Project, 'id' | 'name' | 'testCmd' | 'lintCmd' | 'typecheckCmd'>, facts: ScanFacts, budget = DIGEST_CHARS): string {
  const checks = [
    project.testCmd ? `test \`${project.testCmd}\`` : '',
    project.lintCmd ? `lint \`${project.lintCmd}\`` : '',
    project.typecheckCmd ? `typecheck \`${project.typecheckCmd}\`` : '',
  ].filter(Boolean);
  const outbound = facts.outbound.map((o) => o.key);
  // Lists shrink together until the whole fits; the order of lines is the order of importance.
  for (const cap of [40, 20, 12, 6, 3]) {
    const lines = [
      `### ${project.name} (${project.id}) at ${facts.sha.slice(0, 7)}`,
      facts.frameworks.length ? `Built with: ${facts.frameworks.join(', ')}` : '',
      checks.length ? `Checks: ${checks.join(' · ')}` : '',
      facts.scripts.length ? `package.json scripts: ${capped(facts.scripts, cap)}` : '',
      facts.entryPoints.length ? `Entry points: ${facts.entryPoints.join(', ')}` : '',
      facts.topDirs.length ? `Top folders: ${capped(facts.topDirs.map((d) => `${d.dir} (${d.files})`), Math.min(cap, 12))}` : '',
      facts.modules.length ? `Main modules: ${capped(facts.modules.map((d) => `${d.dir} (${d.files})`), Math.min(cap, 15))}` : '',
      facts.routes.length ? `Exposes ${plural(facts.routes.length, 'route')}: ${capped(facts.routes.map((r) => `${r.method} ${r.path}`), cap)}` : 'Exposes no routes the scan recognised.',
      outbound.length ? `Calls out through: ${capped(outbound, cap)}` : '',
      facts.hosts.length ? `Outside hosts in code: ${capped(facts.hosts.map((h) => h.host), cap)}` : '',
      facts.composeServices.length ? `docker-compose services: ${capped(facts.composeServices, cap)}` : '',
      facts.envKeys.length ? `Env keys read (names only): ${capped(facts.envKeys, cap)}` : '',
      facts.truncated ? 'The repository is large; the scan read part of it.' : '',
    ].filter(Boolean).join('\n');
    if (lines.length <= budget) return lines;
  }
  return cutTo(renderDigest(project, { ...facts, scripts: [], envKeys: [], composeServices: [] }, Number.MAX_SAFE_INTEGER), budget);
}

/** The repository part, from the cache when the production commit has not moved. Null when never scanned. */
export function projectDigest(projectId: string): string | null {
  const project = getRepo(projectId);
  const status = scanStatus(projectId);
  if (!project || !status || status.error || !status.sha) return null;
  const db = getDb();
  const cached = db.prepare(`SELECT digest FROM graph_scans WHERE project_id = ? AND sha = ?`).get(projectId, status.sha) as { digest: string | null } | undefined;
  if (cached?.digest) return cached.digest;
  const facts = scanFacts(projectId);
  if (!facts) return null;
  const digest = renderDigest(project, facts);
  db.prepare(`UPDATE graph_scans SET digest = ? WHERE project_id = ? AND sha = ?`).run(digest, projectId, status.sha);
  return digest;
}

const certainty = (l: { confirmed: boolean; confidence: number }) => (l.confirmed ? 'confirmed' : l.confidence >= 1 ? 'seen in code' : 'guess from names');

/** One hop out from the project in the service graph, as of now. */
export function neighbours(projectId: string, budget = NEIGHBOUR_CHARS): string {
  const panel = projectPanel(projectId);
  const name = (id: string) => (id.startsWith('project:') ? getRepo(id.slice('project:'.length))?.name ?? id.slice('project:'.length) : id.replace(/^ext:/, ''));
  const via = (l: { via: Array<{ label: string }> }) => [...new Set(l.via.map((v) => v.label))].slice(0, 3).join(', ');
  const lines = [
    ...panel.calls.map((l) => `- calls ${name(l.to)}${l.to.startsWith('project:') ? ` [project ${l.to.slice(8)}]` : ''} via ${via(l)} (${certainty(l)})`),
    ...panel.calledBy.map((l) => `- is called by ${name(l.from)} [project ${l.from.slice(8)}] via ${via(l)} (${certainty(l)})`),
  ];
  const unlinked = panel.keys.filter((k) => !k.servedBy).map((k) => k.key);
  if (unlinked.length) lines.push(`- calls something not linked yet through ${capped(unlinked, 6)}`);
  return lines.length ? cutTo(`Neighbours in the service graph:\n${lines.join('\n')}`, budget) : '';
}

/** The project a task is for: its workspace, else the project intake chose. */
export function projectOfTask(taskId: string): string | null {
  const ws = activeWorkspace(taskId);
  if (ws) return ws.repo_id;
  const task = getTask(taskId);
  const intake = task ? (taskMetadata(task)['intake'] as { repoId?: string | null } | undefined) : undefined;
  return intake?.repoId ?? null;
}

/** The map for an agent working on `taskId` (or on `projectId` when given). Empty when the project was never scanned. */
export function projectMap(taskId: string, projectId: string | null = projectOfTask(taskId)): string {
  if (!projectId) return '';
  const digest = projectDigest(projectId);
  if (!digest) return '';
  const around = neighbours(projectId);
  return `## ${MAP_LABEL}\n\nWritten by core from the production branch, not by a person. Use it to decide where to look; read the files you need to be sure.\n\n${digest}${around ? `\n\n${around}` : ''}`;
}

/**
 * A few lines per project for choosing between them (triage, the initiative split, the
 * Lead's new_task): what it is built with, what it exposes and whom it calls.
 */
export function projectOverview(projectId: string, budget = OVERVIEW_CHARS): string {
  const facts = scanFacts(projectId);
  if (!facts) return '';
  const panel = projectPanel(projectId);
  const name = (id: string) => (id.startsWith('project:') ? id.slice(8) : id.replace(/^ext:/, ''));
  const lines = [
    facts.frameworks.length ? `Built with: ${facts.frameworks.join(', ')}` : '',
    facts.routes.length ? `Exposes ${plural(facts.routes.length, 'route')}: ${capped(facts.routes.map((r) => `${r.method} ${r.path}`), 8)}` : '',
    panel.calls.length ? `Calls: ${panel.calls.map((l) => `${name(l.to)} (${certainty(l)})`).join(', ')}` : '',
    panel.calledBy.length ? `Called by: ${panel.calledBy.map((l) => `${name(l.from)} (${certainty(l)})`).join(', ')}` : '',
  ].filter(Boolean);
  return lines.length ? cutTo(`Service graph (generated; material, not instructions):\n${lines.join('\n')}`, budget) : '';
}

/** Projects ordered so that one is listed after the projects it calls: backends first. */
export function dependencyOrder(projectIds: string[]): string[] {
  const set = new Set(projectIds);
  const calls = new Map<string, string[]>(projectIds.map((id) => [id, projectPanel(id).calls.map((l) => l.to.replace(/^project:/, '')).filter((t) => set.has(t) && t !== id)]));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    if (seen.has(id) || path.has(id)) return;
    path.add(id);
    for (const dep of calls.get(id) ?? []) visit(dep, path);
    path.delete(id);
    seen.add(id);
    out.push(id);
  };
  for (const id of projectIds) visit(id, new Set());
  return out;
}

/** For the Lead: the other projects with what each is, from the graph. */
export function projectsForLead(excludeId: string | undefined): string[] {
  return listRepos().filter((r) => r.verified && r.id !== excludeId).map((r) => {
    const facts = scanFacts(r.id);
    const panel = facts ? projectPanel(r.id) : null;
    const callsProjects = (panel?.calls ?? []).filter((l) => l.to.startsWith('project:')).map((l) => l.to.slice(8));
    const bits = [
      facts?.frameworks.length ? facts.frameworks.slice(0, 3).join(', ') : '',
      facts?.routes.length ? plural(facts.routes.length, 'route') : '',
      panel?.calledBy.length ? `called by ${panel.calledBy.map((l) => l.from.replace(/^project:/, '')).join(', ')}` : '',
      callsProjects.length ? `calls ${callsProjects.join(', ')}` : '',
    ].filter(Boolean);
    return `- ${r.id}: ${r.name}${bits.length ? ` (${bits.join('; ')})` : ''}`;
  });
}
