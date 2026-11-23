// Reading the machine: memory from vm_stat and /proc/meminfo, CPU from os.cpus deltas,
// what an agent's process tree uses, and whether the machine can take one more agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admissionFor, admissionLimits, cpuPctBetween, memoryFromMeminfo, memoryFromVmStat, parsePs, treeUsage, type HealthSample,
} from '../src/system/health';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            300000.
Pages inactive:                          200000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                        100000.
Pages purgeable:                           5000.
`;

test('vm_stat: free, inactive, speculative and purgeable pages count as available', () => {
  const total = 16 * 1024 ** 3;
  const m = memoryFromVmStat(VM_STAT, total)!;
  assert.equal(m.availableBytes, (10000 + 200000 + 5000 + 5000) * 16384);
  assert.equal(m.usedBytes, total - m.availableBytes);
  assert.equal(memoryFromVmStat('not vm_stat', total), null);
});

test('/proc/meminfo: MemAvailable is what is free', () => {
  const m = memoryFromMeminfo('MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    4000000 kB\n')!;
  assert.equal(m.totalBytes, 16000000 * 1024);
  assert.equal(m.usedBytes, 12000000 * 1024);
  assert.equal(memoryFromMeminfo('MemTotal: 1 kB\n'), null);
});

test('an agent counts with everything it started, and a gone process is null', () => {
  const rows = parsePs(`
    1     0  0.0   1000
  100     1 10.0  20000
  101   100 25.5  30000
  102   101  4.5  10000
  200     1 50.0  99999
  garbage line
`);
  assert.equal(rows.length, 5);
  assert.deepEqual(treeUsage(rows, 100), { cpuPct: 40, rssBytes: 60000 * 1024, processes: 3 });
  assert.equal(treeUsage(rows, 999), null);
});

test('CPU share between two readings', () => {
  assert.equal(cpuPctBetween({ idle: 100, total: 200 }, { idle: 150, total: 400 }), 75);
  assert.equal(cpuPctBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 }), 0);
});

const sample = (over: Partial<{ pct: number; pressure: number | null; freeGb: number | null }>): HealthSample => ({
  at: 0,
  cpu: { pct: 10, cores: 8, load1: 1, load5: 1, load15: 1 },
  memory: { totalBytes: 100, usedBytes: over.pct ?? 50, pct: over.pct ?? 50, pressure: over.pressure === undefined ? 1 : over.pressure },
  disk: over.freeGb === null ? null : { totalBytes: 500 * 1024 ** 3, freeBytes: (over.freeGb ?? 100) * 1024 ** 3, pct: 50 },
  agents: [], agentsKnown: true, core: { rssBytes: 1 },
});

test('admission: critical memory pressure, nearly full memory or disk hold new work back', () => {
  const limits = admissionLimits({});
  assert.deepEqual(admissionFor(sample({}), limits), { ok: true });
  assert.equal(admissionFor(sample({ pressure: 4 }), limits).ok, false);
  assert.equal(admissionFor(sample({ pressure: 2 }), limits).ok, true, 'a warning is not enough');
  assert.match(admissionFor(sample({ pct: 95 }), limits).why!, /Memory is 95% used/);
  assert.match(admissionFor(sample({ freeGb: 1 }), limits).why!, /1\.0 GB of disk/);
  assert.deepEqual(admissionFor(sample({ pressure: null, freeGb: null }), limits), { ok: true }, 'what cannot be read does not block');
  assert.deepEqual(admissionFor(null, limits), { ok: true });
});

test('admission limits come from the environment', () => {
  const l = admissionLimits({ FRYDAY_ADMIT_RAM_PCT: '80', FRYDAY_ADMIT_DISK_MIN_GB: '10', FRYDAY_ADMIT_PRESSURE: 'nonsense' });
  assert.equal(l.ramPct, 80);
  assert.equal(l.diskMinBytes, 10 * 1024 ** 3);
  assert.equal(l.pressure, 4);
});
