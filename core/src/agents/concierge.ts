/**
 * Fryday concierge — the agent the owner talks to from the command deck.
 *
 * Each message is one run. A conversation continues by resuming the claude session
 * of an earlier Fryday run; core only resumes sessions it started itself.
 */

import fs from 'fs';
import path from 'path';
import { getDb } from '../db/db.js';
import { getConfig } from '../config.js';
import { startRun, type RunHandle } from '../runner/supervisor.js';

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'fryday.md'), 'utf8').trim();

export class UnknownSessionError extends Error {
  constructor() {
    super('That conversation is not one Fryday started');
  }
}

/** True if `sessionId` belongs to an earlier Fryday chat run. */
export function isConciergeSession(sessionId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM runs WHERE session_id = ? AND role = 'fryday' AND task_id IS NULL LIMIT 1`)
    .get(sessionId);
  return row !== undefined;
}

export function askFryday(message: string, continueSessionId?: string): RunHandle {
  if (continueSessionId !== undefined && !isConciergeSession(continueSessionId)) {
    throw new UnknownSessionError();
  }
  return startRun({
    taskId: null,
    role: 'fryday',
    prompt: message,
    appendSystemPrompt: SYSTEM_PROMPT,
    resumeSessionId: continueSessionId,
    cwd: getConfig().conciergeDir,
  });
}
