/**
 * A small Jenkins client: what FryDay needs to start a staging deploy and follow it.
 *
 *   job info and parameters · start a build · find the build a queued item became ·
 *   the build's result and the commit it built · the pipeline's stages · a pipeline's
 *   pending input (a "Proceed?" prompt) · answer such a prompt with Proceed
 *
 * Every request goes to the Jenkins the owner set up, and only there: an address
 * Jenkins hands back (a queue item, a build URL) is reduced to its path and joined to
 * that base, so a misconfigured or hostile Jenkins cannot send FryDay elsewhere with the
 * owner's credentials. Nothing here decides whether to deploy; deploy/deployFlow.ts does.
 */

export interface JenkinsCredentials {
  /** e.g. https://jenkins.example.com (a path prefix is kept: https://example.com/jenkins) */
  baseUrl: string;
  user: string;
  token: string;
}

export interface Transport {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
}

export class JenkinsError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
  }
}

export interface JobInfo {
  fullName: string;
  url: string;
  buildable: boolean;
  parameters: Array<{ name: string; type: string; defaultValue: string | null }>;
}

export interface QueueState {
  /** The build the item became, once it has started. */
  buildNumber: number | null;
  cancelled: boolean;
  /** Why it is still waiting, as Jenkins says it. */
  why: string | null;
}

export interface BuildState {
  number: number;
  building: boolean;
  /** SUCCESS | FAILURE | UNSTABLE | ABORTED | NOT_BUILT, or null while it runs. */
  result: string | null;
  url: string;
  /** The commit the build checked out, when Jenkins records it (git plugin). */
  builtSha: string | null;
  /** Every commit Jenkins says it built, per branch, for the commit check. */
  builtShas: string[];
}

export interface Stage {
  id: string;
  name: string;
  /** SUCCESS | FAILED | ABORTED | IN_PROGRESS | PAUSED_PENDING_INPUT | NOT_EXECUTED | UNSTABLE */
  status: string;
  durationMs: number;
}

export interface PipelineState {
  status: string;
  stages: Stage[];
}

export interface PendingInput {
  id: string;
  message: string;
  proceedText: string;
  /** An input with parameters cannot be answered with a plain Proceed. */
  hasParameters: boolean;
}

const JOB_PART = /^[^/\s][^/]*$/;

/** "folder/sub/job" → "/job/folder/job/sub/job/job" */
export function jobPath(job: string): string {
  const parts = job.trim().split('/');
  if (parts.length === 0 || !parts.every((p) => p.trim() === p && JOB_PART.test(p) && p !== '..' && p !== '.')) throw new JenkinsError(`"${job}" is not a Jenkins job name`);
  return parts.map((p) => `/job/${encodeURIComponent(p)}`).join('');
}

/** Check the base address the owner gave: https, or http only on this machine (for a local Jenkins or a test stand-in). */
export function normaliseBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new JenkinsError('The Jenkins address is not a URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new JenkinsError('The Jenkins address must be https (http only for a Jenkins on this machine)');
  if (url.username || url.password) throw new JenkinsError('Put the user and token in their own fields, not in the address');
  if (url.search || url.hash) throw new JenkinsError('The Jenkins address must not have a query or fragment');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export class JenkinsClient {
  private readonly base: URL;
  private crumb: { field: string; value: string } | null | undefined;
  /**
   * The session Jenkins started when it gave out the crumb. A crumb belongs to the session it
   * was issued to, so a POST that carries the crumb without the session is refused with 403.
   * (Signing in with a real API token is exempt from this; a password is not, which is why it
   * only bites some installs.) Cookies from Jenkins are kept here and sent back to it only.
   */
  private cookies = new Map<string, string>();

  constructor(private readonly creds: JenkinsCredentials, private readonly transport: Transport = (url, init) => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) })) {
    this.base = normaliseBase(creds.baseUrl);
  }

  /**
   * The full address for a path, or for an address Jenkins handed back. Only the path of
   * such an address is used, and it must lie under the configured base.
   */
  urlFor(pathOrUrl: string): string {
    let path = pathOrUrl;
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) {
      const given = new URL(pathOrUrl);
      path = given.pathname + given.search;
    }
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c/i.test(path.split('?')[0]!)) {
      throw new JenkinsError(`Refused an address from Jenkins: ${pathOrUrl}`);
    }
    const prefix = this.base.pathname === '/' ? '' : this.base.pathname;
    const full = new URL(prefix && !path.startsWith(`${prefix}/`) ? `${prefix}${path}` : path, this.base.origin);
    if (full.origin !== this.base.origin || (prefix && !full.pathname.startsWith(`${prefix}/`))) throw new JenkinsError(`Refused an address outside Jenkins: ${pathOrUrl}`);
    return full.href;
  }

  private auth(): string {
    return `Basic ${Buffer.from(`${this.creds.user}:${this.creds.token}`).toString('base64')}`;
  }

  /** Remember the cookies Jenkins set, so the crumb's session is still ours on the next call. */
  private keepCookies(res: { headers: { get(name: string): string | null; getSetCookie?: () => string[] } }): void {
    const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
    for (const line of all) {
      const pair = line.split(';')[0]?.trim();
      const at = pair ? pair.indexOf('=') : -1;
      if (pair && at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }

  private cookieHeader(): string | null {
    return this.cookies.size === 0 ? null : [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private async request(method: 'GET' | 'POST', pathOrUrl: string, body?: string, contentType?: string) {
    const headers: Record<string, string> = { Authorization: this.auth(), Accept: 'application/json' };
    if (contentType) headers['Content-Type'] = contentType;
    if (method === 'POST') {
      const crumb = await this.getCrumb();
      if (crumb) headers[crumb.field] = crumb.value;
    }
    const cookie = this.cookieHeader();
    if (cookie) headers['Cookie'] = cookie;
    let res;
    try {
      res = await this.transport(this.urlFor(pathOrUrl), { method, headers, body });
      this.keepCookies(res);
    } catch (err) {
      throw new JenkinsError(`Jenkins could not be reached: ${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)}`);
    }
    if (res.status === 401 || res.status === 403) throw new JenkinsError(`Jenkins refused the request (${res.status}): check the user and API token, and that this user may ${method === 'POST' ? 'build this job' : 'read it'}`, res.status);
    return res;
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.request('GET', path);
    if (res.status === 404) throw new JenkinsError(`Jenkins has nothing at ${path.split('?')[0]}`, 404);
    if (res.status >= 400) throw new JenkinsError(`Jenkins answered ${res.status} for ${path.split('?')[0]}`, res.status);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new JenkinsError(`Jenkins did not answer with JSON for ${path.split('?')[0]} (is the address right?)`);
    }
  }

  /** The CSRF crumb, when Jenkins uses one. Asked once. */
  private async getCrumb(): Promise<{ field: string; value: string } | null> {
    if (this.crumb !== undefined) return this.crumb;
    try {
      const res = await this.transport(this.urlFor('/crumbIssuer/api/json'), { method: 'GET', headers: { Authorization: this.auth(), Accept: 'application/json' } });
      // The session this crumb belongs to: without it the crumb is refused on the POST.
      this.keepCookies(res);
      if (res.status !== 200) { this.crumb = null; return null; }
      const c = JSON.parse(await res.text()) as { crumbRequestField?: unknown; crumb?: unknown };
      this.crumb = typeof c.crumbRequestField === 'string' && typeof c.crumb === 'string' ? { field: c.crumbRequestField, value: c.crumb } : null;
    } catch {
      this.crumb = null;
    }
    return this.crumb;
  }

  /** Who Jenkins thinks we are. A cheap check that the address and credentials work. */
  async whoAmI(): Promise<string> {
    const me = await this.json<{ id?: unknown; fullName?: unknown }>('/me/api/json?tree=id,fullName');
    return String(me.fullName ?? me.id ?? this.creds.user);
  }

  async jobInfo(job: string): Promise<JobInfo> {
    const raw = await this.json<{
      fullName?: string; url?: string; buildable?: boolean;
      property?: Array<{ parameterDefinitions?: Array<{ name: string; type: string; defaultParameterValue?: { value?: unknown } }> }>;
    }>(`${jobPath(job)}/api/json?tree=fullName,url,buildable,property[parameterDefinitions[name,type,defaultParameterValue[value]]]`);
    const defs = (raw.property ?? []).flatMap((p) => p.parameterDefinitions ?? []);
    return {
      fullName: raw.fullName ?? job,
      url: raw.url ?? '',
      buildable: raw.buildable !== false,
      parameters: defs.map((d) => ({ name: d.name, type: d.type, defaultValue: d.defaultParameterValue?.value === undefined ? null : String(d.defaultParameterValue.value) })),
    };
  }

  /**
   * The names of the jobs beside this one, for a job name that is not there. One request to the
   * folder holding it, so a typed name can be answered with the names that do exist.
   */
  async siblingJobs(job: string): Promise<string[]> {
    const parts = job.trim().split('/');
    const folder = parts.slice(0, -1);
    const path = folder.length > 0 ? jobPath(folder.join('/')) : '';
    try {
      const raw = await this.json<{ jobs?: Array<{ name?: unknown }> }>(`${path}/api/json?tree=jobs[name]`);
      const prefix = folder.length > 0 ? `${folder.join('/')}/` : '';
      return (raw.jobs ?? []).map((j) => `${prefix}${String(j.name ?? '')}`).filter((n) => !n.endsWith('/'));
    } catch {
      return []; // the folder is not readable either: the plain "not there" stands on its own
    }
  }

  /** Start a build. Returns the queue item's path, which becomes a build once Jenkins starts it. */
  async trigger(job: string, params: Record<string, string>): Promise<string> {
    const withParams = Object.keys(params).length > 0;
    const res = await this.request('POST', `${jobPath(job)}/${withParams ? 'buildWithParameters' : 'build'}`,
      withParams ? new URLSearchParams(params).toString() : undefined, withParams ? 'application/x-www-form-urlencoded' : undefined);
    if (res.status === 404) throw new JenkinsError(`Jenkins has no job ${job}`, 404);
    if (res.status === 400) throw new JenkinsError(`Jenkins refused the build parameters for ${job}: ${(await res.text()).slice(0, 300)}`, 400);
    if (res.status !== 201 && res.status !== 200) throw new JenkinsError(`Jenkins answered ${res.status} when asked to build ${job}`, res.status);
    const location = res.headers.get('location');
    if (!location || !/\/queue\/item\/\d+\/?$/.test(new URL(location, this.base).pathname)) {
      throw new JenkinsError('Jenkins started something but did not say which queue item it is, so it cannot be followed');
    }
    return new URL(this.urlFor(location)).pathname.replace(/\/?$/, '/');
  }

  async queueItem(queuePath: string): Promise<QueueState> {
    const q = await this.json<{ cancelled?: boolean; why?: string | null; executable?: { number?: number } | null }>(`${queuePath.replace(/\/?$/, '/')}api/json`);
    return { buildNumber: typeof q.executable?.number === 'number' ? q.executable.number : null, cancelled: q.cancelled === true, why: q.why ?? null };
  }

  async build(job: string, number: number): Promise<BuildState> {
    const b = await this.json<{
      number: number; building?: boolean; result?: string | null; url?: string;
      actions?: Array<{ _class?: string; lastBuiltRevision?: { SHA1?: string }; buildsByBranchName?: Record<string, { revision?: { SHA1?: string } }> } | null>;
    }>(`${jobPath(job)}/${number}/api/json?tree=number,building,result,url,actions[_class,lastBuiltRevision[SHA1],buildsByBranchName[*[*[*]]]]`);
    const data = (b.actions ?? []).filter((a): a is NonNullable<typeof a> => Boolean(a && (a.lastBuiltRevision || a.buildsByBranchName)));
    const sha = data.map((a) => a.lastBuiltRevision?.SHA1).find((s): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/i.test(s)) ?? null;
    const all = new Set<string>();
    for (const a of data) {
      if (a.lastBuiltRevision?.SHA1) all.add(a.lastBuiltRevision.SHA1.toLowerCase());
      for (const v of Object.values(a.buildsByBranchName ?? {})) if (v?.revision?.SHA1) all.add(v.revision.SHA1.toLowerCase());
    }
    return { number: b.number, building: b.building === true, result: b.result ?? null, url: b.url ?? '', builtSha: sha?.toLowerCase() ?? null, builtShas: [...all] };
  }

  /** The pipeline's stages (Pipeline Stage View). Null for a job that is not a pipeline. */
  async stages(job: string, number: number): Promise<PipelineState | null> {
    try {
      const d = await this.json<{ status?: string; stages?: Array<{ id: string; name: string; status: string; durationMillis?: number }> }>(`${jobPath(job)}/${number}/wfapi/describe`);
      return { status: d.status ?? 'UNKNOWN', stages: (d.stages ?? []).map((s) => ({ id: String(s.id), name: s.name, status: s.status, durationMs: s.durationMillis ?? 0 })) };
    } catch (err) {
      if (err instanceof JenkinsError && err.status === 404) return null;
      throw err;
    }
  }

  async pendingInputs(job: string, number: number): Promise<PendingInput[]> {
    try {
      const list = await this.json<Array<{ id: string; message?: string; proceedText?: string; inputs?: unknown[] }>>(`${jobPath(job)}/${number}/wfapi/pendingInputActions`);
      return (Array.isArray(list) ? list : []).map((i) => ({
        id: String(i.id), message: String(i.message ?? ''), proceedText: String(i.proceedText ?? 'Proceed'), hasParameters: Array.isArray(i.inputs) && i.inputs.length > 0,
      }));
    } catch (err) {
      if (err instanceof JenkinsError && err.status === 404) return [];
      throw err;
    }
  }

  /** Answer a pending input with Proceed. Only for inputs without parameters. */
  async proceed(job: string, number: number, inputId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(inputId)) throw new JenkinsError(`"${inputId}" is not an input id`);
    const res = await this.request('POST', `${jobPath(job)}/${number}/input/${encodeURIComponent(inputId)}/proceedEmpty`);
    if (res.status >= 400) throw new JenkinsError(`Jenkins answered ${res.status} when told to proceed`, res.status);
  }
}
