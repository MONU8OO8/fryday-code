import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { takeCompleteLines, readFrom, tailText } from '../src/runner/logTail';
import { summarizeEvent } from '../src/runner/runEvents';

test('whole lines are returned and a trailing partial line is left for later', () => {
  const r = takeCompleteLines(Buffer.from('{"a":1}\n{"b":2}\n{"c":'));
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(r.consumed, 16);
});

test('no newline yet means nothing is consumed', () => {
  assert.deepEqual(takeCompleteLines(Buffer.from('{"partial":')), { lines: [], consumed: 0 });
  assert.deepEqual(takeCompleteLines(Buffer.alloc(0)), { lines: [], consumed: 0 });
});

test('blank lines are dropped and CRLF is handled', () => {
  const r = takeCompleteLines(Buffer.from('one\r\n\n  \ntwo\n'));
  assert.deepEqual(r.lines, ['one', 'two']);
  assert.equal(r.consumed, 13);
});

test('a multi-byte character split across reads is never cut', () => {
  const full = Buffer.from('{"t":"नमस्ते"}\n{"t":"ok"}\n');
  const cut = full.indexOf(Buffer.from('स')) + 1; // inside a 3-byte character
  const first = takeCompleteLines(full.subarray(0, cut));
  assert.deepEqual(first, { lines: [], consumed: 0 });
  const second = takeCompleteLines(full.subarray(first.consumed));
  assert.deepEqual(second.lines, ['{"t":"नमस्ते"}', '{"t":"ok"}']);
  assert.equal(second.consumed, full.length);
});

test('readFrom reads from an offset and treats a missing file as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-tail-'));
  const file = path.join(dir, 'log.jsonl');
  try {
    assert.equal(readFrom(file, 0).length, 0);
    fs.writeFileSync(file, 'abc\ndef\n');
    assert.equal(readFrom(file, 4).toString(), 'def\n');
    assert.equal(readFrom(file, 8).length, 0);
    assert.equal(tailText(file, 3), 'def');
    assert.equal(tailText(path.join(dir, 'missing'), 10), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeEvent keeps what the UI shows and drops the rest', () => {
  assert.equal(summarizeEvent({ type: 'system', subtype: 'hook_started' }), null);
  assert.equal(summarizeEvent({ type: 'rate_limit_event' }), null);
  assert.deepEqual(summarizeEvent({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }), {
    kind: 'init', sessionId: 's1', model: 'm',
  });
  assert.deepEqual(
    summarizeEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }] },
    }),
    // No usage in the event: the live view gets zeros, not a crash.
    { kind: 'assistant', text: 'hi', tools: ['Read'], toolInputs: [''], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  );
  assert.deepEqual(
    summarizeEvent({
      type: 'result', is_error: false, result: 'done', session_id: 's1', total_cost_usd: 0.5,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    }),
    {
      kind: 'result', isError: false, text: 'done', sessionId: 's1',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 },
    }
  );
});
