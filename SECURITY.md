# Security

FryDay Code runs AI agents on your own machine against your real repositories. The code in this
repository decides what those agents can touch, so we treat every way around those limits as a
security bug.

## Reporting a vulnerability

Please report privately, through GitHub: **Security → Report a vulnerability** on
[the repository](https://github.com/OWNER/fryday-code/security/advisories/new). Do not open a public
issue for it.

Include what you did, what you expected the limit to stop, and what got through (a red-team probe
in the style of `core/scripts/redteam.ts` is the most useful form). We will confirm receipt, keep you
informed while we fix it, and credit you in the advisory if you wish.

## In scope

Anything that lets an agent, the code it writes, or a web page do something the safety model below
says it cannot, for example:

- an agent reading or writing outside its task workspace, reaching the network, or reading files that
  hold secrets;
- an agent running git, a repository's git hooks running, or core pushing without a valid approval;
- a tester reaching anything but the service under test, or an MCP tool call that bypasses its
  argument check;
- the service under test (agent-written code) escaping its sandbox or outliving core;
- the local API or the UI session being usable from another origin, another host or without the
  one-time launch link;
- a production connection being granted to an agent, or a Jenkins prompt about production being
  answered;
- acting on a Chat space message from anyone but the linked owner, or an approval there without the
  ticket's one-time code;
- a secret (webhook address, Jenkins token, OAuth client secret, API key) shown in the UI, logs, chat
  text or the demo recording.

Out of scope: what Claude Code, the Cursor CLI or an MCP server you turned on does on its own outside
FryDay Code's limits; attacks that need an attacker already running code as your user; the reduced
isolation that the docs already state for Docker (nested sandbox) and for the Cursor engine.

## The safety model, in short

- **Default-deny guard.** Each role gets only the tools its policy lists (`core/src/guard/policy.ts`);
  a PreToolUse hook checks every call and fails closed (`core/src/guard/decide.mjs`).
- **OS sandbox.** Agent shells, checks, installs and the service under test run in Anthropic's sandbox
  runtime (Seatbelt on macOS, bubblewrap on Linux): writes only in the workspace, the home folder
  unreadable, no network unless core names the hosts.
- **Agents never run git.** Core commits their work itself and never runs a repository's hooks.
- **Approvals.** Anything that leaves the machine (push, merge into staging, deploy, message) needs an
  approval ticket bound to one commit; if the branch moves the ticket is void. Nothing is ever
  force-pushed.
- **Staging only.** Production connections can never be granted (a database CHECK as well as code),
  and FryDay never answers a Jenkins prompt that mentions production or does not clearly say staging.
- **Local only.** Core listens on 127.0.0.1 and checks Host and Origin exactly; a browser becomes the
  owner only through a one-time launch link.

Before each release the maintainers run the real-agent probes `npm run redteam` and
`npm run redteam:verify`; both fail if anything gets through.
