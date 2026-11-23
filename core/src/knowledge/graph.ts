/**
 * The service graph: which project exposes what and calls whom.
 *
 * A scan (knowledge/scan.ts) writes rows with source 'scan'. Everything the owner does
 * (confirm, rename, add, delete) writes source 'owner', and a rescan never touches those:
 * it deletes only its own rows and inserts with ON CONFLICT DO NOTHING, so an owner row,
 * or an owner deletion kept as a tombstone, wins.
 *
 * Which project an env key such as CREDIT_SERVICE_URL points at is a guess from names, so
 * those edges carry a confidence below 1 and stay unconfirmed until the owner says so.
 */

import { getDb, nowMs } from '../db/db.js';
import { getRepo, listRepos, type Project } from '../registry/registry.js';
import { sseEmit } from '../api/events.js';
import { shortenPaths } from '../runner/runEvents.js';
import { cleanLabel, productionSha, scanRepository, type ScanFacts } from './scan.js';
import { indexProject } from './index/indexer.js';

export type NodeKind = 'project' | 'external_service' | 'endpoint' | 'env_key';
export type EdgeKind = 'calls' | 'exposes' | 'served_by';
type Source = 'scan' | 'owner';

export interface GraphNode { id: string; kind: NodeKind; projectId: string | null; label: string; source: Source; confidence: number; confirmed: boolean }
export interface GraphEdge { from: string; to: string; kind: EdgeKind; projectId: string | null; evidence: Array<{ file: string }>; source: Source; confidence: number; confirmed: boolean }

export const projectNode = (projectId: string) => `project:${projectId}`;
export const endpointNode = (projectId: string, method: string, path: string) => `endpoint:${projectId}:${method} ${path}`;
export const envNode = (projectId: string, key: string) => `env:${projectId}:${key}`;
export const extNode = (name: string) => `ext:${name.toLowerCase()}`;

// ─── Matching an env key to a project ─────────────────────────────────────────

/** Words in a key name that say how, not what: CREDIT_SERVICE_BASE_URL is about "credit service". */
const NOISE = new Set(['url', 'urls', 'host', 'hostname', 'base', 'uri', 'endpoint', 'http', 'https', 'next', 'public', 'vite', 'react', 'app', 'env', 'internal', 'external', 'port', 'domain', 'addr', 'address']);
/** Words that say little on their own: matching only on "service" is not a match. */
const GENERIC = new Set(['service', 'services', 'svc', 'api', 'backend', 'server', 'web', 'frontend', 'fe', 'be', 'core', 'layer', 'common']);

const DATASTORES: Array<[RegExp, string]> = [
  [/^redis$/, 'Redis'], [/^(mongo|mongodb|docdb)$/, 'MongoDB'], [/^mysql$/, 'MySQL'], [/^(postgres|postgresql|pg)$/, 'PostgreSQL'],
  [/^(database|db)$/, 'Database'], [/^(rabbit|rabbitmq|amqp)$/, 'RabbitMQ'], [/^kafka$/, 'Kafka'], [/^(elastic|elasticsearch|opensearch)$/, 'Elasticsearch'],
  [/^sentry$/, 'Sentry'], [/^s3$/, 'S3'], [/^(smtp|mail)$/, 'Mail server'], [/^sqs$/, 'SQS'],
];

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export interface MatchCandidate { id: string; name: string }

/**
 * The project an outbound key most likely points at, with a confidence in (0, 0.9].
 * Null when nothing matches well enough or two projects match equally well.
 */
export function matchKey(key: string, projects: MatchCandidate[]): { projectId: string; confidence: number } | null {
  const keyTokens = [...new Set(tokens(key).filter((t) => !NOISE.has(t)))];
  if (keyTokens.length === 0) return null;
  // A project is named by its id and by its display name; each is scored on its own.
  const projectTokens = projects.map((p) => ({ id: p.id, names: [[...new Set(tokens(p.id))], [...new Set(tokens(p.name))]] }));
  // A word most projects share (a company prefix) tells them apart no better than "service".
  const shared = new Map<string, number>();
  for (const p of projectTokens) for (const t of new Set(p.names.flat())) shared.set(t, (shared.get(t) ?? 0) + 1);
  const weight = (t: string) => (GENERIC.has(t) ? 0.3 : projects.length >= 3 && (shared.get(t) ?? 0) * 2 >= projects.length ? 0.2 : 1);
  const sum = (ts: string[]) => ts.reduce((n, t) => n + weight(t), 0);
  const scoreOf = (name: string[]) => {
    const common = keyTokens.filter((t) => name.includes(t));
    // One generic word in common ("service") is chance; a distinctive word, or two words together ("common layer"), is a match.
    const enough = common.some((t) => weight(t) === 1) || common.length >= 2;
    return enough ? sum(common) / Math.max(sum(keyTokens), sum(name)) : 0;
  };
  const scored = projectTokens.map((p) => ({ id: p.id, score: Math.max(...p.names.map(scoreOf)) }))
    .filter((s) => s.score >= 0.5).sort((a, b) => b.score - a.score);
  if (scored.length === 0 || (scored.length > 1 && scored[0]!.score - scored[1]!.score < 0.05)) return null;
  return { projectId: scored[0]!.id, confidence: Math.round(Math.min(0.9, scored[0]!.score * 0.9) * 100) / 100 };
}

/** A datastore or well-known service the key names (REDIS_HOST: Redis). */
export function datastoreOf(key: string): string | null {
  for (const t of tokens(key)) for (const [re, name] of DATASTORES) if (re.test(t)) return name;
  return null;
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface NodeRow { id: string; kind: NodeKind; project_id: string | null; label: string; source: Source; confidence: number; confirmed: number }
interface EdgeRow { from_id: string; to_id: string; kind: EdgeKind; project_id: string | null; evidence_json: string | null; source: Source; confidence: number; confirmed: number; deleted: number }

const toNode = (r: NodeRow): GraphNode => ({ id: r.id, kind: r.kind, projectId: r.project_id, label: r.label, source: r.source, confidence: r.confidence, confirmed: r.confirmed === 1 });
const toEdge = (r: EdgeRow): GraphEdge => {
  let evidence: Array<{ file: string }> = [];
  try { evidence = r.evidence_json ? JSON.parse(r.evidence_json) : []; } catch { /* kept empty */ }
  return { from: r.from_id, to: r.to_id, kind: r.kind, projectId: r.project_id, evidence, source: r.source, confidence: r.confidence, confirmed: r.confirmed === 1 };
};

function insertScanNode(id: string, kind: NodeKind, projectId: string | null, label: string, confidence = 1): void {
  getDb().prepare(`INSERT INTO graph_nodes (id, kind, project_id, label, source, confidence, confirmed, updated_at)
    VALUES (?, ?, ?, ?, 'scan', ?, 0, ?) ON CONFLICT(id) DO NOTHING`).run(id, kind, projectId, cleanLabel(label), confidence, nowMs());
}

function insertScanEdge(from: string, to: string, kind: EdgeKind, projectId: string, files: string[], confidence = 1): void {
  const evidence = files.length ? JSON.stringify(files.slice(0, 5).map((file) => ({ file: cleanLabel(file, 200) }))) : null;
  getDb().prepare(`INSERT INTO graph_edges (from_id, to_id, kind, project_id, evidence_json, source, confidence, confirmed, deleted, updated_at)
    VALUES (?, ?, ?, ?, ?, 'scan', ?, 0, 0, ?) ON CONFLICT(from_id, to_id, kind) DO NOTHING`).run(from, to, kind, projectId, evidence, confidence, nowMs());
}

/** Replace a project's scanned rows with what `facts` says. Owner rows are left alone. */
export function applyScan(project: Pick<Project, 'id' | 'name'>, facts: ScanFacts): void {
  const db = getDb();
  const pid = project.id;
  db.transaction(() => {
    db.prepare(`DELETE FROM graph_edges WHERE project_id = ? AND source = 'scan'`).run(pid);
    db.prepare(`DELETE FROM graph_nodes WHERE project_id = ? AND source = 'scan'`).run(pid);
    const self = projectNode(pid);
    insertScanNode(self, 'project', pid, project.name);
    for (const r of facts.routes) {
      const id = endpointNode(pid, r.method, r.path);
      insertScanNode(id, 'endpoint', pid, `${r.method} ${r.path}`);
      insertScanEdge(self, id, 'exposes', pid, [r.file]);
    }
    for (const o of facts.outbound) {
      const id = envNode(pid, o.key);
      insertScanNode(id, 'env_key', pid, o.key);
      insertScanEdge(self, id, 'calls', pid, o.files);
    }
    for (const h of facts.hosts) {
      insertScanNode(extNode(h.host), 'external_service', null, h.host);
      insertScanEdge(self, extNode(h.host), 'calls', pid, h.files);
    }
    rematch();
    pruneOrphans();
  })();
}

/** Every registered project is on the graph, scanned or not, so it can be linked to. */
function ensureProjectNodes(projects: Array<{ id: string; name: string }> = listRepos()): void {
  for (const p of projects) insertScanNode(projectNode(p.id), 'project', p.id, p.name);
}

/** Guess again, for every project, which project or datastore each outbound key points at. */
export function rematch(): void {
  const db = getDb();
  const projects = listRepos().map((p) => ({ id: p.id, name: p.name }));
  ensureProjectNodes(projects);
  db.prepare(`DELETE FROM graph_edges WHERE kind = 'served_by' AND source = 'scan'`).run();
  const keys = db.prepare(`SELECT id, project_id, label FROM graph_nodes WHERE kind = 'env_key'`).all() as Array<{ id: string; project_id: string | null; label: string }>;
  const ownerSays = db.prepare(`SELECT 1 FROM graph_edges WHERE from_id = ? AND kind = 'served_by' AND source = 'owner' AND deleted = 0 LIMIT 1`);
  for (const k of keys) {
    if (!k.project_id || ownerSays.get(k.id)) continue;
    const match = matchKey(k.label, projects.filter((p) => p.id !== k.project_id));
    if (match) { insertScanEdge(k.id, projectNode(match.projectId), 'served_by', k.project_id, [], match.confidence); continue; }
    const store = datastoreOf(k.label);
    if (store) {
      insertScanNode(extNode(store), 'external_service', null, store);
      insertScanEdge(k.id, extNode(store), 'served_by', k.project_id, [], 0.6);
    }
  }
}

/** Outside services no live edge points at any more. */
function pruneOrphans(): void {
  getDb().prepare(`DELETE FROM graph_nodes WHERE kind = 'external_service' AND source = 'scan'
    AND id NOT IN (SELECT to_id FROM graph_edges WHERE deleted = 0) AND id NOT IN (SELECT from_id FROM graph_edges WHERE deleted = 0)`).run();
}

/** Forget a removed project: its nodes, its edges and the edges pointing at it. */
export function forgetProject(projectId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM graph_edges WHERE project_id = ? OR to_id = ?`).run(projectId, projectNode(projectId));
    db.prepare(`DELETE FROM graph_nodes WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM graph_scans WHERE project_id = ?`).run(projectId);
    pruneOrphans();
  })();
}

// ─── Owner edits ──────────────────────────────────────────────────────────────

export class GraphEditError extends Error {}

const nodeById = (id: string) => getDb().prepare(`SELECT * FROM graph_nodes WHERE id = ?`).get(id) as NodeRow | undefined;
const edgeRow = (from: string, to: string, kind: EdgeKind) =>
  getDb().prepare(`SELECT * FROM graph_edges WHERE from_id = ? AND to_id = ? AND kind = ?`).get(from, to, kind) as EdgeRow | undefined;

/** The owner says this edge is right. */
export function confirmEdge(from: string, to: string, kind: EdgeKind): GraphEdge {
  const row = edgeRow(from, to, kind);
  if (!row || row.deleted) throw new GraphEditError('No such link');
  getDb().prepare(`UPDATE graph_edges SET source = 'owner', confirmed = 1, confidence = 1, updated_at = ? WHERE from_id = ? AND to_id = ? AND kind = ?`).run(nowMs(), from, to, kind);
  return toEdge(edgeRow(from, to, kind)!);
}

/** The owner says this edge is wrong. It stays as a tombstone so a rescan does not bring it back. */
export function deleteEdge(from: string, to: string, kind: EdgeKind): void {
  const row = edgeRow(from, to, kind);
  if (!row) throw new GraphEditError('No such link');
  getDb().prepare(`UPDATE graph_edges SET source = 'owner', deleted = 1, confirmed = 0, updated_at = ? WHERE from_id = ? AND to_id = ? AND kind = ?`).run(nowMs(), from, to, kind);
  // A key the owner unlinked may now be better explained by another guess.
  if (kind === 'served_by') rematch();
  pruneOrphans();
}

/**
 * The owner adds a link: a project calls another project or an outside service, or an
 * env key is served by one. Re-adding a link the owner deleted brings it back.
 */
export function addEdge(from: string, to: string, kind: EdgeKind): GraphEdge {
  ensureProjectNodes();
  const a = nodeById(from);
  const b = nodeById(to);
  if (!a || !b) throw new GraphEditError('Both ends must be in the graph');
  if (from === to) throw new GraphEditError('A link needs two different ends');
  const allowed = (kind === 'calls' && a.kind === 'project' && (b.kind === 'project' || b.kind === 'external_service' || b.kind === 'endpoint'))
    || (kind === 'served_by' && a.kind === 'env_key' && (b.kind === 'project' || b.kind === 'external_service'));
  if (!allowed) throw new GraphEditError('That kind of link does not fit those two ends');
  getDb().prepare(`INSERT INTO graph_edges (from_id, to_id, kind, project_id, evidence_json, source, confidence, confirmed, deleted, updated_at)
    VALUES (?, ?, ?, ?, NULL, 'owner', 1, 1, 0, ?)
    ON CONFLICT(from_id, to_id, kind) DO UPDATE SET source = 'owner', confidence = 1, confirmed = 1, deleted = 0, updated_at = excluded.updated_at`)
    .run(from, to, kind, a.project_id, nowMs());
  if (kind === 'served_by') {
    // The owner said where this key goes; the guesses for it are dropped.
    getDb().prepare(`DELETE FROM graph_edges WHERE from_id = ? AND kind = 'served_by' AND source = 'scan'`).run(from);
    pruneOrphans();
  }
  return toEdge(edgeRow(from, to, kind)!);
}

/** The owner names a node. A rename is the owner's, so a rescan keeps it. */
export function renameNode(id: string, label: string): GraphNode {
  const clean = cleanLabel(label, 120);
  if (!clean) throw new GraphEditError('A name is needed');
  if (!nodeById(id)) throw new GraphEditError('No such node');
  getDb().prepare(`UPDATE graph_nodes SET label = ?, source = 'owner', confirmed = 1, updated_at = ? WHERE id = ?`).run(clean, nowMs(), id);
  return toNode(nodeById(id)!);
}

/** The owner adds an outside service the scan cannot see. */
export function addService(label: string): GraphNode {
  const clean = cleanLabel(label, 120);
  const slug = clean.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new GraphEditError('A name is needed');
  const id = extNode(slug);
  getDb().prepare(`INSERT INTO graph_nodes (id, kind, project_id, label, source, confidence, confirmed, updated_at)
    VALUES (?, 'external_service', NULL, ?, 'owner', 1, 1, ?)
    ON CONFLICT(id) DO UPDATE SET source = 'owner', confirmed = 1, label = excluded.label, updated_at = excluded.updated_at`).run(id, clean, nowMs());
  return toNode(nodeById(id)!);
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export interface ScanStatus { projectId: string; sha: string | null; scannedAt: number; error: string | null; truncated: boolean }

/** A project-to-service link, with the keys (or direct calls) it was seen through. */
export interface ServiceLink {
  from: string;
  to: string;
  confidence: number;
  confirmed: boolean;
  via: Array<{ from: string; to: string; kind: EdgeKind; label: string; source: Source; confidence: number; confirmed: boolean }>;
}

export function scanStatus(projectId: string): ScanStatus | null {
  const r = getDb().prepare(`SELECT project_id, sha, scanned_at, error, json_extract(facts_json, '$.truncated') AS truncated FROM graph_scans WHERE project_id = ?`).get(projectId) as
    { project_id: string; sha: string | null; scanned_at: number; error: string | null; truncated: number | null } | undefined;
  return r ? { projectId: r.project_id, sha: r.sha, scannedAt: r.scanned_at, error: r.error, truncated: r.truncated === 1 } : null;
}

export function scanFacts(projectId: string): ScanFacts | null {
  const r = getDb().prepare(`SELECT facts_json FROM graph_scans WHERE project_id = ? AND error IS NULL`).get(projectId) as { facts_json: string | null } | undefined;
  try { return r?.facts_json ? (JSON.parse(r.facts_json) as ScanFacts) : null; } catch { return null; }
}

export function allNodes(): GraphNode[] {
  return (getDb().prepare(`SELECT * FROM graph_nodes ORDER BY kind, label`).all() as NodeRow[]).map(toNode);
}

export function liveEdges(): GraphEdge[] {
  return (getDb().prepare(`SELECT * FROM graph_edges WHERE deleted = 0`).all() as EdgeRow[]).map(toEdge);
}

/** Project-level links: a project calls a project or service directly, or through a key served by it. */
export function serviceLinks(nodes = allNodes(), edges = liveEdges()): ServiceLink[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = new Map<string, ServiceLink>();
  const add = (from: string, to: string, step: GraphEdge, label: string, confidence: number, confirmed: boolean) => {
    const key = `${from}→${to}`;
    const link = links.get(key) ?? { from, to, confidence: 0, confirmed: false, via: [] };
    link.confidence = Math.max(link.confidence, confidence);
    link.confirmed ||= confirmed;
    link.via.push({ from: step.from, to: step.to, kind: step.kind, label, source: step.source, confidence: step.confidence, confirmed: step.confirmed });
    links.set(key, link);
  };
  const servedBy = new Map<string, GraphEdge[]>();
  for (const e of edges) if (e.kind === 'served_by') servedBy.set(e.from, [...(servedBy.get(e.from) ?? []), e]);
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    const target = byId.get(e.to);
    if (!target || !byId.has(e.from)) continue;
    if (target.kind === 'project' || target.kind === 'external_service') add(e.from, e.to, e, target.label, e.confidence, e.confirmed);
    else if (target.kind === 'endpoint' && target.projectId) add(e.from, projectNode(target.projectId), e, target.label, e.confidence, e.confirmed);
    else if (target.kind === 'env_key') {
      for (const s of servedBy.get(e.to) ?? []) {
        if (!byId.has(s.to)) continue;
        add(e.from, s.to, s, target.label, Math.min(e.confidence, s.confidence), s.confirmed);
      }
    }
  }
  return [...links.values()].filter((l) => l.from !== l.to);
}

/** What the Graph page shows. */
export function graphView() {
  ensureProjectNodes();
  const nodes = allNodes();
  const edges = liveEdges();
  const projects = listRepos().map((p) => ({ id: p.id, name: p.name, scan: scanStatus(p.id) }));
  return {
    projects,
    services: nodes.filter((n) => n.kind === 'project' || n.kind === 'external_service'),
    links: serviceLinks(nodes, edges),
    keys: nodes.filter((n) => n.kind === 'env_key'),
  };
}

/** What one project exposes and calls, for the side panel. */
export function projectPanel(projectId: string) {
  const nodes = allNodes();
  const edges = liveEdges();
  const self = projectNode(projectId);
  const links = serviceLinks(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const exposes = edges.filter((e) => e.from === self && e.kind === 'exposes').map((e) => byId.get(e.to)?.label).filter((x): x is string => !!x).sort();
  const keys = edges.filter((e) => e.from === self && e.kind === 'calls' && byId.get(e.to)?.kind === 'env_key').map((e) => {
    const target = edges.find((s) => s.from === e.to && s.kind === 'served_by');
    return { id: e.to, key: byId.get(e.to)!.label, servedBy: target ? { id: target.to, label: byId.get(target.to)?.label ?? target.to, confidence: target.confidence, confirmed: target.confirmed } : null };
  });
  const facts = scanFacts(projectId);
  return {
    projectId,
    scan: scanStatus(projectId),
    frameworks: facts?.frameworks ?? [],
    exposes,
    calls: links.filter((l) => l.from === self),
    calledBy: links.filter((l) => l.to === self),
    keys,
  };
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<ScanStatus | null>>();

/**
 * Scan a project's production commit when it has moved since the last scan (or always,
 * with `force`). A scan that cannot run is recorded with its reason, never as an empty graph.
 */
export function refreshProject(projectId: string, opts: { force?: boolean } = {}): Promise<ScanStatus | null> {
  const running = inFlight.get(projectId);
  if (running) return running;
  const job = (async () => {
    const project = getRepo(projectId);
    if (!project) return null;
    const db = getDb();
    const record = (sha: string | null, facts: ScanFacts | null, error: string | null) => {
      db.prepare(`INSERT INTO graph_scans (project_id, sha, scanned_at, facts_json, digest, error) VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT(project_id) DO UPDATE SET sha = excluded.sha, scanned_at = excluded.scanned_at, facts_json = excluded.facts_json, digest = NULL, error = excluded.error`)
        .run(projectId, sha, nowMs(), facts ? JSON.stringify(facts) : null, error ? cleanLabel(shortenPaths(error.split(project.localPath).join(project.name)), 300) : null);
    };
    let sha: string;
    try {
      sha = productionSha(project.localPath, project.prodBranch);
    } catch (err) {
      record(null, null, (err as Error).message);
      return scanStatus(projectId);
    }
    const last = scanStatus(projectId);
    if (!opts.force && last && last.sha === sha && !last.error) {
      // The scan is current; the index may not be yet (it came later). It does nothing when it is.
      if (process.env['FRYDAY_INDEX'] !== 'off') void indexProject(projectId).catch(() => null);
      return last;
    }
    try {
      const facts = await scanRepository(project.localPath, sha);
      applyScan(project, facts);
      record(sha, facts, null);
    } catch (err) {
      record(sha, null, `The scan could not read ${project.prodBranch}: ${(err as Error).message}`);
    }
    sseEmit({ type: 'graph_updated', projectId });
    // The code index follows the same commit; it reads only blobs it has not seen, in the background.
    if (process.env['FRYDAY_INDEX'] !== 'off') void indexProject(projectId).catch(() => null);
    return scanStatus(projectId);
  })().finally(() => inFlight.delete(projectId));
  inFlight.set(projectId, job);
  return job;
}

/** Refresh, but give up waiting after `ms`; the scan carries on in the background. */
export async function refreshWithin(projectId: string, ms: number): Promise<void> {
  await Promise.race([refreshProject(projectId).catch(() => null), new Promise((r) => setTimeout(r, ms).unref())]);
}

/** At startup: scan, one at a time, every project never scanned or whose production commit moved. */
export async function refreshAll(): Promise<void> {
  for (const p of listRepos()) {
    try {
      await refreshProject(p.id);
    } catch {
      /* recorded on the project's scan row; the next project still gets its turn */
    }
  }
}
