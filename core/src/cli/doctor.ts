/**
 * `fryday-code doctor`: the checks of Setup → Connections, in the terminal, with the fix for
 * each one that needs it. Exits 1 when something FryDay Code needs is not working.
 */

import { checkConnections, realProbe, type CheckState, type ConnectionCheck, type ConnectionsReport } from '../connections/doctor.js';

const MARK: Record<CheckState, string> = { ok: 'ok     ', warn: 'note   ', problem: 'PROBLEM', off: 'off    ' };

/** The report as lines of text: one line per check, then its fix, indented. */
export function formatReport(report: ConnectionsReport): string[] {
  const width = Math.max(...report.checks.map((c) => c.name.length), 10);
  const lines: string[] = ['FryDay Code doctor: what works on this machine', ''];
  for (const c of report.checks) {
    lines.push(`  ${MARK[c.state]}  ${c.name.padEnd(width)}  ${c.summary}${c.required ? '' : '  (optional)'}`);
    if (c.fix && c.state !== 'ok') for (const fix of c.fix.split('\n')) lines.push(`  ${' '.repeat(7)}  ${' '.repeat(width)}  Fix: ${fix}`);
  }
  const servers = report.mcpServers.length;
  lines.push('', `  MCP servers in Claude Code's settings: ${servers}${report.mcpNote ? ` (${report.mcpNote})` : ''}. Testers use them only after you turn them on in Setup.`);
  const blocking = needed(report);
  lines.push('', blocking.length === 0
    ? 'Everything FryDay Code needs is working. Start it with: npx fryday-code (or npm start in a clone).'
    : `Not ready yet: ${blocking.map((c) => c.name).join(', ')}. Fix ${blocking.length === 1 ? 'it' : 'them'} and run the doctor again.`);
  return lines;
}

/** The checks that are needed and not working. */
export function needed(report: ConnectionsReport): ConnectionCheck[] {
  return report.checks.filter((c) => c.required && c.state === 'problem');
}

export async function main(): Promise<number> {
  const report = await checkConnections(realProbe());
  console.log(formatReport(report).join('\n'));
  return needed(report).length === 0 ? 0 : 1;
}

if (require.main === module) main().then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
