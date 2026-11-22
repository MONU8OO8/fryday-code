/**
 * A small MCP client for servers that talk over stdin/stdout — enough to start one,
 * ask which tools it has, and call a tool. Core uses it to list a server's tools when the
 * developer sets up a connection, and the red-team scripts use it to drive a server
 * without a model in between.
 *
 * Starting a server runs the command from its definition, as that developer, the same
 * way Claude Code would. That is why it only ever happens on the developer's own action.
 */

import { spawn, type ChildProcess } from 'child_process';
import readline from 'readline';

export interface StdioDefinition {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
}

export interface McpToolResult {
  isError: boolean;
  /** The text parts of the answer, joined. */
  text: string;
}

export class McpError extends Error {}

const PROTOCOL_VERSION = '2025-06-18';
/** What a started server inherits from core. Never core's secret; a server gets its own values from its definition. */
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR'];

export interface McpClientOptions {
  /** How long any one request may take. */
  timeoutMs?: number;
  cwd?: string;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = '';
  private closed: Error | null = null;

  constructor(private readonly definition: StdioDefinition, private readonly opts: McpClientOptions = {}) {}

  /** Start the server and complete the handshake. */
  async start(): Promise<void> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(this.definition.command, this.definition.args ?? [], {
      env: { ...env, ...(this.definition.env ?? {}) },
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // its own process group, so everything it started can be stopped with it
    });
    this.child = child;
    child.stderr!.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000); });
    child.stdin!.on('error', () => { /* the server went away; the pending requests are failed below */ });
    const fail = (why: string) => {
      this.closed = new McpError(why);
      for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(this.closed); }
      this.waiting.clear();
    };
    child.on('error', (err) => fail(`the server could not be started: ${err.message}`));
    child.on('exit', (code) => fail(`the server stopped${code === null ? '' : ` with exit code ${code}`}${this.stderr.trim() ? `: ${lastLine(this.stderr)}` : ''}`));

    readline.createInterface({ input: child.stdout!, crlfDelay: Infinity }).on('line', (line) => {
      let msg: { id?: unknown; result?: unknown; error?: { message?: unknown }; method?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return; // a server that prints something else on stdout: not ours to read
      }
      if (typeof msg.id === 'number' && this.waiting.has(msg.id)) {
        const w = this.waiting.get(msg.id)!;
        this.waiting.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.error) w.reject(new McpError(String(msg.error.message ?? 'the server reported an error')));
        else w.resolve(msg.result);
      } else if (typeof msg.method === 'string' && msg.id !== undefined) {
        // A request from the server (roots, sampling). This client offers none of that.
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by this client' } });
      }
    });

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'fryday-code', version: '1.0.0' },
    });
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: unknown; nextCursor?: unknown };
      for (const t of Array.isArray(result?.tools) ? result.tools : []) {
        const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof tool.name !== 'string') continue;
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? (tool.inputSchema as Record<string, unknown>) : null,
        });
      }
      if (typeof result?.nextCursor !== 'string' || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const result = (await this.request('tools/call', { name, arguments: args })) as { isError?: unknown; content?: unknown };
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts.map((p) => ((p as { type?: unknown; text?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).filter(Boolean).join('\n');
    return { isError: result?.isError === true, text };
  }

  /** Stop the server and everything it started. */
  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.pid === undefined) return;
    try { child.stdin?.end(); } catch { /* already closed */ }
    const pid = child.pid;
    const kill = (signal: NodeJS.Signals) => {
      try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
    };
    kill('SIGTERM');
    setTimeout(() => kill('SIGKILL'), 2000).unref();
  }

  private write(msg: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    if (!this.child) return Promise.reject(new McpError('the server is not running'));
    const id = this.nextId++;
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new McpError(`the server did not answer "${method}" within ${Math.round(timeoutMs / 1000)} seconds${this.stderr.trim() ? `: ${lastLine(this.stderr)}` : ''}`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}

/** Start a server, list its tools, stop it. */
export async function discoverTools(definition: StdioDefinition, opts: McpClientOptions = {}): Promise<McpTool[]> {
  const client = new McpClient(definition, opts);
  try {
    await client.start();
    return await client.listTools();
  } finally {
    client.stop();
  }
}
