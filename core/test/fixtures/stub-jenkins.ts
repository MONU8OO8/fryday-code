/**
 * A stand-in Jenkins for tests and the deploy check: a real HTTP server on this machine
 * that speaks the parts of the Jenkins API FryDay uses, with jobs whose pipelines are
 * scripted. It records every request, so a test can show what FryDay did — and did not —
 * ask Jenkins to do.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubStage {
  name: string;
  /** Pause here for a prompt before the stage runs. */
  input?: { id: string; message: string; proceedText?: string; parameters?: boolean };
  /** How the stage ends. Default SUCCESS. */
  result?: 'SUCCESS' | 'FAILED';
}

export interface StubJob {
  /** "folder/job" */
  name: string;
  stages: StubStage[];
  /** The commit the build says it checked out; a function of the parameters it got. */
  builtSha: (params: Record<string, string>) => string | null;
  /** How many looks a queue item stays queued before it becomes a build. */
  queueLooks?: number;
  /** How many looks each stage takes. */
  stageLooks?: number;
  parameters?: Array<{ name: string; defaultValue: string }>;
  /** Cancel queue items instead of starting them. */
  cancelInQueue?: boolean;
  /** The Git remote its last build checked out, as the whole-server listing reports it. */
  remote?: string;
  /** The branch that build built ("stg"). */
  lastBranch?: string;
}

interface Build {
  job: StubJob;
  number: number;
  params: Record<string, string>;
  stageIndex: number;
  looksInStage: number;
  waitingInput: boolean;
  answered: Set<string>;
  result: string | null;
  stageStatus: string[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
  auth: string | null;
  crumb: string | null;
}

export class StubJenkins {
  readonly requests: RecordedRequest[] = [];
  private server: http.Server | null = null;
  private jobs = new Map<string, StubJob>();
  private queue = new Map<number, { job: StubJob; params: Record<string, string>; looks: number; build: number | null }>();
  private builds = new Map<string, Build>();
  private nextQueue = 10;
  private nextBuild = new Map<string, number>();
  readonly user = 'fryday-test';
  readonly token = 'stub-token-not-a-real-credential';
  readonly crumb = 'stub-crumb-value';
  readonly sessionCookie = 'JSESSIONID.stub=stub-session-value';
  /**
   * Like a real Jenkins signed in with a password: the crumb belongs to the session it was
   * issued to, so a POST carrying the crumb without that session cookie is refused.
   */
  requireSessionWithCrumb = false;
  /** Set to make every answer a redirect to another host, to prove it is not followed. */
  redirectEverythingTo: string | null = null;
  /** The Location the trigger answers with; default a proper queue item on this server. */
  locationOverride: ((queueId: number) => string) | null = null;
  port = 0;

  addJob(job: StubJob): void {
    this.jobs.set(job.name, job);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** What FryDay asked Jenkins to do that changes something. */
  get actions(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === 'POST');
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => this.handle(req, res, body));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  stop(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private jobFromPath(path: string): { job: StubJob; rest: string } | null {
    const m = path.match(/^((?:\/job\/[^/]+)+)(\/.*)?$/);
    if (!m) return null;
    const name = m[1]!.split('/job/').filter(Boolean).map(decodeURIComponent).join('/');
    const job = this.jobs.get(name);
    return job ? { job, rest: m[2] ?? '/' } : null;
  }

  private json(res: http.ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  }

  /** Move a build on by one look. */
  private advance(b: Build): void {
    if (b.result) return;
    const stage = b.job.stages[b.stageIndex];
    if (!stage) { b.result = 'SUCCESS'; return; }
    if (stage.input && !b.answered.has(stage.input.id)) {
      b.waitingInput = true;
      b.stageStatus[b.stageIndex] = 'PAUSED_PENDING_INPUT';
      return;
    }
    b.waitingInput = false;
    b.stageStatus[b.stageIndex] = 'IN_PROGRESS';
    b.looksInStage++;
    if (b.looksInStage >= (b.job.stageLooks ?? 1)) {
      const result = stage.result ?? 'SUCCESS';
      b.stageStatus[b.stageIndex] = result;
      b.looksInStage = 0;
      if (result === 'FAILED') { b.result = 'FAILURE'; return; }
      b.stageIndex++;
      if (b.stageIndex >= b.job.stages.length) b.result = 'SUCCESS';
    }
  }

  private listing(prefix: string): unknown[] {
    const heads = [...new Set([...this.jobs.keys()].filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length).split('/')[0]!))];
    return heads.map((name) => {
      const job = this.jobs.get(`${prefix}${name}`);
      if (!job) return { name, jobs: this.listing(`${prefix}${name}/`) };
      const data = job.remote ? { actions: [{ remoteUrls: [job.remote], lastBuiltRevision: { branch: job.lastBranch ? [{ name: `refs/remotes/origin/${job.lastBranch}` }] : [] } }] } : null;
      return { name, buildable: true, property: job.parameters ? [{ parameterDefinitions: job.parameters.map((p) => ({ name: p.name })) }] : [], lastBuild: data, lastSuccessfulBuild: data };
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const url = new URL(req.url ?? '/', this.url);
    const path = url.pathname;
    this.requests.push({ method: req.method ?? 'GET', path, body, auth: req.headers.authorization ?? null, crumb: (req.headers['jenkins-crumb'] as string | undefined) ?? null });
    if (this.redirectEverythingTo) {
      res.writeHead(302, { location: this.redirectEverythingTo });
      res.end();
      return;
    }
    const expected = `Basic ${Buffer.from(`${this.user}:${this.token}`).toString('base64')}`;
    if (req.headers.authorization !== expected) { this.json(res, 401, { error: 'unauthorized' }); return; }
    if (path === '/crumbIssuer/api/json') {
      res.setHeader('set-cookie', `${this.sessionCookie}; Path=/; HttpOnly`);
      this.json(res, 200, { crumbRequestField: 'Jenkins-Crumb', crumb: this.crumb });
      return;
    }
    if (req.method === 'POST' && req.headers['jenkins-crumb'] !== this.crumb) { this.json(res, 403, { error: 'No valid crumb' }); return; }
    if (req.method === 'POST' && this.requireSessionWithCrumb && !(req.headers.cookie ?? '').includes(this.sessionCookie)) {
      this.json(res, 403, { error: 'No valid crumb (the crumb is not for this session)' });
      return;
    }
    if (path === '/me/api/json') { this.json(res, 200, { id: this.user, fullName: 'FryDay Test' }); return; }

    // The whole server: folders with their jobs, and what each job's last build checked out.
    if (path === '/api/json') { this.json(res, 200, { jobs: this.listing('') }); return; }

    const q = path.match(/^\/queue\/item\/(\d+)\/api\/json$/);
    if (q) {
      const item = this.queue.get(Number(q[1]));
      if (!item) { this.json(res, 404, {}); return; }
      if (item.job.cancelInQueue) { this.json(res, 200, { cancelled: true, why: null, executable: null }); return; }
      item.looks++;
      if (item.build === null && item.looks > (item.job.queueLooks ?? 1)) {
        const n = (this.nextBuild.get(item.job.name) ?? 100) + 1;
        this.nextBuild.set(item.job.name, n);
        item.build = n;
        this.builds.set(`${item.job.name}#${n}`, { job: item.job, number: n, params: item.params, stageIndex: 0, looksInStage: 0, waitingInput: false, answered: new Set(), result: null, stageStatus: item.job.stages.map(() => 'NOT_EXECUTED') });
      }
      this.json(res, 200, { cancelled: false, why: item.build === null ? 'Waiting for next available executor' : null, executable: item.build === null ? null : { number: item.build, url: `${this.url}/job/x/${item.build}/` } });
      return;
    }

    // A folder lists the jobs inside it, as Jenkins does: that is how a name that is not there
    // can be answered with the names that are.
    const folder = path.match(/^((?:\/job\/[^/]+)+)\/api\/json$/);
    if (folder && !this.jobFromPath(path)) {
      const prefix = folder[1]!.split('/job/').filter(Boolean).map(decodeURIComponent).join('/');
      const inside = [...this.jobs.keys()].filter((n) => n.startsWith(`${prefix}/`)).map((n) => n.slice(prefix.length + 1).split('/')[0]);
      if (inside.length > 0) { this.json(res, 200, { jobs: [...new Set(inside)].map((name) => ({ name })) }); return; }
    }
    const found = this.jobFromPath(path);
    if (!found) { this.json(res, 404, { error: 'no such job' }); return; }
    const { job, rest } = found;
    if (rest === '/api/json') {
      this.json(res, 200, { fullName: job.name, url: `${this.url}${path.replace(/api\/json$/, '')}`, buildable: true, property: job.parameters ? [{ parameterDefinitions: job.parameters.map((p) => ({ name: p.name, type: 'StringParameterDefinition', defaultParameterValue: { value: p.defaultValue } })) }] : [] });
      return;
    }
    if (req.method === 'POST' && (rest === '/build' || rest === '/buildWithParameters')) {
      const params = Object.fromEntries(new URLSearchParams(body));
      const id = this.nextQueue++;
      this.queue.set(id, { job, params, looks: 0, build: null });
      res.writeHead(201, { location: this.locationOverride ? this.locationOverride(id) : `${this.url}/queue/item/${id}/` });
      res.end();
      return;
    }
    const b = rest.match(/^\/(\d+)(\/.*)$/);
    const build = b ? this.builds.get(`${job.name}#${b[1]}`) : undefined;
    if (!b || !build) { this.json(res, 404, {}); return; }
    const sub = b[2]!;
    if (sub === '/api/json') {
      this.advance(build);
      const sha = build.job.builtSha(build.params);
      this.json(res, 200, {
        number: build.number, building: build.result === null, result: build.result, url: `${this.url}${path.replace(/api\/json$/, '')}`,
        actions: [{ _class: 'hudson.model.CauseAction' }, ...(sha ? [{ _class: 'hudson.plugins.git.util.BuildData', lastBuiltRevision: { SHA1: sha }, buildsByBranchName: { [`origin/${build.params['BRANCH'] ?? 'stg'}`]: { revision: { SHA1: sha } } } }] : []), null],
      });
      return;
    }
    if (sub === '/wfapi/describe') {
      const status = build.result === 'SUCCESS' ? 'SUCCESS' : build.result ? 'FAILED' : build.waitingInput ? 'PAUSED_PENDING_INPUT' : 'IN_PROGRESS';
      this.json(res, 200, { status, stages: build.job.stages.map((s, i) => ({ id: String(i + 1), name: s.name, status: build.stageStatus[i], durationMillis: 1000 })) });
      return;
    }
    if (sub === '/wfapi/pendingInputActions') {
      const stage = build.job.stages[build.stageIndex];
      this.json(res, 200, build.waitingInput && stage?.input ? [{ id: stage.input.id, message: stage.input.message, proceedText: stage.input.proceedText ?? 'Proceed', inputs: stage.input.parameters ? [{ name: 'X' }] : [] }] : []);
      return;
    }
    const input = sub.match(/^\/input\/([^/]+)\/proceedEmpty$/);
    if (req.method === 'POST' && input) {
      const stage = build.job.stages[build.stageIndex];
      if (!build.waitingInput || stage?.input?.id !== decodeURIComponent(input[1]!)) { this.json(res, 404, {}); return; }
      build.answered.add(stage.input.id);
      build.waitingInput = false;
      res.writeHead(200);
      res.end();
      return;
    }
    this.json(res, 404, {});
  }
}
