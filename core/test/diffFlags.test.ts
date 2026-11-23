import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDiff, addedLinesByFile, hasBlockingFlag, type DiffFlag } from '../src/pipeline/diffFlags';

const patchFor = (file: string, added: string[], removed: string[] = []) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,1 +1,1 @@', ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n');

const kinds = (flags: DiffFlag[]) => flags.map((f) => `${f.severity}:${f.kind}`).sort();
const flagsFor = (file: string, added: string[], status = 'M') => analyzeDiff({ files: [{ status, path: file }], patch: patchFor(file, added) });

test('added lines are collected per file and removed lines are ignored', () => {
  const patch = [patchFor('a.js', ['one', 'two'], ['gone']), patchFor('b.js', ['three'])].join('\n');
  const added = addedLinesByFile(patch);
  assert.deepEqual(added.get('a.js'), ['one', 'two']);
  assert.deepEqual(added.get('b.js'), ['three']);
  // A deleted file has no added lines and must not swallow the next file's.
  const deleted = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ /dev/null', '-old', patchFor('y.js', ['new'])].join('\n');
  assert.deepEqual([...addedLinesByFile(deleted).keys()], ['y.js']);
});

test('skipping a test is blocking, in the common test frameworks', () => {
  const cases: Array<[string, string]> = [
    ['test/math.test.js', "test.skip('adds', () => {"],
    ['src/__tests__/a.ts', "  it.skip('works', async () => {"],
    ['src/a.spec.tsx', "describe.skip('suite', () => {"],
    ['test/x.test.js', "xit('works', () => {"],
    ['test/x.test.js', "test('adds', { skip: true }, () => {"],
    ['test/x.test.js', "it.todo('later')"],
    ['tests/test_api.py', '@pytest.mark.skip(reason="flaky")'],
    ['tests/test_api.py', '@unittest.skip("no")'],
    ['pkg/a_test.go', '\tt.Skip("later")'],
    ['src/FooTest.java', '    @Disabled'],
  ];
  for (const [file, line] of cases) {
    assert.deepEqual(kinds(flagsFor(file, [line])), ['blocking:test-skipped'], `${file}: ${line}`);
  }
});

test('focusing a test and deleting a test file are blocking', () => {
  assert.deepEqual(kinds(flagsFor('test/a.test.js', ["it.only('x', () => {"])), ['blocking:test-focused']);
  assert.deepEqual(kinds(flagsFor('test/a.test.js', ["fdescribe('x', () => {"])), ['blocking:test-focused']);
  assert.deepEqual(kinds(analyzeDiff({ files: [{ status: 'D', path: 'test/a.test.js' }], patch: '' })), ['blocking:test-deleted']);
  assert.equal(hasBlockingFlag(flagsFor('test/a.test.js', ["it.only('x', () => {"])), true);
});

test('ordinary changes raise nothing, including look-alikes outside test files', () => {
  assert.deepEqual(flagsFor('src/math.js', ['export const add = (a, b) => a + b;']), []);
  assert.deepEqual(flagsFor('test/math.test.js', ["test('adds', () => { assert.equal(add(2, 3), 5); });"]), []);
  // "skip" as a word or an option in product code is not a skipped test.
  assert.deepEqual(flagsFor('src/pager.js', ['const rows = query.skip(10).limit(5);', 'if (opts.only) return;']), []);
  assert.deepEqual(flagsFor('test/pager.test.js', ["test('skip(10) pages', () => { q.skip(10); });"]), []);
  assert.deepEqual(analyzeDiff({ files: [{ status: 'D', path: 'src/old.js' }], patch: '' }), []);
  assert.equal(hasBlockingFlag([]), false);
});

test('hooks, CI, dependencies and agent config are flagged for review, not blocked', () => {
  const review = (file: string, kind: string) => assert.deepEqual(kinds(flagsFor(file, ['x'])), [`review:${kind}`], file);
  review('.husky/pre-commit', 'hook-or-ci');
  review('.github/workflows/ci.yml', 'hook-or-ci');
  review('Jenkinsfile', 'hook-or-ci');
  review('services/api/Dockerfile', 'hook-or-ci');
  review('package-lock.json', 'dependencies');
  review('requirements.txt', 'dependencies');
  review('CLAUDE.md', 'claude-config');
  review('.claude/rules/style.md', 'claude-config');
  assert.equal(hasBlockingFlag(flagsFor('.husky/pre-commit', ['x'])), false);
});

test('silencing lint, types or coverage is flagged for review', () => {
  for (const line of ['// eslint-disable-next-line no-console', '// @ts-ignore', 'x = y  # type: ignore', '/* istanbul ignore next */']) {
    assert.deepEqual(kinds(flagsFor('src/a.ts', [line])), ['review:suppression'], line);
  }
});

test('package.json is flagged only for what changed in it', () => {
  const before = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test', build: 'tsc' }, dependencies: { a: '1.0.0' } });
  const run = (after: object) => kinds(analyzeDiff({
    files: [{ status: 'M', path: 'package.json' }],
    patch: patchFor('package.json', ['x']),
    packageJson: { 'package.json': { before, after: JSON.stringify(after) } },
  }));
  assert.deepEqual(run({ name: 'x', version: '1.0.1', scripts: { test: 'node --test', build: 'tsc' }, dependencies: { a: '1.0.0' } }), []);
  assert.deepEqual(run({ name: 'x', version: '1.0.0', scripts: { test: 'true', build: 'tsc' }, dependencies: { a: '1.0.0' } }), ['review:package-scripts']);
  assert.deepEqual(run({ name: 'x', version: '1.0.0', scripts: { test: 'node --test', build: 'tsc', postinstall: 'sh x.sh' }, dependencies: { a: '1.0.0' } }), ['review:package-scripts']);
  assert.deepEqual(run({ name: 'x', version: '1.0.0', scripts: { test: 'node --test', build: 'tsc' }, dependencies: { a: '1.0.0', b: '2.0.0' } }), ['review:dependencies']);
  const detail = analyzeDiff({
    files: [{ status: 'M', path: 'package.json' }], patch: '',
    packageJson: { 'package.json': { before, after: JSON.stringify({ scripts: { test: 'true' } }) } },
  }).find((f) => f.kind === 'package-scripts')!.detail;
  assert.equal(detail, 'package scripts changed: build, test');
});

// Credential-shaped values are built here at run time, so no real-looking secret sits in the repository.
const fake = {
  aws: 'AKIA' + 'Q'.repeat(16),
  github: 'ghp_' + 'a1'.repeat(18),
  anthropic: 'sk-ant-' + 'x'.repeat(30),
  key: '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
  dsn: 'postgres://app:' + 'hunter2hunter2' + '@db.internal:5432/app',
};

test('an added credential blocks the change, and the flag never repeats the value', () => {
  for (const [what, value] of Object.entries(fake)) {
    const flags = flagsFor('src/config.ts', [`const v = '${value}';`]);
    assert.deepEqual(kinds(flags), ['blocking:secret'], what);
    assert.ok(!flags[0]!.detail.includes(value), `${what}: the detail must not contain the value`);
    assert.ok(hasBlockingFlag(flags));
  }
  assert.deepEqual(flagsFor('src/config.ts', ["const key = process.env.API_KEY;", "const url = 'postgres://localhost/app';"]), [], 'reading a secret from the environment is fine');
});

test('a secrets file added to the change blocks it; an example file and a deletion do not', () => {
  assert.deepEqual(kinds(flagsFor('.env', ['A=1'], 'A')), ['blocking:secret']);
  assert.deepEqual(kinds(flagsFor('deploy/id_ed25519', ['x'], 'A')), ['blocking:secret']);
  assert.deepEqual(flagsFor('.env.example', ['A='], 'A'), []);
  assert.deepEqual(flagsFor('.env', [], 'D'), []);
});

test("the diff's secrets-file pattern is the guard's", async () => {
  const { isSecretFile } = await import('../src/guard/decide.mjs');
  const paths = ['.env', '.env.local', '.env.example', 'a/.npmrc', 'id_rsa', 'cert.pem', 'tls.key', 'my-creds.sh', 'credentials.json', 'secrets.yaml', 'src/index.ts', 'keys.ts', 'README.md'];
  for (const p of paths) {
    const flagged = flagsFor(p, ['x'], 'A').some((f) => f.kind === 'secret');
    assert.equal(flagged, isSecretFile(p), p);
  }
});
