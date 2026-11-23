// The repository scan: what it reads from a production commit (packages, env key names,
// outbound services, routes, compose services) and what it never opens (real .env files,
// dependencies, build output, tests).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { composeServices, expressRoutes, extractFacts, isRealEnvFile, nestRoutes, nextRoutes, pickFiles, productionSha, scanRepository } from '../src/knowledge/scan';

const tmp = path.join(os.tmpdir(), `fryday-scan-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function scratchRepo(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, 'add', '-A', '-f');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

// Built at run time so no secret-shaped literal sits in the source.
const fakeSecret = ['sk', 'live', randomBytes(12).toString('hex')].join('_');

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'card-service', main: 'dist/main.js', scripts: { build: 'nest build', test: 'jest' }, dependencies: { '@nestjs/core': '10', axios: '1' }, devDependencies: { jest: '29' } }),
  '.env.example': 'PORT=3000\nCREDIT_SERVICE_URL=\nexport PAYMENTS_HOST=\n',
  '.env': `REAL_ONLY_KEY=${fakeSecret}\n`,
  '.env.production': `PROD_ONLY_URL=${fakeSecret}\n`,
  'docker-compose.yml': 'version: "3"\nservices:\n  api:\n    build: .\n    environment:\n      - X=1\n  redis:\n    image: redis\nvolumes:\n  data:\n',
  'src/main.ts': "const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix('api');\n",
  'src/cards/cards.controller.ts': "@Controller('cards')\nexport class Cards {\n  @Get()\n  list() {}\n  @Get(':id')\n  one() {}\n  @Post('apply')\n  apply() {}\n}\n",
  'src/cards/cards.controller.spec.ts': "@Controller('from-a-test')\nclass X { @Get('nope') n() {} }\n",
  'src/clients.ts': [
    "const credit = this.configService.get<string>('CREDIT_SERVICE_URL');",
    "const redis = process.env.REDIS_HOST;",
    "const loans = process.env['LOAN_API_BASE_URL'];",
    "const flag = process.env.FEATURE_FLAG;",
    "export const bank = axios.create({ baseURL: 'https://api.partner-bank.test/v1' });",
    "fetch('http://localhost:3000/health');",
    "fetch(`https://docs.example.com/x`);",
  ].join('\n'),
  'server/routes.js': "const router = express.Router();\nrouter.get('/status', h);\nrouter.post('/hooks/:id', h);\n",
  'web/pages/api/users/index.ts': 'export default function handler() {}\n',
  'web/app/(shop)/orders/[id]/route.ts': 'export async function GET() {}\nexport const POST = async () => {};\n',
  'node_modules/dep/index.js': 'process.env.SHOULD_NOT_SEE_URL;\n',
  'dist/main.js': 'process.env.BUILD_ONLY_URL;\n',
};

test('real env files are never opened; example files are', () => {
  for (const f of ['.env', '.env.local', '.env.production', 'apps/web/.env.development.local']) assert.equal(isRealEnvFile(f), true, f);
  for (const f of ['.env.example', '.env.sample', 'apps/web/.env.local.example', '.env.template', 'src/env.ts']) assert.equal(isRealEnvFile(f), false, f);
  const picked = pickFiles(Object.keys(FIXTURE)).files;
  assert.ok(picked.includes('.env.example'));
  for (const never of ['.env', '.env.production', 'node_modules/dep/index.js', 'dist/main.js', 'src/cards/cards.controller.spec.ts']) assert.ok(!picked.includes(never), never);
  assert.deepEqual(picked.slice(0, 3).sort(), ['.env.example', 'docker-compose.yml', 'package.json'], 'the most telling files are read first');
});

test('routes: Nest with its global prefix, Express, Next pages and app routes', () => {
  assert.deepEqual(nestRoutes('c.ts', FIXTURE['src/cards/cards.controller.ts']!, 'api').map((r) => `${r.method} ${r.path}`), ['GET /api/cards', 'GET /api/cards/:id', 'POST /api/cards/apply']);
  assert.deepEqual(nestRoutes('c.ts', "@Controller({ path: 'v2/loans', version: '2' })\nclass L { @Delete(':id') d() {} @All() a() {} }").map((r) => `${r.method} ${r.path}`), ['DELETE /v2/loans/:id', 'ANY /v2/loans']);
  assert.deepEqual(nestRoutes('plain.ts', "@Get('x')"), [], 'a decorator outside a controller is not a route');
  assert.deepEqual(expressRoutes('r.js', FIXTURE['server/routes.js']!).map((r) => `${r.method} ${r.path}`), ['GET /status', 'POST /hooks/:id']);
  assert.deepEqual(expressRoutes('r.js', "config.get('/not-a-route'); cache.get('/x')"), [], 'a get on something that is not a router is not a route');
  assert.deepEqual(nextRoutes('web/pages/api/users/index.ts', '').map((r) => `${r.method} ${r.path}`), ['ANY /api/users']);
  assert.deepEqual(nextRoutes('web/app/(shop)/orders/[id]/route.ts', FIXTURE['web/app/(shop)/orders/[id]/route.ts']!).map((r) => `${r.method} ${r.path}`), ['GET /orders/[id]', 'POST /orders/[id]']);
  assert.deepEqual(nextRoutes('src/app/page.tsx', ''), []);
});

test('compose services are the top-level names under services', () => {
  assert.deepEqual(composeServices(FIXTURE['docker-compose.yml']!), ['api', 'redis']);
  assert.deepEqual(composeServices('version: "3"\n'), []);
});

test('a scan of the production commit reads names, never values, and skips what it must', async () => {
  const repo = scratchRepo('nest', FIXTURE);
  const sha = productionSha(repo, 'main');
  assert.match(sha, /^[0-9a-f]{40}$/);
  // Uncommitted work in the clone is not what production runs, so the scan does not see it.
  fs.writeFileSync(path.join(repo, 'src/wip.ts'), 'process.env.UNCOMMITTED_URL;');
  const facts = await scanRepository(repo, sha);

  assert.equal(facts.packageName, 'card-service');
  assert.deepEqual(facts.scripts, ['build', 'test']);
  assert.deepEqual(facts.dependencies, ['@nestjs/core', 'axios']);
  assert.deepEqual(facts.frameworks, ['NestJS']);
  assert.ok(facts.entryPoints.includes('src/main.ts'));
  for (const k of ['PORT', 'CREDIT_SERVICE_URL', 'PAYMENTS_HOST', 'REDIS_HOST', 'LOAN_API_BASE_URL', 'FEATURE_FLAG']) assert.ok(facts.envKeys.includes(k), k);
  assert.deepEqual(facts.outbound.map((o) => o.key), ['CREDIT_SERVICE_URL', 'LOAN_API_BASE_URL', 'PAYMENTS_HOST', 'REDIS_HOST']);
  assert.deepEqual(facts.outbound.find((o) => o.key === 'CREDIT_SERVICE_URL')!.files, ['src/clients.ts']);
  assert.deepEqual(facts.hosts.map((h) => h.host), ['api.partner-bank.test'], 'localhost and example hosts are not services');
  assert.deepEqual(facts.composeServices, ['api', 'redis']);
  const routes = facts.routes.map((r) => `${r.method} ${r.path}`);
  for (const r of ['GET /api/cards/:id', 'GET /status', 'POST /hooks/:id', 'ANY /api/users', 'GET /orders/[id]']) assert.ok(routes.includes(r), r);
  assert.ok(!routes.some((r) => r.includes('from-a-test') || r.includes('nope')), 'tests are not read');
  assert.ok(facts.topDirs.some((d) => d.dir === 'src'));
  assert.ok(!facts.topDirs.some((d) => d.dir === 'node_modules' || d.dir === 'dist'));

  const all = JSON.stringify(facts);
  for (const never of ['REAL_ONLY_KEY', 'PROD_ONLY_URL', fakeSecret, 'SHOULD_NOT_SEE_URL', 'BUILD_ONLY_URL', 'UNCOMMITTED_URL', tmp]) {
    assert.ok(!all.includes(never), `${never} must not reach the scan`);
  }
});

test('the production commit is origin/<branch> when the clone has one', () => {
  const upstream = scratchRepo('upstream', { 'a.txt': 'one' });
  const clone = path.join(tmp, 'clone');
  execFileSync('git', ['clone', '-q', upstream, clone], { stdio: 'ignore' });
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'local only');
  assert.equal(productionSha(clone, 'main'), git(upstream, 'rev-parse', 'HEAD'), 'local commits on main are not production');
  assert.throws(() => productionSha(clone, 'no-such-branch'), /no commit for no-such-branch/);
});

test('extracted lists are capped and labels cleaned', () => {
  const many = Array.from({ length: 300 }, (_, i) => `process.env.KEY_${i}_URL;`).join('\n');
  const facts = extractFacts('x', ['a.ts'], [{ path: 'a.ts', text: many }, { path: 'package.json', text: JSON.stringify({ name: 'bad\u0007name', scripts: { 'a\nb': 'x' } }) }], false);
  assert.equal(facts.envKeys.length, 200);
  assert.equal(facts.outbound.length, 200);
  assert.equal(facts.packageName, 'bad name');
  assert.deepEqual(facts.scripts, ['a b']);
  assert.equal(extractFacts('x', [], [{ path: 'package.json', text: '{ not json' }], false).packageName, null, 'a broken package.json is skipped, not fatal');
});
