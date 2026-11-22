import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  checkSpecs, runChecks, runCheck, isBlocking, bootstrapDeps, failureSignatures, compareWithBase, waitForMemory, memoryPressureLevel,
  type CheckSpec, type CheckResult,
} from '../src/pipeline/checks';

// The sandbox runs on macOS and on Linux (bubblewrap); elsewhere there is none to test.
const skip = !['darwin', 'linux'].includes(process.platform);
const base = path.join(os.homedir(), '.fryday-code', `checks-test-${randomBytes(4).toString('hex')}`);
const workspace = path.join(base, 'workspace');
const scratch = path.join(base, 'scratch');
const opts = { workspacePath: workspace, scratchRoot: scratch };

before(() => {
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'ok.test.js'), "require('node:test').test('ok', () => {});\n");
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

test('checks come from the registry, cheapest first, and empty commands are left out', () => {
  assert.deepEqual(checkSpecs({ testCmd: 'npm test', lintCmd: ' npm run lint ', typecheckCmd: null }), [
    { name: 'lint', cmd: 'npm run lint' },
    { name: 'test', cmd: 'npm test' },
  ]);
  assert.deepEqual(checkSpecs({ testCmd: '', lintCmd: null, typecheckCmd: 'tsc --noEmit' }), [{ name: 'typecheck', cmd: 'tsc --noEmit' }]);
  assert.deepEqual(checkSpecs({ testCmd: null, lintCmd: null, typecheckCmd: null }), []);
});

test('exit codes decide: zero passes, anything else fails', { skip }, async () => {
  const pass = await runCheck({ name: 'test', cmd: 'node --test' }, opts);
  assert.equal(pass.status, 'passed');
  assert.equal(pass.exitCode, 0);
  assert.equal(isBlocking(pass), false);

  const fail = await runCheck({ name: 'lint', cmd: 'echo "2 problems found"; exit 1' }, opts);
  assert.equal(fail.status, 'failed');
  assert.equal(fail.exitCode, 1);
  assert.match(fail.output, /2 problems found/);
  assert.equal(isBlocking(fail), true);

  const slow = await runCheck({ name: 'test', cmd: 'sleep 20' }, { ...opts, timeoutMs: 1000 });
  assert.equal(slow.status, 'timeout');
  assert.equal(isBlocking(slow), true);
});

test('a check that was already failing on the base commit does not block the task', { skip }, async () => {
  const specs: CheckSpec[] = [{ name: 'lint', cmd: 'exit 1' }, { name: 'test', cmd: 'exit 2' }, { name: 'typecheck', cmd: 'exit 0' }];
  const asked: string[] = [];
  const results = await runChecks({
    ...opts,
    specs,
    baseline: async (spec) => {
      asked.push(spec.name);
      // On the base commit: lint was already failing, the tests were passing.
      const failing = spec.name === 'lint';
      return { ...spec, status: failing ? 'failed' : 'passed', exitCode: failing ? 1 : 0, durationMs: 1, output: '' };
    },
  });
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['lint', 'preexisting'], ['test', 'failed'], ['typecheck', 'passed']]);
  assert.deepEqual(asked, ['lint', 'test'], 'the baseline is only run for checks that fail');
  assert.deepEqual(results.filter(isBlocking).map((r) => r.name), ['test']);
});

test('failures are read out of test and typecheck output', () => {
  const jest = [
    'PASS src/a.spec.ts',
    '\u001b[1m\u001b[31mFAIL\u001b[39m\u001b[22m src/modules/pay/pay.service.spec.ts',
    '  ● PayService › refund › rejects a negative amount',
    '    expect(received).toBe(expected)',
    '  ● Console',
    '  ● PayService › refund › rejects a negative amount',
    'FAIL src/modules/kyc/kyc.spec.ts',
    '  ● Test suite failed to run',
    'Tests:       2 failed, 10 passed, 12 total',
  ].join('\n');
  assert.deepEqual(failureSignatures(jest), [
    'suite src/modules/pay/pay.service.spec.ts',
    'test PayService › refund › rejects a negative amount',
    'suite src/modules/kyc/kyc.spec.ts',
    'test Test suite failed to run',
  ]);
  assert.deepEqual(failureSignatures('ok 1 - add\nnot ok 2 - mul\n  ---\n✖ total applies the discount (1.2ms)\n'), ['test mul', 'test total applies the discount']);
  assert.deepEqual(failureSignatures('FAILED tests/test_api.py::test_login - AssertionError\n--- FAIL: TestSum (0.00s)\n'), ['test tests/test_api.py::test_login', 'test TestSum']);
  // The same type error after the file was edited (other line and column) is the same failure.
  const before = failureSignatures("src/a.ts(37,13): error TS2739: Type 'X' is missing properties\n");
  const after = failureSignatures("src/a.ts(52,9): error TS2739: Type 'X' is missing properties\n");
  assert.deepEqual(before, ["type src/a.ts: TS2739: Type 'X' is missing properties"]);
  assert.deepEqual(after, before);
  assert.deepEqual(failureSignatures('all good\n12 passing\n'), []);
  // A huge line (dumped JSON, minified code) is skipped quickly rather than scanned.
  const started = Date.now();
  assert.deepEqual(failureSignatures(`${'x'.repeat(2_000_000)}\nnot ok 1 - real failure\n`), ['test real failure']);
  assert.ok(Date.now() - started < 1000, 'reading failures must stay fast on huge lines');
});

test('on a repo that is already red, only failures that are new block the task', () => {
  const result = (status: CheckResult['status'], failures: string[] | undefined): CheckResult =>
    ({ name: 'test', cmd: 'jest', status, exitCode: status === 'passed' ? 0 : 1, durationMs: 1, output: '', ...(failures ? { failures } : {}) });
  const base = result('failed', ['test old A', 'test old B']);

  const same = compareWithBase(result('failed', ['test old B', 'test old A']), base);
  assert.deepEqual([same.status, same.comparedBy, same.newFailures], ['preexisting', 'failures', []]);
  assert.equal(isBlocking(same), false);

  const worse = compareWithBase(result('failed', ['test old A', 'test new C']), base);
  assert.deepEqual([worse.status, worse.comparedBy, worse.newFailures], ['failed', 'failures', ['test new C']]);
  assert.equal(isBlocking(worse), true);

  // Fewer failures than before is fine; fixing old ones is not a problem.
  assert.equal(compareWithBase(result('failed', ['test old A']), base).status, 'preexisting');
  // The base passes: the task broke the check, whatever the output says.
  assert.equal(compareWithBase(result('failed', ['test x']), result('passed', undefined)).status, 'failed');
  // Output nobody can read failures from: fall back to the exit code and say so.
  const unreadable = compareWithBase(result('failed', []), result('failed', []));
  assert.deepEqual([unreadable.status, unreadable.comparedBy], ['preexisting', 'exit-code']);
  const halfReadable = compareWithBase(result('failed', ['test x']), result('failed', []));
  assert.deepEqual([halfReadable.status, halfReadable.comparedBy], ['preexisting', 'exit-code']);
});

test('a check that could not be run always blocks and is never excused by the base commit', { skip }, async () => {
  const result = (status: CheckResult['status']): CheckResult => ({ name: 'test', cmd: 'jest', status, exitCode: status === 'passed' ? 0 : 1, durationMs: 1, output: 'sandbox: could not start' });
  // Could not run on the task branch: blocking, whatever the base says.
  for (const baseStatus of ['passed', 'failed', 'error'] as const) {
    const r = compareWithBase(result('error'), result(baseStatus));
    assert.equal(r.status, 'error');
    assert.equal(isBlocking(r), true);
  }
  // Fails on the task branch and could not run on the base: nobody knows what is new, so it blocks.
  const unknown = compareWithBase(result('failed'), result('error'));
  assert.equal(unknown.status, 'error');
  assert.match(unknown.output, /could not be run on the base commit/);

  // For real: a workspace that does not exist cannot run anything.
  const spec: CheckSpec = { name: 'test', cmd: 'node --test' };
  const [gone] = await runChecks({
    specs: [spec], workspacePath: path.join(base, 'no-such-workspace'), scratchRoot: scratch,
    baseline: async () => ({ ...spec, status: 'failed', exitCode: 1, durationMs: 1, output: '' }),
  });
  assert.equal(gone!.status, 'error');
  assert.equal(isBlocking(gone!), true);
});

test('a new failing test is caught even though the suite was already failing', { skip }, async () => {
  const dir = path.join(base, 'red');
  fs.mkdirSync(dir, { recursive: true });
  const t = (name: string, ok: boolean) => `require('node:test').test('${name}', () => { require('node:assert').equal(${ok}, true); });\n`;
  fs.writeFileSync(path.join(dir, 'old.test.js'), t('legacy thing that has been red for months', false));
  const spec: CheckSpec = { name: 'test', cmd: 'node --test' };
  const run = () => runCheck(spec, { workspacePath: dir, scratchRoot: scratch });

  const onBase = await run();
  assert.equal(onBase.status, 'failed');
  assert.deepEqual(onBase.failures, ['test legacy thing that has been red for months']);

  // The task adds a test that fails too.
  fs.writeFileSync(path.join(dir, 'new.test.js'), t('thing the task just broke', false));
  const [withNew] = await runChecks({ specs: [spec], workspacePath: dir, scratchRoot: scratch, baseline: async () => onBase });
  assert.equal(withNew!.status, 'failed');
  assert.deepEqual(withNew!.newFailures, ['test thing the task just broke']);

  // The task's test passes: the old failure alone does not block.
  fs.writeFileSync(path.join(dir, 'new.test.js'), t('thing the task added', true));
  const [fixed] = await runChecks({ specs: [spec], workspacePath: dir, scratchRoot: scratch, baseline: async () => onBase });
  assert.deepEqual([fixed!.status, fixed!.comparedBy, fixed!.newFailures], ['preexisting', 'failures', []]);
});

test('a heavy check waits for memory pressure to ease, but not forever', async () => {
  // Normal pressure, or a system where it cannot be read: no waiting.
  assert.ok((await waitForMemory(5000, () => 1, 10)) < 50);
  assert.ok((await waitForMemory(5000, () => null, 10)) < 50);

  // Under pressure it waits, and goes ahead as soon as pressure is back to normal.
  const levels = [4, 2, 2, 1];
  let asked = 0;
  const waited = await waitForMemory(5000, () => levels[Math.min(asked++, levels.length - 1)]!, 20);
  assert.equal(asked, 4);
  assert.ok(waited >= 55 && waited < 1000, `waited ${waited} ms`);

  // Pressure that never eases: it gives up after the limit and runs anyway.
  const stuck = await waitForMemory(120, () => 4, 20);
  assert.ok(stuck >= 120 && stuck < 600, `waited ${stuck} ms`);

  // Zero means never wait, whatever the pressure.
  assert.ok((await waitForMemory(0, () => 4, 20)) < 20);
  if (process.platform === 'darwin') assert.ok([1, 2, 4].includes(memoryPressureLevel()!));
});

test('dependencies are cloned from the owner copy only when it is safe to', () => {
  const owner = path.join(base, 'owner');
  const mk = (name: string) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
    return dir;
  };
  mk('owner');
  fs.mkdirSync(path.join(owner, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(owner, 'node_modules', 'dep', 'index.js'), 'module.exports = "original";\n');

  const checkout = mk('checkout');
  const cloned = bootstrapDeps(owner, checkout);
  assert.equal(cloned.status, 'cloned');
  assert.equal(fs.readFileSync(path.join(checkout, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = "original";\n');
  // Tampering with the clone must not reach the owner's copy.
  fs.writeFileSync(path.join(checkout, 'node_modules', 'dep', 'index.js'), 'module.exports = "tampered";\n');
  assert.equal(fs.readFileSync(path.join(owner, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = "original";\n');
  assert.equal(bootstrapDeps(owner, checkout).status, 'present');

  const differs = mk('differs');
  fs.writeFileSync(path.join(differs, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
  assert.match(bootstrapDeps(owner, differs).detail, /differs from the owner's copy/);
  assert.equal(fs.existsSync(path.join(differs, 'node_modules')), false);

  const tracked = mk('tracked');
  fs.writeFileSync(path.join(tracked, '.gitignore'), '');
  assert.match(bootstrapDeps(owner, tracked).detail, /not git-ignored/);

  const noDeps = mk('no-deps-owner');
  assert.match(bootstrapDeps(noDeps, mk('checkout2')).detail, /has no node_modules/);

  // A repo that tracks no lockfile: package.json's dependency lists decide.
  const ownerNoLock = mk('owner-no-lock');
  fs.rmSync(path.join(ownerNoLock, 'package-lock.json'));
  fs.writeFileSync(path.join(ownerNoLock, 'package.json'), '{"name":"x","version":"2.0.0","dependencies":{"dep":"1.0.0"}}\n');
  fs.mkdirSync(path.join(ownerNoLock, 'node_modules', 'dep'), { recursive: true });
  const sameDeps = mk('same-deps');
  fs.rmSync(path.join(sameDeps, 'package-lock.json'));
  fs.writeFileSync(path.join(sameDeps, 'package.json'), '{"name":"x","version":"2.1.0","dependencies":{"dep":"1.0.0"}}\n');
  assert.match(bootstrapDeps(ownerNoLock, sameDeps).detail, /no lockfile; package\.json dependencies match/);
  const otherDeps = mk('other-deps');
  fs.rmSync(path.join(otherDeps, 'package-lock.json'));
  fs.writeFileSync(path.join(otherDeps, 'package.json'), '{"name":"x","dependencies":{"dep":"1.0.0","sneaky":"9.9.9"}}\n');
  assert.match(bootstrapDeps(ownerNoLock, otherDeps).detail, /package\.json dependencies differ/);
  assert.equal(fs.existsSync(path.join(otherDeps, 'node_modules')), false);

  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  assert.equal(bootstrapDeps(owner, plain).status, 'none');
});
