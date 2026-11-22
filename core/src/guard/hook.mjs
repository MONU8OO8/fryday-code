#!/usr/bin/env node
// PreToolUse hook for Fryday agents. Usage: node hook.mjs <policy.json>
//
// Reads the tool call from stdin, checks it against the run's policy, and blocks it
// with exit code 2 (reason on stderr, which Claude Code shows to the agent) unless the
// policy allows it. Anything unexpected — unreadable policy, bad input, a thrown
// error — also exits 2: the guard fails closed.

import fs from 'node:fs';
import { decide } from './decide.mjs';

function block(reason) {
  process.stderr.write(`Blocked by Fryday guard: ${reason}\n`);
  process.exit(2);
}

try {
  const policyPath = process.argv[2];
  if (!policyPath) block('no policy file given');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const call = JSON.parse(fs.readFileSync(0, 'utf8'));
  const cwd = typeof call.cwd === 'string' && call.cwd ? call.cwd : process.cwd();
  const decision = decide(policy, call.tool_name, call.tool_input, cwd);
  if (!decision.allow) block(decision.reason);
  process.exit(0);
} catch (err) {
  block(`guard error: ${err instanceof Error ? err.message : String(err)}`);
}
