# Working on FryDay Code

FryDay Code runs AI agents on a developer's own machine against their real repositories. The code in
this repo decides what those agents can touch. Treat every change as security-relevant.

## Layout

- `core/` — the engine (TypeScript, run with tsx; Express, better-sqlite3). Entry: `core/src/server.ts`.
  Docker detection and the sandbox's nested mode are in `core/src/platform.ts` (Docker only); on Linux
  the testers are not offered (`verify/service.ts` `serviceUnreachableReason`).
  - `runner/` starts and follows agents; `runner/runners.ts` holds the engines (Claude Code, Cursor CLI, SSH stub) · `guard/` what an agent may do · `pipeline/` the task flow,
    intake, checks, verification, pushes, release · `verify/` the service under test, the testers' tools
    and reports · `registry/` projects · `connections/` what works on this machine and which MCP servers
    a tester may read from · `deploy/` Jenkins and the staging deploy · `chatin/` reading the owner's Chat
    space (Google sign-in, commands) · `notify/` tells the owner (toast,
    desktop notification, Chat space) · `api/` HTTP routes and auth ·
    `agents/prompts/` role prompts
- `ui/` — the dashboard (Vite, React, Tailwind). Built into `core/public`, served by core at `/ui/`.
  What the task page draws comes from `core/src/pipeline/flow.ts`, built from stored facts only; the
  UI decides nothing about where a task is. Agent names, colours and icons live in `ui/src/agents.ts`.
  The simple screens (Home, History, Setup) read `GET /api/tasks/overview` and `GET /api/tasks/:id/story`,
  which core builds in `core/src/pipeline/story.ts` and `journey.ts` from stored facts only (no model
  writes a chat line; never return an approval code or a log path; no paths, tool names or hashes in
  chat text). Their wording lives in `core/src/pipeline/plainWords.ts` and `ui/src/plain.ts`. Colours
  are CSS variables in `ui/src/index.css` (light, and dark through `prefers-color-scheme`).
- State is never in the repo: `~/.fryday-code` (`FRYDAY_HOME`).

## Rules

- Nothing specific to one person, company or machine goes in this repo: no absolute paths, no repo
  lists, no credentials, no references to anyone's credentials file.
- Default-deny. A new capability for an agent needs: a line in `core/src/guard/policy.ts`, a rule in
  `core/src/guard/decide.mjs`, a test in `core/test/guard.test.ts`, and a probe in
  `core/scripts/redteam.ts`.
- An MCP tool reaches an agent only by being written, by full name and with its argument check, into
  that run's guard policy (`core/src/verify/tools.ts`). A new one needs a check in `decide.mjs`, a
  test in `core/test/mcpGuard.test.ts` and a probe in `core/scripts/redteam-verify.ts`. MCP servers
  run outside the sandbox: only core's own code, a version-pinned package, or a server the developer
  turned on may be started for an agent.
- A tester agent reaches the service under test through core's tool, never from its shell, and reads
  data only through connections marked local or staging and read-only. Production is never granted:
  that is a CHECK in the database as well as code (`core/src/connections/store.ts`).
- The service under test is agent-written code. It runs only in the sandbox (`core/src/verify/service.ts`)
  and never outlives the core that started it.
- A verdict from a tester that never used the service or the browser is not a test. It goes to the
  owner, like a check that could not run.
- Core never runs a repository's git hooks and agents never run git (`core/src/pipeline/worktrees.ts`).
- Anything that leaves the machine (push, deploy, message) goes through an approval ticket bound to a
  commit (`core/src/pipeline/approvals.ts`), and the ticket lists every push it will make (a deploy
  ticket lists what it starts in Jenkins).
- From the Chat space, only the linked owner's messages are acted on (the sender id of the person who
  posted the link code), never an app's, each message once; an approval there needs the ticket's
  one-time code. `/oauth/google/callback` is the only route open without a session: it completes
  only a sign-in this install started. Test against `core/test/fixtures/stub-google.ts`.
- FryDay never answers a Jenkins prompt that mentions production, asks for values, or does not clearly
  say staging (`core/src/deploy/config.ts` `inputKind`), and a deploy counts only when the build is
  shown to contain the merge on staging. Every Jenkins request goes to the configured address only
  (`core/src/deploy/jenkins.ts` `urlFor`). Test against `core/test/fixtures/stub-jenkins.ts`, never a
  real Jenkins. Never add a
  path around it. The one standing exception is `notify/`: status text about a task, sent only to the
  Chat space the owner set up, never code or file contents.
- An engine other than Claude Code has no per-call guard, so it runs only read-only roles
  (`RunnerCaps.roles` in `core/src/runner/runners.ts`, refused again in `settings.ts` and by the
  supervisor) on a throwaway copy, with its whole process in the sandbox. Never offer such an engine to
  a role that writes, runs commands or reaches a service. Test against
  `core/test/fixtures/fake-cursor-agent.mjs`; `core/test/runners.test.ts` probes the sandbox.
- An agent never chooses a branch, a project or a remote by itself. Core gathers the choices from git
  and the registry, the agent may only pick from that list, and core checks the pick against the list.
- FryDay Code pushes to an existing branch only when every commit on it is the owner's own, and never
  with force.
- A check that could not run is an error, not a pass and not "already failing".
- Tests and scripts use scratch repositories with a remote on disk. Never point a test at a real
  repository or a real remote.

## Before saying a change is done

```bash
npm run typecheck
npm test
npm run redteam   # when guard, sandbox, supervisor, auth or anything an agent can reach changed
npm run e2e       # when the pipeline or a prompt changed
npm run fresh     # when first-run, projects, installs or settings changed
npm run intake    # when intake, questions, branch continuation or the Analyst's prompt changed
npm run redteam:verify  # when the testers, their tools, the service sandbox or data connections changed
npm run verify    # when verification or a tester's prompt changed
npm run deploy-check  # when release, deploy, Jenkins or alerts changed
```

Rebuild the UI (`npm run build:ui`) after changing `ui/`, and look at it in a browser.
