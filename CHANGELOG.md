# Changelog

All notable changes to FryDay Code. The format follows [Keep a Changelog](https://keepachangelog.com/),
and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-22

The first public release.

### The agent team

- **Understander** (Analyst, read-only): reads the task and attached documents (Markdown, text, PDF),
  works out the project and any existing branch, and asks at most twice when only you can decide.
- **Planner** (read-only): a short design, the runtime flow, acceptance criteria and a test plan.
- **Builder** (Coder): edits in a git worktree of its own, with no network, no git and no access to
  your home folder.
- **Automatic checks**: the project's own test, lint and typecheck commands, in the sandbox, on a clean
  checkout of exactly what was committed; on a repository that is already red, only new failures block.
- **Diff scan**: deleted, skipped or focused tests block; edits to hooks, CI, package scripts or
  dependencies are flagged.
- **Checker** (Reviewer): checks each acceptance criterion with evidence; it cannot edit and cannot
  overrule a failing check.
- **App tester and Page tester** (macOS): start the project as a service in the sandbox and use it
  through its HTTP API and in Chrome, with reports for every criterion.
- Up to 3 send-back rounds to the Builder, then to you.

### Release with your approval

- Approval tickets bound to one commit, listing every push they will make.
- Continuing your own branch, pushing it back without force, and merging into staging as a separate
  approval; one-button revert.
- Staging deploys through Jenkins, stage by stage; prompts that mention production are never answered.

### Using it

- Home with the team strip, the journey (Understand, Plan, Build, Check, Your OK, Live) and a
  plain-words team chat; History; a Setup checklist; Technical details for the full task page.
- Light and dark mode, following the system.
- Alerts as toasts, desktop notifications (macOS, `notify-send` on Linux) and a Google Chat space.
- Working from the Chat space: tasks, answers, notes and approvals with one-time codes, read with
  your own Google sign-in.
- Token limits per agent and per task, with a "continue?" ticket when one is reached; cache reads are
  shown as "reused".
- The Cursor CLI as an optional engine for the two read-only agents, fully sandboxed.

### Install and try

- `npx fryday-code` (`start`, `open`, `doctor`, `demo`), a git clone with `npm run setup`, or Docker
  (`docker compose up --build -d`).
- `fryday-code demo`: a local demo with stand-in agents on a sample project, with no Claude account
  and no cost.
- A free static demo site that replays a recorded task in the browser, with a landing page.
- macOS, Linux (bubblewrap sandbox) and Docker (nested sandbox, reduced isolation).

### Project

- CI on macOS and Linux, a Docker smoke test, GitHub Pages for the demo, and a release workflow for
  the container image and the npm package.
- MIT license, contributing guide, security policy and architecture notes.

[1.0.0]: https://github.com/OWNER/fryday-code/releases/tag/v1.0.0
