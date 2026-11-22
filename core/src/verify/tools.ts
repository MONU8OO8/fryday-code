/**
 * The MCP servers one tester run gets, and the exact tools from them it may call.
 *
 * Core writes a config file for that run only: the service tool pinned to the service it
 * started, a browser that can open that service and nothing else, and the data
 * connections the developer granted to the project. The agent's `claude` process starts
 * these servers; they run outside the sandbox, which is why each one is either core's
 * own code, a pinned package, or something the developer explicitly turned on.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpRule } from '../guard/runGuard.js';
import type { GrantedConnection } from '../connections/store.js';
import { findOnPath } from '../config.js';

export interface RunMcp {
  /** The file to pass as --mcp-config. */
  configPath: string;
  /** Full tool names the agent may call, each with its argument check. */
  tools: Record<string, McpRule>;
  /** Files written for this run, to remove when it is over. */
  files: string[];
}

export const SERVICE_SERVER = 'fryday_service';
export const BROWSER_SERVER = 'fryday_browser';
export const SERVICE_REQUEST_TOOL = `mcp__${SERVICE_SERVER}__request`;
const SERVICE_TOOL_SCRIPT = path.join(__dirname, 'serviceTool.mjs');

/**
 * Browser tools the UI tester gets. Left out on purpose: running code in the browser
 * server's own process, uploading or dropping files from disk, and opening extra tabs.
 */
const BROWSER_TOOLS: Record<string, McpRule['check']> = {
  browser_navigate: 'url',
  browser_navigate_back: 'none',
  browser_snapshot: 'no-file',
  browser_take_screenshot: 'no-file',
  browser_click: 'none',
  browser_hover: 'none',
  browser_type: 'none',
  browser_fill_form: 'none',
  browser_select_option: 'none',
  browser_press_key: 'none',
  browser_drag: 'none',
  browser_wait_for: 'none',
  browser_find: 'none',
  browser_evaluate: 'no-file',
  browser_handle_dialog: 'none',
  browser_resize: 'none',
  browser_emulate_media: 'none',
  browser_console_messages: 'no-file',
  browser_network_requests: 'no-file',
  browser_network_request: 'no-file',
  browser_close: 'none',
};
export const BROWSER_TOOL_PREFIX = `mcp__${BROWSER_SERVER}__`;

function write(file: string, value: unknown): string {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  return file;
}

function serviceServer(runsDir: string, key: string, service: { origin: string; logPath: string }, files: string[], offer: Array<'request' | 'log'>) {
  const cfg = write(path.join(runsDir, `${key}.service.json`), { baseUrl: service.origin, logPath: service.logPath, tools: offer });
  files.push(cfg);
  return { command: process.execPath, args: [SERVICE_TOOL_SCRIPT, cfg] };
}

const serviceTools = (): Record<string, McpRule> => ({
  [SERVICE_REQUEST_TOOL]: { check: 'none' },
  [`mcp__${SERVICE_SERVER}__log`]: { check: 'none' },
});

export interface ApiTesterMcpOptions {
  /** A name for the files of this run. */
  key: string;
  runsDir: string;
  service: { origin: string; logPath: string };
  /** Data connections granted to the project, already checked by grantsFor(). */
  granted: GrantedConnection[];
}

export function apiTesterMcp(opts: ApiTesterMcpOptions): RunMcp {
  const files: string[] = [];
  const servers: Record<string, unknown> = { [SERVICE_SERVER]: serviceServer(opts.runsDir, opts.key, opts.service, files, ['request', 'log']) };
  const tools = serviceTools();
  for (const grant of opts.granted) {
    servers[grant.name] = grant.definition;
    for (const t of grant.tools) {
      tools[`mcp__${grant.name}__${t.tool}`] = { check: t.check === 'plain' ? 'none' : t.check };
    }
  }
  const configPath = write(path.join(opts.runsDir, `${opts.key}.mcp.json`), { mcpServers: servers });
  files.push(configPath);
  return { configPath, tools, files };
}

/** The browser programs looked for on PATH on Linux, in this order. */
export const LINUX_CHROME_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

export interface ChromeLookup {
  home?: string;
  platform?: string;
  /** FRYDAY_CHROME: a path, or a program name to look up on PATH. When set, nothing else is tried. */
  override?: string;
  exists?: (file: string) => boolean;
  which?: (name: string) => string | null;
}

/**
 * Where Google Chrome (or Chromium on Linux) is, or null. The UI tester drives the
 * installed browser; nothing is downloaded.
 */
export function findChrome(opts: ChromeLookup = {}): string | null {
  const exists = opts.exists ?? fs.existsSync;
  const which = opts.which ?? ((name: string) => findOnPath(name));
  const override = opts.override ?? process.env['FRYDAY_CHROME'] ?? '';
  // An explicit choice that does not work is reported as missing, not silently replaced.
  if (override) return path.isAbsolute(override) ? (exists(override) ? override : null) : which(override);
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    const home = opts.home ?? os.homedir();
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
    return candidates.find((c) => exists(c)) ?? null;
  }
  if (platform === 'linux') {
    for (const name of LINUX_CHROME_NAMES) {
      const found = which(name);
      if (found) return found;
    }
  }
  return null;
}

function playwrightCli(): string {
  return path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
}

export interface UiTesterMcpOptions {
  key: string;
  runsDir: string;
  service: { origin: string; port: number; logPath: string };
  /** Where screenshots and page snapshots are written. Inside the tester's checkout, so it can look at them. */
  outputDir: string;
  chromePath: string;
  /** The port of the proxy that refuses everything (verify/denyProxy.ts). */
  denyProxyPort: number;
}

/** A word on the browser's command line that identifies this run, so a browser left behind can be found and stopped. */
export const browserMarker = (key: string) => `--fryday-run=${key}`;

export function uiTesterMcp(opts: UiTesterMcpOptions): RunMcp {
  const files: string[] = [];
  const { port } = opts.service;
  const browserConfig = write(path.join(opts.runsDir, `${opts.key}.browser.json`), {
    browser: {
      browserName: 'chromium',
      // A fresh profile kept in memory: none of the developer's own sign-ins or history.
      isolated: true,
      launchOptions: {
        executablePath: opts.chromePath,
        headless: true,
        args: [
          // Everything goes to a proxy that refuses it, except the service under test.
          // "<-loopback>" takes away the browser's built-in exception for this machine.
          `--proxy-server=http://127.0.0.1:${opts.denyProxyPort}`,
          `--proxy-bypass-list=<-loopback>;127.0.0.1:${port};localhost:${port};[::1]:${port}`,
          // The browser's own traffic (updates, sign-in, safe browsing, metrics) is refused
          // by the proxy anyway; switching it off keeps it out of what is reported.
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-client-side-phishing-detection',
          '--disable-domain-reliability',
          '--metrics-recording-only',
          '--no-pings',
          '--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions',
          '--no-first-run',
          '--no-default-browser-check',
          // WebRTC could otherwise talk past the proxy.
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          browserMarker(opts.key),
        ],
      },
      contextOptions: { viewport: { width: 1280, height: 800 } },
    },
    outputDir: opts.outputDir,
    // Pictures are files the agent opens when it wants to look, not something sent with every step.
    imageResponses: 'omit',
    codegen: 'none',
    ignoreRoots: true,
    webmcp: false,
  });
  files.push(browserConfig);
  const servers = {
    [BROWSER_SERVER]: { command: process.execPath, args: [playwrightCli(), '--config', browserConfig] },
    // The UI tester works through the browser; of the service tool it only gets the log.
    [SERVICE_SERVER]: serviceServer(opts.runsDir, opts.key, opts.service, files, ['log']),
  };
  const tools: Record<string, McpRule> = { [`mcp__${SERVICE_SERVER}__log`]: { check: 'none' } };
  for (const [name, check] of Object.entries(BROWSER_TOOLS)) {
    tools[`${BROWSER_TOOL_PREFIX}${name}`] = check === 'url' ? { check, origin: opts.service.origin } : { check };
  }
  const configPath = write(path.join(opts.runsDir, `${opts.key}.mcp.json`), { mcpServers: servers });
  files.push(configPath);
  return { configPath, tools, files };
}

export function removeRunMcp(mcp: RunMcp | null | undefined): void {
  for (const file of mcp?.files ?? []) fs.rmSync(file, { force: true });
}
