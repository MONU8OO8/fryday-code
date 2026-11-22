#!/usr/bin/env node
// FryDay Code's command line. Plain Node, no build step: each command runs a TypeScript file
// from this package through the package's own tsx.
//
//   fryday-code [start]   run FryDay Code (the API, the agents and the UI)
//   fryday-code open      open the UI in the browser with a new one-time launch link
//   fryday-code doctor    check this machine, the same checks as Setup → Connections
//   fryday-code demo      try it with stand-in agents: no Claude account, no cost
//
// Kept to syntax old Node versions can parse (no ??, ?., optional catch bindings or node: imports),
// so they get the version message below instead of a syntax error.

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = [22, 12];

const COMMANDS = {
  start: { file: 'src/server.ts', about: 'Run FryDay Code (default). Prints a one-time link to open the UI.' },
  open: { file: 'src/cli/open.ts', about: 'Open the UI of a running FryDay Code with a new link (--print: only print it).' },
  doctor: { file: 'src/cli/doctor.ts', about: 'Check this machine: Claude Code, the sandbox, git, Node and more, with fixes.' },
  demo: { file: 'src/cli/demo.ts', about: 'Try it on a sample project with stand-in agents: no Claude account, no cost (--no-open).' },
};

function version() {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version;
}

function help() {
  const lines = [
    `FryDay Code ${version()}: a local team of AI agents that plans, builds, checks and releases with your approval.`,
    '',
    'Usage: fryday-code [command]',
    '',
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(8)} ${c.about}`),
    `  ${'help'.padEnd(8)} Show this help.`,
    '',
    'Options: --version, --help',
    'State lives in ~/.fryday-code (set FRYDAY_HOME to move it). Port 7475 (FRYDAY_PORT).',
  ];
  console.log(lines.join('\n'));
}

function nodeIsTooOld(v = process.versions.node) {
  const [major, minor] = v.split('.').map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

function run(file, args) {
  let tsx;
  try {
    tsx = createRequire(join(PACKAGE_DIR, 'package.json')).resolve('tsx/cli');
  } catch (err) {
    console.error('FryDay Code is missing its dependencies. In a clone, run: npm run setup');
    process.exit(1);
  }
  // From the package folder, so tsx uses this package's settings and not a tsconfig where it was started.
  const child = spawn(process.execPath, [tsx, file, ...args], { cwd: PACKAGE_DIR, stdio: 'inherit', env: process.env });
  const forward = (signal) => () => { if (child.exitCode === null) child.kill(signal); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward(signal));
  child.on('error', (err) => { console.error(`Could not start FryDay Code: ${err.message}`); process.exit(1); });
  child.on('exit', (code, signal) => process.exit(code !== null && code !== undefined ? code : (signal ? 0 : 1)));
}

const [first, ...rest] = process.argv.slice(2);

if (first === '--version' || first === '-v' || first === 'version') {
  console.log(version());
} else if (first === 'help' || first === '--help' || first === '-h') {
  help();
} else if (nodeIsTooOld()) {
  console.error(`FryDay Code needs Node.js ${MIN_NODE.join('.')} or newer; this is ${process.versions.node}.`);
  console.error('Install a newer Node.js from https://nodejs.org (or with nvm: nvm install 22), then run this again.');
  process.exit(1);
} else {
  const name = first === undefined || first.startsWith('-') ? 'start' : first;
  const command = COMMANDS[name];
  if (!command) {
    console.error(`Unknown command: ${name}\n`);
    help();
    process.exit(1);
  }
  run(command.file, name === 'start' && first !== undefined && first.startsWith('-') ? [first, ...rest] : rest);
}
