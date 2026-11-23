/**
 * How the machine is doing: CPU, memory, disk and what each running agent uses.
 *
 * Sampled every few seconds and kept for the last 15 minutes in memory (nothing is written
 * to disk). The UI shows it; the scheduler asks `admission()` before it starts more work.
 *
 * Reads only what the OS reports about itself (os module, vm_stat or /proc/meminfo, statfs,
 * ps). It never reads a project's files, and it never sends a path to the UI.
 */

import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { getDb } from '../db/db.js';
import { getConfig } from '../config.js';
import { sseEmit } from '../api/events.js';
import { memoryPressureLevel } from '../pipeline/checks.js';

const SAMPLE_MS = 5_000;
const KEEP = (15 * 60 * 1000) / SAMPLE_MS;

export interface AgentUsage {
  runId: string;
  taskId: string | null;
  role: string;
  /** Sum over the agent's process and everything it started. */
  cpuPct: number;
  rssBytes: number;
  processes: number;
}

export interface HealthSample {
  at: number;
  cpu: { pct: number; cores: number; load1: number; load5: number; load15: number };
  memory: { totalBytes: number; usedBytes: number; pct: number; pressure: number | null };
  /** The volume FryDay keeps its state on. Null where it cannot be read. */
  disk: { totalBytes: number; freeBytes: number; pct: number } | null;
  agents: AgentUsage[];
  /** False when the process list could not be read; `agents` is then empty, not "none running". */
  agentsKnown: boolean;
  core: { rssBytes: number };
}

export interface Admission {
  ok: boolean;
  why?: string;
}

// ─── Pure parsers (tested directly) ───────────────────────────────────────────

/** macOS `vm_stat` output → used and available bytes. Available: free, inactive, speculative and purgeable pages. */
export function memoryFromVmStat(text: string, totalBytes: number): { usedBytes: number; availableBytes: number } | null {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string) => {
    const m = text.match(new RegExp(`^${label}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  const free = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
  if (free === 0) return null;
  const availableBytes = Math.min(totalBytes, free * pageSize);
  return { usedBytes: totalBytes - availableBytes, availableBytes };
}

/** Linux /proc/meminfo → used and available bytes (MemAvailable is the kernel's own estimate). */
export function memoryFromMeminfo(text: string): { totalBytes: number; usedBytes: number; availableBytes: number } | null {
  const kb = (label: string) => {
    const m = text.match(new RegExp(`^${label}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (total === null || available === null) return null;
  return { totalBytes: total, usedBytes: total - available, availableBytes: available };
}

export interface PsRow { pid: number; ppid: number; cpu: number; rssKb: number }

/** `ps -A -o pid=,ppid=,pcpu=,rss=` → rows. Lines that do not parse are skipped. */
export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [pid, ppid, cpu, rss] = parts.map(Number) as [number, number, number, number];
    if ([pid, ppid, cpu, rss].every(Number.isFinite)) rows.push({ pid, ppid, cpu, rssKb: rss });
  }
  return rows;
}

/** What a process and all its descendants use together. Null when the process is gone. */
export function treeUsage(rows: PsRow[], rootPid: number): { cpuPct: number; rssBytes: number; processes: number } | null {
  if (!rows.some((r) => r.pid === rootPid)) return null;
  const children = new Map<number, PsRow[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r); else children.set(r.ppid, [r]);
  }
  let cpuPct = 0, rssBytes = 0, processes = 0;
  const seen = new Set<number>();
  const stack = [rows.find((r) => r.pid === rootPid)!];
  while (stack.length) {
    const r = stack.pop()!;
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    cpuPct += r.cpu;
    rssBytes += r.rssKb * 1024;
    processes += 1;
    for (const c of children.get(r.pid) ?? []) stack.push(c);
  }
  return { cpuPct: Math.round(cpuPct * 10) / 10, rssBytes, processes };
}

export interface CpuTimes { idle: number; total: number }

export function cpuTimes(cpus: os.CpuInfo[] = os.cpus()): CpuTimes {
  let idle = 0, total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

/** Busy share between two readings, 0–100. */
export function cpuPctBetween(prev: CpuTimes, next: CpuTimes): number {
  const total = next.total - prev.total;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - (next.idle - prev.idle) / total) * 1000) / 10));
}

export interface AdmissionLimits { ramPct: number; diskMinBytes: number; pressure: number }

export function admissionLimits(env: NodeJS.ProcessEnv = process.env): AdmissionLimits {
  const num = (name: string, fallback: number) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    ramPct: num('FRYDAY_ADMIT_RAM_PCT', 92),
    diskMinBytes: num('FRYDAY_ADMIT_DISK_MIN_GB', 2) * 1024 ** 3,
    pressure: num('FRYDAY_ADMIT_PRESSURE', 4),
  };
}

/** Whether the machine can take one more agent, from a sample. Unreadable values do not block. */
export function admissionFor(sample: HealthSample | null, limits: AdmissionLimits = admissionLimits()): Admission {
  if (!sample) return { ok: true };
  if (sample.memory.pressure !== null && sample.memory.pressure >= limits.pressure) return { ok: false, why: 'The machine is short of memory' };
  if (sample.memory.pct >= limits.ramPct) return { ok: false, why: `Memory is ${Math.round(sample.memory.pct)}% used` };
  if (sample.disk && sample.disk.freeBytes < limits.diskMinBytes) return { ok: false, why: `Only ${(sample.disk.freeBytes / 1024 ** 3).toFixed(1)} GB of disk is free` };
  return { ok: true };
}

// ─── Reading the machine ──────────────────────────────────────────────────────

function readMemory(): HealthSample['memory'] {
  const pressure = memoryPressureLevel();
  const total = os.totalmem();
  let used: number | null = null;
  try {
    if (process.platform === 'darwin') used = memoryFromVmStat(execFileSync('vm_stat', { encoding: 'utf8', timeout: 2_000 }), total)?.usedBytes ?? null;
    else if (process.platform === 'linux') used = memoryFromMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'))?.usedBytes ?? null;
  } catch {
    used = null;
  }
  // os.freemem() counts reclaimable cache as used on macOS, so it is only the last resort.
  const usedBytes = used ?? total - os.freemem();
  return { totalBytes: total, usedBytes, pct: Math.round((usedBytes / total) * 1000) / 10, pressure };
}

function readDisk(): HealthSample['disk'] {
  try {
    const s = fs.statfsSync(getConfig().home);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    if (!(totalBytes > 0)) return null;
    return { totalBytes, freeBytes, pct: Math.round((1 - freeBytes / totalBytes) * 1000) / 10 };
  } catch {
    return null;
  }
}

function readAgents(): { agents: AgentUsage[]; known: boolean } {
  const running = getDb().prepare(`SELECT id, task_id, role, pid FROM runs WHERE state = 'running' AND pid IS NOT NULL`).all() as Array<{ id: string; task_id: string | null; role: string; pid: number }>;
  if (!running.length) return { agents: [], known: true };
  let rows: PsRow[];
  try {
    rows = parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pcpu=,rss='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch {
    return { agents: [], known: false };
  }
  const agents: AgentUsage[] = [];
  for (const r of running) {
    const usage = treeUsage(rows, r.pid);
    if (usage) agents.push({ runId: r.id, taskId: r.task_id, role: r.role, ...usage });
  }
  return { agents, known: true };
}

let lastCpu: CpuTimes | null = null;
const samples: HealthSample[] = [];
let timer: NodeJS.Timeout | null = null;

export function takeSample(): HealthSample {
  const now = cpuTimes();
  // The first reading has nothing to compare with: it shows the average since the machine started.
  const pct = cpuPctBetween(lastCpu ?? { idle: 0, total: 0 }, now);
  lastCpu = now;
  const [load1, load5, load15] = os.loadavg() as [number, number, number];
  const { agents, known } = readAgents();
  const sample: HealthSample = {
    at: Date.now(),
    cpu: { pct, cores: os.cpus().length, load1, load5, load15 },
    memory: readMemory(),
    disk: readDisk(),
    agents,
    agentsKnown: known,
    core: { rssBytes: process.memoryUsage().rss },
  };
  samples.push(sample);
  if (samples.length > KEEP) samples.splice(0, samples.length - KEEP);
  return sample;
}

export function latestSample(): HealthSample | null {
  return samples[samples.length - 1] ?? null;
}

export function sampleHistory(): HealthSample[] {
  return [...samples];
}

export function admission(): Admission {
  return admissionFor(latestSample());
}

/** Call once at startup. */
export function startHealthSampler(): void {
  if (timer) return;
  const tick = () => {
    try {
      sseEmit({ type: 'health', sample: takeSample(), admission: admission() });
    } catch (err) {
      console.error('[fryday-core] health sample failed:', err);
    }
  };
  tick();
  timer = setInterval(tick, SAMPLE_MS);
  timer.unref();
}

export function stopHealthSampler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
