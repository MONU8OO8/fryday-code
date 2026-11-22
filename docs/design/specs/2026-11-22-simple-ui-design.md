# Simple UI — design

Date: 2026-11-22 · Status: approved by the owner, not built

## Goal

Someone who is not a developer can give FryDay Code a task, follow how the agents pass it along,
answer their questions and approve a release, without learning developer words. Setup stays with a
developer, done once, in its own place.

## Decisions (made with the owner)

| Question | Decision |
| --- | --- |
| Who the simple UI is for | A person who gives tasks, watches, answers and approves. A developer does setup. |
| How agent teamwork is shown | A **journey line** (where the task is) with the **team chat** under it (what the agents say). |
| Main screen | **Chat app**: tasks listed on the left, the open task's journey and chat on the right. A single column on narrow windows. |
| Look | **Light and friendly**, switching to a **calm dark** theme when macOS is in dark mode. Ordinary readable font, no code-style text. |
| Agent names | **Plain job names**, each with one icon and colour. |
| How to build it | **New simple screens** on the existing engine. Today's detailed screens stay, restyled, behind Setup and "Technical details". |

## Names and journey stops

Agents (UI wording only; roles in core keep their ids):

| Core role / flow node | Shown as | Icon |
| --- | --- | --- |
| `analyst` | Understander | 🔎 |
| `planner` | Planner | 🗺️ |
| `coder` | Builder | 🛠️ |
| `checks` (core) | Automatic checks | ✔️ |
| `tester` / `reviewer` | Checker | 🧪 |
| `api_tester` | App tester | 📡 |
| `ui_tester` | Page tester | 🖥️ |
| `owner` | You | 🙋 |
| `release`, `deploy` (core) | Releaser | 🚀 |
| `fryday` (concierge) | FryDay | ⚡ |

The journey line has six stops, each a group of flow nodes from `core/src/pipeline/flow.ts`:

| Stop | Flow nodes | Done when |
| --- | --- | --- |
| Understand | analyst | the brief is stored |
| Plan | planner | the plan is stored |
| Build | coder | the coder's latest run completed |
| Check | checks, reviewer, api_tester, ui_tester | the latest round passed |
| Your OK | owner | the approval for that round is resolved |
| Live | release, deploy | merged (and deployed, when the project has a deployer) |

A stop's state comes from its nodes: *active* if any node is active, *waiting* if the owner node
waits, *failed* if the latest round failed, *done* if all non-skipped nodes are done, *idle*
otherwise. The number of send-backs comes from `edges` of kind `sendback`.

## Screens

Menu: **Home**, **History**, **Setup**, and this week's spending on the right of the top bar. Routes: `/home` (default), `/home/:taskId`, `/history`,
`/setup`, `/setup/<area>`. Old routes (`/command`, `/tasks`, `/tasks/:id`, `/agents`, `/repos`,
`/connections`, `/settings`) redirect to their new places.

### Home

- Left column:
  - **New task** button.
  - Tasks grouped **Needs you** (waiting for an answer or approval), **Agents working**,
    **Done this week**.
  - Each item shows the title, one plain line about where it is, and a 6-segment mini journey.
- Right side: the open task.
  - Header: title, project name, how long ago it started, "$x of $y spent".
  - **Journey line** (the six stops above).
  - **Right now**: one sentence about what the working agent is doing (see *Plain words*).
  - **Team chat** (see *Story*), newest at the bottom. It follows new items unless the user has
    scrolled up.
  - **Reply box**: sends a note to the task (the existing owner-notes endpoint).
- No task open: the "What do you want done?" box and a short "how it works" strip of the six stops.

### New task

- One box, "What do you want done?", taking text and dropped documents (PDF, Markdown, text, as
  today).
- **Project**: "Let FryDay work it out" by default, or a pick from the confirmed projects.
- **More options** (closed by default): continue an existing branch.
- Uses the existing create and start endpoints; no new core behaviour.

### Questions and approvals in the chat

- An open question is a card in the chat, with its options as buttons and a free-text answer.
- An approval is a card that says **in plain words what will happen**. Example: "The change is added
  to Shop backend and put on staging. Nothing goes live for customers." It has **Approve** and
  **Not yet** buttons. Under **Technical details** it lists every push and deploy effect, word for
  word as today's ticket. Approving still goes through the existing approval endpoint; the plain
  sentence is extra and never replaces the list.
- Spending-limit stops ("continue?") are approval cards too: "The Builder used its $4 limit. Let it
  go on?"

### History

Finished tasks (live, handed over, stopped), newest first, with outcome, rounds and cost; this week's
spending; spending per agent (today's by-role numbers, in plain words). Opening one shows the same
task view, read-only.

### Setup

A checklist page for the developer. Each step shows done / to do / optional and opens today's screen
for it, restyled:

| Step | Opens | Done when |
| --- | --- | --- |
| Claude Code | the machine checks from Connections | the doctor's `claude` and `sandbox` checks are ok |
| Your projects | Projects | at least one confirmed project |
| Chat space | Chat space and reading cards | webhook set (reading is optional) |
| Staging deploys | Jenkins card + project deployer fields | optional |
| Agents | Settings (models, limits, engines) | always done (defaults work) |
| Data for testing | Data connections | optional |

The Agents page of today (live runs, by-role usage) moves to Setup → Agents as "Activity".

### Technical details

Every chat item that has more behind it carries a "details" link: the plan, files changed, check
output, reviewer evidence, tester screenshots, token counts. These open today's detail panels from
`TaskDetail.tsx`, moved into a drawer, so nothing a developer needs is lost.

## Story: the team chat (new core contract)

Core builds the chat from facts it already stores. No model writes these lines, except where the
text is an agent's own stored output (the brief summary, the plan summary, a verdict summary).

`GET /api/tasks/:id/story` returns `{ items: StoryItem[]; now: StoryNow | null }`.

```ts
type Actor = 'understander' | 'planner' | 'builder' | 'checks' | 'checker' | 'app_tester'
           | 'page_tester' | 'releaser' | 'fryday' | 'you';

interface StoryItem {
  id: string;              // stable: `${kind}:${source id}`, so the UI animates only new items
  at: number;              // ms
  from: Actor;
  to: Actor | null;        // set for a hand-off or a send-back
  kind: 'said' | 'handoff' | 'sendback' | 'question' | 'approval' | 'note' | 'outcome';
  text: string;            // one or two plain sentences, no file paths or tool names
  round: number | null;
  details: { label: string; ref: DetailRef } | null;
  // Set for kind 'question' and 'approval' while it is open.
  action: { kind: 'answer'; questionId: string; options: Array<{ value: string; label: string }> }
        | { kind: 'approve'; approvalId: string; plain: string; effects: string[] }
        | null;
}

type DetailRef =
  | { kind: 'brief' } | { kind: 'plan' }
  | { kind: 'round'; round: number; part: 'checks' | 'verdict' | 'changes' | 'verify' }
  | { kind: 'deploy' };

interface StoryNow {
  actor: Actor;
  text: string;            // "Running the tests", "Reading the order code"
  since: number;
}
```

Sources, in time order:

| Fact (table / module) | Item |
| --- | --- |
| `tasks.brief_json` (`brief.ts`) | Understander *said*: the brief summary |
| questions (`questions.ts`) | *question* from the asker; answered ones show the answer as *you* |
| `tasks.plan_json` (`review.ts`) | Planner → Builder *handoff*: summary + number of criteria |
| coder run completed + round created (`rounds.ts`) | Builder → Checks *handoff*: "Done, please check" + files changed |
| round gate failed | Checks → Builder *sendback*: which checks failed, in words |
| round verdict | Checker → Builder *sendback* (unmet criteria), or Checker *said* "meets the criteria" |
| verification report (`verify/report.ts`) | App tester / Page tester *said* / *sendback*, with what was tried |
| owner notes (`thread.ts`) | *note* from you |
| approvals (`approvals.ts`) | *approval*, with plain text and the effects list |
| release, deploy (`releaseFlow.ts`, `deploy/deployFlow.ts`) | Releaser *outcome*: merged / on staging / failed |
| `task_messages` events by agents | *said* by that agent |

`now` comes from the live run's latest activity (`runEvents.ts` `recentActivity`) through a fixed
translation of tool names to words: Read/Grep/Glob → "Reading the code", Edit/Write → "Changing
<area>", Bash → "Running <the check's name>" or "Running a command", fryday_service → "Trying the
app", fryday_browser → "Using the pages". Paths are never shown; a place in the code is named by its
file or folder name without extension ("the cart code").

The builder is a pure function `buildStory(input): StoryItem[]` in `core/src/pipeline/story.ts`,
fed by a small DB reader, like `flow.ts`. The SSE events that already exist (`task_message`,
`run_started`, round and approval events) tell the UI to fetch the story again.

## Plain words

- UI text lives in `ui/src/plain.ts`: actor names and icons, stop names, state sentences, money
  formatting ("$0.90"), and relative times ("12 min ago").
- Words that never appear outside Technical details or Setup: token, MCP, worktree, run, round
  (shown as "fixed once / twice"), diff, commit, branch (except in More options), CI, sandbox, guard.
- Buttons say what they do: "Approve", "Not yet", "Answer", "Start", "Let it go on".

## Look and motion

- Theme in CSS variables: a light set and a dark set chosen by `prefers-color-scheme`. Tailwind reads
  the variables. The current HUD colours and the monospace font leave the main screens; monospace
  stays only inside technical panels.
- Motion:
  - On a hand-off, a card moves along the journey line from one stop to the next (~600 ms).
  - The current stop pulses.
  - A send-back draws the dashed loop and bumps its count.
  - New chat items slide in; a working agent shows a typing indicator.
  - Reaching Live shows a short check-mark burst.
- All motion respects `prefers-reduced-motion` and runs only while the tab is visible: a hidden tab
  updates its state without animating.

## What does not change

Core behaviour, approvals, guard, sandbox, the pipeline, the existing APIs (the old screens keep
using them). Only one route is added (`/story`). The flow model stays the source of where a task is;
the journey line is a grouping of it.

## Testing

- `core/test/story.test.ts`: `buildStory` from stored facts, like `flow.test.ts`.
  - Clean task: understand → plan → build → check → your OK → live.
  - A check send-back and a reviewer send-back.
  - Open and answered questions.
  - A spending-limit stop.
  - An approval's effects copied word for word.
  - No file paths or tool names in `text`.
  - Stable ids across calls.
- `core/test/journey.test.ts` and `core/test/plainWords.test.ts`: the stop grouping and the `now`
  translation live in core (the UI has no test runner), so they are tested there. The story response
  also carries the journey, so the UI only draws it.
- Old routes redirect: checked in the browser walkthrough.
- A walkthrough in the browser pane on a scratch install: create a task, follow it to the approval,
  approve, then see History and Setup, in light and dark mode and with reduced motion.
- `npm test`, `npm run e2e` and `npm run fresh` stay green; `redteam` is not affected (no new
  agent reach).

## Out of scope

Setup wizards beyond the checklist (the existing screens are restyled, not rebuilt); phone layout
beyond the single-column fallback; renaming roles in core; changing what agents do; translations into
other languages.
