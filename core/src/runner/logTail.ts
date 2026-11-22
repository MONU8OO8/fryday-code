/**
 * Reading a run's JSONL log incrementally.
 *
 * An agent writes its event stream straight to a log file, and core follows that file
 * by byte offset. Because the offset is stored, core can stop and start again without
 * losing or repeating events — that is what makes a run survive a core restart.
 */

import fs from 'fs';

const NEWLINE = 0x0a;

export interface CompleteLines {
  /** Whole lines found, without their line terminators. Blank lines are dropped. */
  lines: string[];
  /** Bytes used up, always ending just after a newline. A trailing partial line is left for later. */
  consumed: number;
}

/** Split a chunk into the whole lines it contains; never cuts a line or a UTF-8 character in half. */
export function takeCompleteLines(chunk: Buffer): CompleteLines {
  const lastNewline = chunk.lastIndexOf(NEWLINE);
  if (lastNewline === -1) return { lines: [], consumed: 0 };
  const lines = chunk
    .subarray(0, lastNewline)
    .toString('utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '');
  return { lines, consumed: lastNewline + 1 };
}

/** Read everything in `filePath` from `offset` to the current end. A missing file reads as empty. */
export function readFrom(filePath: string, offset: number): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return Buffer.alloc(0);
    const buf = Buffer.alloc(size - offset);
    const read = fs.readSync(fd, buf, 0, buf.length, offset);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** Last `maxChars` characters of a text file, for error messages. A missing file reads as ''. */
export function tailText(filePath: string, maxChars: number): string {
  try {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return '';
  }
}
