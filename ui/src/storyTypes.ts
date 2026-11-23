/** The shapes of GET /api/tasks/overview and GET /api/tasks/:id/story (core/src/pipeline/story.ts). */

export type Actor = 'understander' | 'planner' | 'builder' | 'checks' | 'checker' | 'app_tester' | 'page_tester' | 'releaser' | 'fryday' | 'you';
export type StopId = 'understand' | 'plan' | 'build' | 'check' | 'approve' | 'live';
export type StopState = 'idle' | 'active' | 'waiting' | 'done' | 'failed' | 'skipped';
export type TaskGroup = 'needs_you' | 'working' | 'waiting' | 'done';

export interface Journey {
  stops: Array<{ id: StopId; state: StopState }>;
  current: StopId | null;
  sendbacks: number;
  /**
   * live: deployed to staging by the project's deployer. on_staging: on staging, but the project has no
   * deployer, so nothing was started. handed_over: shared for review, nothing on staging. stopped: the task failed.
   */
  finished: 'live' | 'on_staging' | 'handed_over' | 'stopped' | null;
}

export type DetailRef =
  | { kind: 'brief' }
  | { kind: 'plan' }
  | { kind: 'round'; round: number; part: 'checks' | 'verdict' | 'changes' | 'verify' }
  | { kind: 'deploy' }
  | { kind: 'note' };

export type StoryAction =
  /** freeText: a written answer is accepted (a clarifying question); otherwise only an option. */
  | { kind: 'answer'; questionId: string; options: Array<{ value: string; label: string }>; freeText: boolean }
  | { kind: 'approve'; approvalId: string; plain: string; effects: string[] }
  /** A task the Lead proposes in another project: POST /api/tasks/:id/proposals/:messageId/start. */
  | { kind: 'start_task'; messageId: number; projectName: string; title: string; description: string; startedTaskId: string | null };

export interface StoryItem {
  id: string;
  at: number;
  from: Actor;
  to: Actor | null;
  kind: 'said' | 'handoff' | 'sendback' | 'question' | 'approval' | 'note' | 'outcome';
  text: string;
  round: number | null;
  details: { label: string; ref: DetailRef } | null;
  action: StoryAction | null;
  /** Screenshots core kept, served by the evidence route. */
  media?: StoryMedia[];
}

export interface StoryMedia { src: string; device: 'phone' | 'tablet' | 'desktop' | null; caption: string }

export interface StoryNow { actor: Actor; text: string; since: number }

export interface TaskStory {
  task: { id: string; title: string; state: string; projectName: string | null; createdAt: number; budget: { limitTokens: number; usedTokens: number } };
  journey: Journey;
  items: StoryItem[];
  now: StoryNow | null;
  /** What the owner may ask for again: release → POST /api/tasks/:id/approval, deploy → POST /api/tasks/:id/deploy. */
  askAgain: 'release' | 'deploy' | null;
  /**
   * A task that stopped at the round limit. tryAgain → POST /api/tasks/:id/try-again { note? };
   * accept → POST /api/tasks/:id/accept. why: the Checker's own words.
   */
  choices: { tryAgain: boolean; accept: boolean; why: string | null };
  /** Its work was discarded: nothing more can happen on it. */
  discarded?: boolean;
  /** Priority, dependencies, sub-tasks and the agent at work. Absent from an older core. */
  board?: BoardFacts;
  /** POST /api/tasks/:id/stop is available. */
  canStop?: boolean;
  /** POST /api/tasks/:id/send-back { note } is available: the work can go back to the Builder. */
  canSendBack?: boolean;
}

export interface OverviewItem {
  id: string;
  title: string;
  state: string;
  group: TaskGroup;
  line: string;
  journey: Journey;
  projectName: string | null;
  createdAt: number;
  updatedAt: number;
  /** Counted tokens the task has used so far (input + output + cache writes). */
  usedTokens: number;
  /** Where it sits on the board; null for an initiative. Absent from an older core. */
  column?: BoardColumn | null;
  board?: BoardFacts;
}

export type Priority = 'p0' | 'p1' | 'p2' | 'p3';
export type Gate = 'start' | 'release' | 'link';
export type BoardColumn = 'backlog' | 'understand' | 'plan' | 'build' | 'check' | 'needs_you' | 'live' | 'done';

/** What the board shows besides the journey (core/src/pipeline/board.ts). */
export interface BoardFacts {
  priority: Priority;
  kind: 'task' | 'initiative';
  parent: { id: string; title: string } | null;
  autoStart: boolean;
  position: number;
  dependsOn: Array<{ id: string; title: string; gate: Gate; met: boolean }>;
  /** What holds it back right now, in plain words. */
  waiting: string | null;
  /** For an initiative: its sub-tasks, in order. */
  children: string[];
  /** For an initiative: the same sub-tasks with what the page shows of each. */
  parts?: Array<{ id: string; title: string; state: string; label: string }>;
  agent: { runId: string; who: string; since: number } | null;
}
