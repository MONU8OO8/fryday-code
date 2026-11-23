/**
 * A task's diff, cut to a budget: every file is named with how much it changed, and hunks are
 * shown best first (files the feedback or criteria mention, then small files) until the
 * budget is used. What is left out is listed, so a reader knows to open diff.patch for it.
 *
 * A diff grows every round; the whole of it read again each time was one of the larger costs.
 */

export interface DiffFile { path: string; header: string; hunks: Array<{ head: string; body: string; added: number; removed: number }> }

export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffFile['hunks'][number] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/);
      cur = { path: m?.[1] ?? line.slice(11), header: line, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      hunk = { head: line, body: '', added: 0, removed: 0 };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) { cur.header += `\n${line}`; continue; }
    hunk.body += `${line}\n`;
    if (line.startsWith('+')) hunk.added++;
    else if (line.startsWith('-')) hunk.removed++;
  }
  return files;
}

const words = (text: string) => new Set((text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []));

/**
 * The diff within `budgetChars`, as text. `focus` is text the reader cares about (feedback,
 * criteria): files and hunks sharing words with it come first.
 */
export function budgetedDiff(patch: string, budgetChars: number, focus = ''): { text: string; complete: boolean } {
  if (patch.length <= budgetChars) return { text: patch, complete: true };
  const files = parseDiff(patch);
  const want = words(focus);
  const stat = files.map((f) => {
    const add = f.hunks.reduce((s, h) => s + h.added, 0);
    const del = f.hunks.reduce((s, h) => s + h.removed, 0);
    return ` ${f.path} | +${add} −${del}`;
  }).join('\n');
  const ranked = files.flatMap((f, fi) => f.hunks.map((h, hi) => {
    const mentioned = focus.includes(f.path) || focus.includes(f.path.split('/').pop()!) ? 3 : 0;
    let shared = 0;
    for (const w of words(h.body)) if (want.has(w)) shared++;
    return { fi, hi, score: mentioned + Math.min(shared, 10) / 5 - h.body.length / 20000 };
  })).sort((a, b) => b.score - a.score);

  let left = budgetChars - stat.length - 200;
  const keep = new Set<string>();
  for (const r of ranked) {
    const h = files[r.fi]!.hunks[r.hi]!;
    const size = h.head.length + h.body.length + 2;
    if (size > left) continue;
    keep.add(`${r.fi}:${r.hi}`);
    left -= size;
  }
  const out: string[] = [`Changed files:\n${stat}`];
  const left_out: string[] = [];
  files.forEach((f, fi) => {
    const shown = f.hunks.map((h, hi) => (keep.has(`${fi}:${hi}`) ? `${h.head}\n${h.body}` : null));
    const skipped = f.hunks.filter((_, hi) => !keep.has(`${fi}:${hi}`));
    if (shown.some(Boolean)) out.push(`${f.header}\n${shown.filter(Boolean).join('')}`.trimEnd());
    if (skipped.length) left_out.push(`${f.path}: ${skipped.length} hunk${skipped.length === 1 ? '' : 's'} (${skipped.map((h) => h.head.match(/\+(\d+)/)?.[1] ?? '?').map((l) => `line ${l}`).join(', ')})`);
  });
  if (left_out.length) out.push(`Not shown here, to save room (open diff.patch for them):\n${left_out.map((l) => `- ${l}`).join('\n')}`);
  return { text: out.join('\n\n'), complete: false };
}
