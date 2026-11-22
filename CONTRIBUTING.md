# Contributing to FryDay Code

Thanks for helping. FryDay Code runs AI agents against people's real repositories, and the code here
decides what those agents can touch, so **every change is security-relevant**. Please read the
security rules below before you open a pull request.

## Set up

You need Node.js 22.12 or newer and git. On Linux you also need `bubblewrap`, `socat` and `ripgrep`
(see [Linux and Docker](README.md#linux-and-docker) in the README).

```bash
git clone https://github.com/OWNER/fryday-code.git
cd fryday-code
npm run setup     # install core and ui, build the UI into core/public
npm run doctor    # what works on this machine, with the command that fixes each problem
npm run demo      # try it with stand-in agents: no Claude account, no cost
```

Layout: `core/` is the engine (TypeScript run with tsx; Express, better-sqlite3) and `ui/` is the
dashboard (Vite, React, Tailwind), built into `core/public`. See
[docs/architecture.md](docs/architecture.md).

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run FryDay Code on http://127.0.0.1:7475 |
| `npm run dev` | Core, restarted on change |
| `npm run open` | A new one-time link for the browser |
| `npm run build:ui` | Build the UI (after changing `ui/`; then look at it in a browser) |
| `npm run build:demo` | Build the static demo site into `ui/dist-demo` |
| `npm run record-demo` | Re-record the demo's task (after the scenario, story wording or API shapes change) |
| `node scripts/screenshots.mjs` | Retake the README screenshots from `ui/dist-demo` |
| `npm run typecheck` | Typecheck core and UI |
| `npm test` | Unit and integration tests (real git, real sandbox, stand-in agents) |

## Tests

`npm run typecheck` and `npm test` must pass. CI runs them on macOS and Ubuntu, builds the UI and the
demo site, and smoke-tests the Docker image.

Tests and scripts use scratch repositories whose remote is a folder on disk. Never point a test at a
real repository, a real remote or a real Jenkins: use the stand-ins in `core/test/fixtures/`
(`stub-jenkins.ts`, `stub-google.ts`, `fake-cursor-agent.mjs`).

### Real-agent checks (not in CI)

These start real Claude Code agents, so they need a signed-in Claude account and they use tokens. CI
cannot run them. Run the ones that match your change before asking for review. Maintainers run all
of them before tagging a release.

```bash
npm run redteam         # guard, sandbox, supervisor, auth, or anything an agent can reach
npm run e2e             # the pipeline or a prompt
npm run fresh           # first run, projects, installs or settings
npm run intake          # intake, questions, branch continuation or the Analyst's prompt
npm run redteam:verify  # testers, their tools, the service sandbox or data connections (needs Chrome)
npm run verify          # verification or a tester's prompt (needs Chrome)
npm run deploy-check    # release, deploy, Jenkins or alerts (stand-in Jenkins, no tokens)
```

Each one works in its own folder under `~/.fryday-code`, with a throwaway repository, and never pushes
anywhere real.

## Security rules (short form; the full list is in CLAUDE.md)

- **Nothing personal.** No absolute paths, repository lists, names, credentials or references to
  anyone's credentials file in the repository.
- **Default-deny.** A new capability for an agent needs a line in `core/src/guard/policy.ts`, a rule
  in `core/src/guard/decide.mjs`, a test in `core/test/guard.test.ts` and a probe in
  `core/scripts/redteam.ts`.
- **MCP tools** reach an agent only by full name, with an argument check, in that run's policy
  (`core/src/verify/tools.ts`). A new one needs a check in `decide.mjs`, a test in
  `core/test/mcpGuard.test.ts` and a probe in `core/scripts/redteam-verify.ts`.
- **Agent-written code** (the service under test) runs only in the sandbox and never outlives core.
- **Agents never run git**, and core never runs a repository's git hooks.
- **Anything that leaves the machine** goes through an approval ticket bound to a commit. Never force
  push. Push to an existing branch only when every commit on it is the owner's.
- **Production is never granted**, and no Jenkins prompt about production is ever answered.
- **An agent never chooses** a branch, a project or a remote by itself: core offers the list and
  checks the pick against it.
- **A check that could not run is an error**, not a pass.
- **Other engines** (anything but Claude Code) run only read-only roles, with the whole process in
  the sandbox.

## Pull requests

1. For anything larger than a small fix, open an issue first so we can agree on the approach.
2. Branch from `main`, keep the change focused, and add tests for new behaviour and bug fixes.
3. Run `npm run typecheck` and `npm test`, plus the real-agent checks your change calls for.
4. After UI changes, rebuild the UI and check it in a browser, in light and dark mode.
5. Fill in the pull request template: what changed, why, and how you checked it.
6. A maintainer reviews it. Changes to the guard, the sandbox, approvals or auth get a second look.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
