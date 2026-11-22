/**
 * Task CRUD API
 * POST   /api/tasks          — create a task; with repoId, start the pipeline in that repo
 * GET    /api/tasks          — list tasks (paginated)
 * GET    /api/tasks/:id      — task detail + plan + runs + usage
 * PATCH  /api/tasks/:id      — update state or metadata (admin/internal)
 * DELETE /api/tasks/:id      — cancel a task
 * POST   /api/tasks/:id/start     — start the task ({ repoId?, branch? }); without a project the Analyst works it out
 * DELETE /api/tasks/:id/workspace — discard the task's worktree and branch
 * POST   /api/tasks/:id/attachments            — attach a document (raw body, file name in x-file-name)
 * POST   /api/tasks/:id/messages               — say something on the task's thread ({ body })
 * POST   /api/tasks/:id/questions/:qid/answer  — answer a question ({ answer })
 * POST   /api/tasks/:id/questions/skip         — go on without answering the open questions
 */

import express, { Router } from 'express';
import { z } from 'zod';
import { getDb, nowMs } from '../db/db.js';
import { getRunUsage, getTaskUsage } from '../runner/usage.js';
import { sseEmit } from './events.js';
import { killRun } from '../runner/supervisor.js';
import fs from 'fs';
import path from 'path';
import { startTask, stopTaskWork, StartError } from '../pipeline/pipeline.js';
import { getWorkspaces, discardWorkspaces } from '../pipeline/workspaces.js';
import { getRounds } from '../pipeline/rounds.js';
import { taskFlow } from '../pipeline/flow.js';
import { latestDeploy, askToDeployAgain } from '../deploy/deployFlow.js';
import { JenkinsError } from '../deploy/jenkins.js';
import { evidenceDir, isVerifying } from '../pipeline/verifyFlow.js';
import { ApprovalError, latestApproval, publicApproval, requestReleaseApproval } from '../pipeline/approvals.js';
import { ReleaseError, latestRelease, revertTaskRelease } from '../pipeline/releaseFlow.js';
import { setTaskNote, getTask, createTask } from '../pipeline/taskState.js';
import { ownerAnswered, stoppedChoices, tryAgainAfterStop, acceptAsItIs, StoppedError, stopTask, sendBackToBuilder } from '../pipeline/pipeline.js';
import { getConfig } from '../config.js';
import { AttachmentError, MAX_ATTACHMENT_BYTES, listAttachments, saveAttachment } from '../pipeline/attachments.js';
import { QuestionError, answerQuestion, listQuestions, skipOpenQuestions } from '../pipeline/questions.js';
import { addMessage, listMessages } from '../pipeline/thread.js';
import { parseBrief } from '../pipeline/brief.js';
import { taskStory, tasksOverview } from '../pipeline/story.js';
import { askLead, markNotesHandled, startProposal, LeadError } from '../pipeline/lead.js';

export const tasksRouter = Router();

const CreateTaskBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  /** The project. Without one, the Analyst works out which project the task is for. */
  repoId: z.string().min(1).optional(),
  /** An existing remote branch to continue on (needs repoId). */
  branch: z.string().min(1).max(200).optional(),
  /** False to create the task without starting it, so documents can be attached first. */
  start: z.boolean().optional(),
});

const StartBody = z.object({ repoId: z.string().min(1).optional(), branch: z.string().min(1).max(200).optional() });

// ─── POST /api/tasks ──────────────────────────────────────────────────────────
tasksRouter.post('/', (req, res) => {
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }

  const task = createTask(parsed.data.title, parsed.data.description);
  const id = task.id;

  // The task exists either way; a start that is refused is reported alongside it.
  let startError: string | null = null;
  if (parsed.data.start !== false) {
    try {
      startTask(id, parsed.data.repoId ?? null, { branch: parsed.data.branch });
    } catch (err) {
      if (!(err instanceof StartError)) throw err;
      startError = err.message;
    }
  }
  res.status(201).json({ ...task, startError });
});

// ─── POST /api/tasks/:id/start ────────────────────────────────────────────────
tasksRouter.post('/:id/start', (req, res) => {
  const parsed = StartBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'repoId and branch must be text' }); return; }
  try {
    startTask(req.params['id'], parsed.data.repoId ?? null, { branch: parsed.data.branch });
    res.status(202).json({ ok: true });
  } catch (err) {
    if (!(err instanceof StartError)) throw err;
    res.status(409).json({ error: err.message });
  }
});

// ─── POST /api/tasks/:id/approval ─────────────────────────────────────────────
// Ask (again) for the owner's yes to merge the task into staging, for its current commit.
tasksRouter.post('/:id/approval', (req, res) => {
  try {
    res.status(201).json(publicApproval(requestReleaseApproval(req.params['id'])));
  } catch (err) {
    if (!(err instanceof ApprovalError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

// ─── POST /api/tasks/:id/try-again · /api/tasks/:id/accept ────────────────────
// A task that stopped at the round limit: one more round for the Builder (with an optional
// note for the team), or the change taken as it is, on to the usual approval. Only the owner
// at the UI may do either.
tasksRouter.post('/:id/try-again', (req, res) => {
  if (res.locals['authVia'] !== 'cookie') { res.status(403).json({ error: 'Trying again must be asked for in the FryDay UI' }); return; }
  const id = req.params['id']!;
  if (!getTask(id)) { res.status(404).json({ error: 'Task not found' }); return; }
  if (!stoppedChoices(id).tryAgain) { res.status(409).json({ error: 'This task is not waiting for you to try again' }); return; }
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if (note) addMessage(id, 'owner', 'note', note);
  markNotesHandled(id);
  void tryAgainAfterStop(id).catch((err) => {
    console.error(`[fryday-core] trying ${id} again failed:`, err);
    setTaskNote(id, `Could not start again: ${err instanceof Error ? err.message : String(err)}`);
  });
  res.status(202).json({ ok: true });
});

tasksRouter.post('/:id/accept', (req, res) => {
  if (res.locals['authVia'] !== 'cookie') { res.status(403).json({ error: 'Accepting a change must be done in the FryDay UI' }); return; }
  const id = req.params['id']!;
  if (!getTask(id)) { res.status(404).json({ error: 'Task not found' }); return; }
  try {
    acceptAsItIs(id);
    res.json({ ok: true });
  } catch (err) {
    if (!(err instanceof StoppedError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

// ─── POST /api/tasks/:id/stop · /api/tasks/:id/send-back ──────────────────────
// Stop: agents stopped, open tickets withdrawn, a followed deploy let go of; nothing undone.
// Send back: the owner tried the work and it is not right; one more Builder round with their
// words. Both are the owner's, at the UI only.
function stoppedReply(res: express.Response, work: () => Promise<void>): void {
  work().then(() => res.json({ ok: true })).catch((err) => {
    if (err instanceof StoppedError) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[fryday-core] task action failed:', err);
    res.status(500).json({ error: 'It could not be done; see the core log' });
  });
}

tasksRouter.post('/:id/stop', (req, res) => {
  if (res.locals['authVia'] !== 'cookie') { res.status(403).json({ error: 'Stop a task from the FryDay UI' }); return; }
  const id = req.params['id']!;
  if (!getTask(id)) { res.status(404).json({ error: 'Task not found' }); return; }
  stoppedReply(res, () => stopTask(id));
});

tasksRouter.post('/:id/send-back', (req, res) => {
  if (res.locals['authVia'] !== 'cookie') { res.status(403).json({ error: 'Send work back from the FryDay UI' }); return; }
  const id = req.params['id']!;
  if (!getTask(id)) { res.status(404).json({ error: 'Task not found' }); return; }
  const note = typeof req.body?.note === 'string' ? req.body.note : '';
  stoppedReply(res, async () => { await sendBackToBuilder(id, note); markNotesHandled(id); });
});

// ─── POST /api/tasks/:id/release/revert ───────────────────────────────────────
// Undo the task's merge on staging with a revert commit. Only the owner at the UI may do this.
tasksRouter.post('/:id/release/revert', (req, res) => {
  if (res.locals['authVia'] !== 'cookie') { res.status(403).json({ error: 'A revert must be confirmed in the Fryday UI' }); return; }
  const release = latestRelease(req.params['id']);
  if (!release || release.state !== 'pushed' || !release.merge_sha) {
    res.status(409).json({ error: 'There is no merge on staging to revert for this task' });
    return;
  }
  const id = req.params['id'];
  void revertTaskRelease(id).catch((err) => {
    console.error(`[fryday-core] revert for ${id} failed:`, err);
    setTaskNote(id, `The revert failed: ${err instanceof ReleaseError || err instanceof Error ? err.message : String(err)}`);
  });
  res.status(202).json({ ok: true });
});

// ─── POST /api/tasks/:id/deploy ───────────────────────────────────────────────
// Ask again to deploy staging (after a deploy that failed, stopped or was declined).
tasksRouter.post('/:id/deploy', (req, res) => {
  const id = req.params['id'];
  const release = latestRelease(id);
  if (!release || release.state !== 'pushed') { res.status(409).json({ error: 'This task has nothing on staging to deploy' }); return; }
  try {
    const ticket = askToDeployAgain(id, release);
    res.status(201).json({ approval: publicApproval(ticket) });
  } catch (err) {
    if (!(err instanceof JenkinsError)) throw err;
    res.status(409).json({ error: err.message });
  }
});

// ─── DELETE /api/tasks/:id/workspace ──────────────────────────────────────────
// Removes the task's worktree and its local branch. Refused while an agent is on it.
tasksRouter.delete('/:id/workspace', (req, res) => {
  const db = getDb();
  const id = req.params['id'];
  const running = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND state = 'running'`).get(id) as { n: number };
  if (running.n > 0) { res.status(409).json({ error: 'An agent is still working on this task; stop it first' }); return; }
  if (latestRelease(id)?.state === 'running') { res.status(409).json({ error: 'This task is being released right now' }); return; }
  if (isVerifying(id)) { res.status(409).json({ error: 'This task is being verified right now; stop the task first' }); return; }
  res.json({ ok: true, removed: discardWorkspaces(id) });
});

// ─── Documents, thread and questions ──────────────────────────────────────────

// A document for the task. Only before it starts or while it waits for the owner: later nobody would read it.
tasksRouter.post('/:id/attachments', express.raw({ type: 'application/octet-stream', limit: MAX_ATTACHMENT_BYTES }), (req, res) => {
  const task = getTask(req.params['id']!);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
  if (task.state !== 'queued' && task.state !== 'waiting_owner') {
    res.status(409).json({ error: 'Documents can be attached before the task starts, or while it is waiting for your answer' });
    return;
  }
  let name = '';
  try {
    name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
  } catch {
    /* handled below */
  }
  if (!name || !Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'Send the file as the request body with its name in x-file-name' }); return; }
  try {
    res.status(201).json(saveAttachment(task.id, getConfig().attachmentsDir, name, req.body));
  } catch (err) {
    if (!(err instanceof AttachmentError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

tasksRouter.post('/:id/messages', (req, res) => {
  const task = getTask(req.params['id']!);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) { res.status(400).json({ error: 'The message is empty' }); return; }
  const message = addMessage(task.id, 'owner', 'note', body);
  // The Lead reads it and answers in the chat; { lead: false } keeps it a plain note.
  if (req.body?.lead !== false) askLead(task.id);
  res.status(201).json(message);
});

// The owner starts a task the Lead proposed in another project. At the UI only.
tasksRouter.post('/:id/proposals/:mid/start', (req, res) => {
  if (res.locals['authVia'] !== 'cookie') { res.status(403).json({ error: 'Start a proposed task from the FryDay UI' }); return; }
  const id = req.params['id']!;
  if (!getTask(id)) { res.status(404).json({ error: 'Task not found' }); return; }
  try {
    res.status(201).json(startProposal(id, Number(req.params['mid'])));
  } catch (err) {
    if (!(err instanceof LeadError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

function questionReply(res: express.Response, work: () => unknown): void {
  try {
    res.json(work());
  } catch (err) {
    if (!(err instanceof QuestionError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

tasksRouter.post('/:id/questions/skip', (req, res) => {
  const id = req.params['id']!;
  if (!getTask(id)) { res.status(404).json({ error: 'Task not found' }); return; }
  questionReply(res, () => ({ skipped: skipOpenQuestions(id), resumed: ownerAnswered(id) }));
});

tasksRouter.post('/:id/questions/:qid/answer', (req, res) => {
  const id = req.params['id']!;
  if (!getTask(id)) { res.status(404).json({ error: 'Task not found' }); return; }
  const answer = typeof req.body?.answer === 'string' ? req.body.answer : '';
  questionReply(res, () => ({ question: answerQuestion(id, req.params['qid']!, answer), resumed: ownerAnswered(id) }));
});

// ─── GET /api/tasks ───────────────────────────────────────────────────────────
tasksRouter.get('/', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(String(req.query['limit'] ?? 50), 10), 200);
  const offset = parseInt(String(req.query['offset'] ?? 0), 10);
  const state = req.query['state'] as string | undefined;

  const where = state ? `WHERE state = ?` : '';
  const params = state ? [state, limit, offset] : [limit, offset];
  const tasks = db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params);
  const total = (db.prepare(`SELECT COUNT(*) as n FROM tasks ${where}`).get(...(state ? [state] : [])) as { n: number }).n;

  res.json({ tasks, total, limit, offset });
});

// ─── GET /api/tasks/overview ──────────────────────────────────────────────────
// Every recent task with its group, one plain line and its journey (the simple UI's list).
// Registered before /:id, so "overview" is never read as a task id.
tasksRouter.get('/overview', (_req, res) => {
  res.json({ tasks: tasksOverview() });
});

// ─── GET /api/tasks/:id/story ─────────────────────────────────────────────────
// The team chat, the journey and what is happening now, built from stored facts.
tasksRouter.get('/:id/story', (req, res) => {
  const story = taskStory(req.params['id']!);
  if (!story) { res.status(404).json({ error: 'Task not found' }); return; }
  res.json(story);
});

// ─── GET /api/tasks/:id ───────────────────────────────────────────────────────
tasksRouter.get('/:id', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params['id']);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

  const runs = db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC').all(req.params['id']);
  const runsWithUsage = (runs as Array<{ id: string } & Record<string, unknown>>).map((r) => ({
    ...r,
    usage: getRunUsage(r.id),
  }));
  const usage = getTaskUsage(req.params['id']);
  const workspaces = getWorkspaces(req.params['id']).map((w) => ({
    repoId: w.repo_id,
    branch: w.branch,
    baseRef: w.base_ref,
    baseSha: w.base_sha,
    headSha: w.head_sha,
    worktreePath: w.worktree_path,
    removed: w.removed_at !== null,
    files: w.files_json ? JSON.parse(w.files_json) : [],
    // For a task that continues an existing branch.
    targetBranch: w.target_branch,
    targetOwned: w.target_branch ? w.target_owned === 1 : null,
    pushedRef: w.pushed_ref,
    pushedSha: w.pushed_sha,
  }));

  const approval = latestApproval(req.params['id']);
  res.json({
    task, runs: runsWithUsage, usage, workspaces,
    brief: parseBrief((task as { brief_json: string | null }).brief_json),
    questions: listQuestions(req.params['id']),
    attachments: listAttachments(req.params['id']),
    thread: listMessages(req.params['id']),
    rounds: getRounds(req.params['id']),
    approval: approval ? publicApproval(approval) : null,
    release: latestRelease(req.params['id']) ?? null,
    flow: taskFlow(req.params['id']),
    deploy: latestDeploy(req.params['id']) ?? null,
  });
});

// ─── GET /api/tasks/:id/evidence/:round/:name ─────────────────────────────────
// A screenshot a tester took. Only image files core itself kept are served.
tasksRouter.get('/:id/evidence/:round/:name', (req, res) => {
  const round = Number(req.params['round']);
  const name = req.params['name'];
  const id = req.params['id'];
  if (!/^T-\d+$/.test(id) || !Number.isInteger(round) || round < 1 || !/^[\w.-]+\.(png|jpe?g)$/i.test(name) || name.includes('..')) {
    res.status(400).json({ error: 'Not a screenshot' });
    return;
  }
  const file = path.join(evidenceDir(id, round), name);
  if (!fs.existsSync(file)) { res.status(404).json({ error: 'Not found' }); return; }
  res.setHeader('content-type', /\.png$/i.test(name) ? 'image/png' : 'image/jpeg');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'private, max-age=3600');
  fs.createReadStream(file).pipe(res);
});

// ─── PATCH /api/tasks/:id ─────────────────────────────────────────────────────
tasksRouter.patch('/:id', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params['id']);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

  const allowed = ['state', 'plan_json', 'metadata_json'] as const;
  const updates: string[] = [];
  const values: unknown[] = [];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(typeof req.body[key] === 'object' ? JSON.stringify(req.body[key]) : req.body[key]);
    }
  }

  if (updates.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
  updates.push('updated_at = ?');
  values.push(nowMs(), req.params['id']);

  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params['id']);
  sseEmit({ type: 'task_updated', task: updated });
  res.json(updated);
});

// ─── DELETE /api/tasks/:id ────────────────────────────────────────────────────
tasksRouter.delete('/:id', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params['id']) as { state: string } | undefined;
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

  // Kill any running runs
  const runs = db.prepare(`SELECT id FROM runs WHERE task_id = ? AND state = 'running'`).all(req.params['id']) as Array<{ id: string }>;
  for (const run of runs) killRun(run.id);

  db.prepare(`UPDATE tasks SET state = 'failed', updated_at = ? WHERE id = ?`).run(nowMs(), req.params['id']);
  // A service core started for this task is stopped with it.
  void stopTaskWork(req.params['id']).catch((err) => console.error(`[fryday-core] could not stop the work of ${req.params['id']}:`, err));
  sseEmit({ type: 'task_cancelled', taskId: req.params['id'] });
  res.json({ ok: true });
});
