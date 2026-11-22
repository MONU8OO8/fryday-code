// The command line's own logic: the doctor's report and exit rule, and the demo's setup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { formatReport, needed } from '../src/cli/doctor';
import { demoEnv, demoPaths, makeSampleRepo, resetDemoFolder, shellQuote, writeStandIn } from '../src/cli/demo';
import type { ConnectionsReport } from '../src/connections/doctor';

const report = (checks: ConnectionsReport['checks']): ConnectionsReport => ({ checkedAt: 0, checks, mcpServers: [], mcpNote: null });

test('the doctor fails only on a needed check that is a problem, and prints its fix', () => {
  const r = report([
    { id: 'claude', name: 'Claude Code', usedFor: 'agents', required: true, state: 'problem', summary: 'Not found.', fix: 'npm install -g @anthropic-ai/claude-code' },
    { id: 'gh', name: 'GitHub CLI', usedFor: 'pull requests', required: false, state: 'problem', summary: 'Not found.', fix: 'brew install gh' },
    { id: 'git', name: 'git', usedFor: 'everything', required: true, state: 'warn', summary: 'No author set.', fix: 'git config --global user.name "You"' },
  ]);
  assert.deepEqual(needed(r).map((c) => c.id), ['claude']);
  const text = formatReport(r).join('\n');
  assert.match(text, /PROBLEM\s+Claude Code\s+Not found\./);
  assert.match(text, /Fix: npm install -g @anthropic-ai\/claude-code/);
  assert.match(text, /Not ready yet: Claude Code\./);
  assert.equal(needed(report([{ ...r.checks[2]! }])).length, 0);
});

test('the demo never wipes a folder it did not make', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-demo-'));
  try {
    const p = demoPaths(path.join(root, 'demo'));
    fs.mkdirSync(p.root);
    fs.writeFileSync(path.join(p.root, 'keep.txt'), 'mine');
    assert.throws(() => resetDemoFolder(p), /was not made by the demo/);
    assert.equal(fs.readFileSync(path.join(p.root, 'keep.txt'), 'utf8'), 'mine');
    fs.rmSync(p.root, { recursive: true });
    resetDemoFolder(p);
    fs.writeFileSync(path.join(p.root, 'old.txt'), 'from an earlier demo');
    resetDemoFolder(p); // its own folder: emptied
    assert.equal(fs.existsSync(path.join(p.root, 'old.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the demo sets up a sample repo with a staging branch, a stand-in agent, and no keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fryday demo's-"));
  try {
    const p = demoPaths(path.join(root, 'demo'));
    resetDemoFolder(p);
    makeSampleRepo(p);
    const branches = execFileSync('git', ['--git-dir', p.origin, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    assert.deepEqual(branches, ['main', 'stg']);
    writeStandIn(p);
    const script = fs.readFileSync(p.wrapper, 'utf8');
    assert.match(script, /FAKE_DELAY_MS=1500/);
    assert.ok(script.includes(shellQuote(p.scenario)), 'the scenario path is quoted for the shell');
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote("it's")}`], { encoding: 'utf8' }), "it's");
    const env = demoEnv(p, 7477, { ANTHROPIC_API_KEY: 'sk-test', FRYDAY_CORE_SECRET: 'x', PATH: '/bin' });
    assert.equal(env['ANTHROPIC_API_KEY'], undefined);
    assert.equal(env['FRYDAY_CORE_SECRET'], undefined);
    assert.equal(env['FRYDAY_DEMO'], '1');
    assert.equal(env['CLAUDE_BIN'], p.wrapper);
    assert.equal(env['FRYDAY_HOME'], p.home);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
