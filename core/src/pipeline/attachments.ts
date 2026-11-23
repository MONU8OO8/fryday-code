/**
 * Documents attached to a task: a PRD, notes, a spec. Kept in the state folder, where
 * no agent can read; core copies them into the folder of the one agent that reads them.
 *
 * Accepted: Markdown, plain text and PDF. The type is decided by the content, not only
 * by the name.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDb, nowMs } from '../db/db.js';

export type Media = 'markdown' | 'text' | 'pdf';

export interface Attachment {
  id: string;
  taskId: string;
  name: string;
  media: Media;
  bytes: number;
  createdAt: number;
}

export class AttachmentError extends Error {}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TASK = 5;
const BY_EXTENSION: Record<string, Media> = { '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text', '.pdf': 'pdf' };

interface Row { id: string; task_id: string; name: string; stored_path: string; media: Media; bytes: number; created_at: number }
const toAttachment = (r: Row): Attachment => ({ id: r.id, taskId: r.task_id, name: r.name, media: r.media, bytes: r.bytes, createdAt: r.created_at });
const rows = (taskId: string) => getDb().prepare('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as Row[];

/** A file name that is safe to create anywhere: no folders, no odd characters, a known extension. */
export function safeName(given: string): string {
  const base = path.basename(given.replace(/\\/g, '/')).normalize('NFKC');
  const ext = path.extname(base).toLowerCase();
  const stem = base.slice(0, base.length - ext.length).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 60) || 'document';
  return `${stem}${ext}`;
}

function checkContent(media: Media, content: Buffer): void {
  if (media === 'pdf') {
    if (!content.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new AttachmentError('That file is named .pdf but is not a PDF');
    return;
  }
  if (content.includes(0)) throw new AttachmentError('That file is not plain text');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new AttachmentError('That file is not UTF-8 text');
  }
}

export function listAttachments(taskId: string): Attachment[] {
  return rows(taskId).map(toAttachment);
}

export function saveAttachment(taskId: string, attachmentsDir: string, givenName: string, content: Buffer): Attachment {
  const name = safeName(givenName);
  const media = BY_EXTENSION[path.extname(name).toLowerCase()];
  if (!media) throw new AttachmentError('Only .md, .txt and .pdf files can be attached');
  if (content.length === 0) throw new AttachmentError('That file is empty');
  if (content.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`That file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  if (rows(taskId).length >= MAX_ATTACHMENTS_PER_TASK) throw new AttachmentError(`A task can have at most ${MAX_ATTACHMENTS_PER_TASK} documents`);
  checkContent(media, content);

  const id = `att-${randomUUID()}`;
  const dir = path.join(attachmentsDir, taskId.replace(/[^A-Za-z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const storedPath = path.join(dir, `${id}-${name}`);
  fs.writeFileSync(storedPath, content, { mode: 0o600, flag: 'wx' });
  getDb()
    .prepare('INSERT INTO task_attachments (id, task_id, name, stored_path, media, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, taskId, name, storedPath, media, content.length, nowMs());
  return toAttachment(getDb().prepare('SELECT * FROM task_attachments WHERE id = ?').get(id) as Row);
}

/** Copy a task's documents into `destDir` (created if needed). Returns the file names written there. */
export function copyAttachments(taskId: string, destDir: string): string[] {
  const all = rows(taskId).filter((r) => fs.existsSync(r.stored_path));
  if (all.length === 0) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const used = new Set<string>();
  return all.map((r, i) => {
    const name = used.has(r.name) ? `${i + 1}-${r.name}` : r.name;
    used.add(name);
    fs.copyFileSync(r.stored_path, path.join(destDir, name));
    return name;
  });
}

const MAX_INLINE_CHARS = 12_000;

const termsOf = (text: string) => new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []));

/** A document cut at its headings (or every 40 lines when it has none). */
function sections(text: string): Array<{ title: string; text: string }> {
  const lines = text.split('\n');
  const out: Array<{ title: string; text: string }> = [];
  let title = '(start)';
  let buf: string[] = [];
  const flush = () => { if (buf.join('').trim()) out.push({ title, text: buf.join('\n').trim() }); buf = []; };
  for (const line of lines) {
    const h = line.match(/^#{1,4}\s+(.+)/);
    if (h || buf.length >= 40) { flush(); if (h) title = h[1]!.trim().slice(0, 100); }
    buf.push(line);
  }
  flush();
  return out;
}

/**
 * The task's text documents as one block, for agents that cannot be handed the files.
 * A PDF is not inlined: the Analyst has read it and its requirements are in the brief.
 * Documents longer than the budget are cut at their headings and the sections that share
 * the most words with the task are shown, in their order; the others are named, not shown.
 */
export function documentsText(taskId: string, maxChars = MAX_INLINE_CHARS, about = ''): string {
  const all = rows(taskId).filter((r) => fs.existsSync(r.stored_path));
  if (all.length === 0) return '';
  const docs = all.map((r) => ({ r, text: r.media === 'pdf' ? '' : fs.readFileSync(r.stored_path, 'utf8').trim() }));
  const total = docs.reduce((s, d) => s + d.text.length, 0);
  if (total <= maxChars) {
    const parts = docs.map(({ r, text }) => r.media === 'pdf'
      ? `### ${r.name}\n\n(A PDF. The Analyst read it; what it requires is listed in the requirements.)`
      : `### ${r.name}\n\n${text}`);
    return `## Documents from the owner\n\n${parts.join('\n\n')}`;
  }
  const want = termsOf(about);
  const all_sections = docs.flatMap(({ r, text }, di) => sections(text).map((sec, si) => {
    let shared = 0;
    for (const t of termsOf(`${sec.title} ${sec.text}`)) if (want.has(t)) shared++;
    return { di, si, name: r.name, ...sec, score: shared / Math.sqrt(sec.text.length + 50) + (si === 0 ? 0.05 : 0) };
  }));
  const chosen = new Set<string>();
  let left = maxChars;
  for (const sec of [...all_sections].sort((a, b) => b.score - a.score)) {
    if (sec.text.length > left) continue;
    chosen.add(`${sec.di}:${sec.si}`);
    left -= sec.text.length;
  }
  const parts = docs.map(({ r }, di) => {
    if (r.media === 'pdf') return `### ${r.name}\n\n(A PDF. The Analyst read it; what it requires is listed in the requirements.)`;
    const mine = all_sections.filter((x) => x.di === di);
    const shown = mine.filter((x) => chosen.has(`${x.di}:${x.si}`)).map((x) => x.text);
    const hidden = mine.filter((x) => !chosen.has(`${x.di}:${x.si}`)).map((x) => x.title);
    return `### ${r.name}\n\n${shown.join('\n\n')}${hidden.length ? `\n\n[Not shown, to stay short: ${hidden.slice(0, 20).join('; ')}. The requirements in the brief cover the whole document.]` : ''}`;
  });
  return `## Documents from the owner (the parts that bear on this task)\n\n${parts.join('\n\n')}`;
}
