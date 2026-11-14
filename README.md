# Winston

<img src="assets/winston.png" alt="Winston, the fixer: Just do exactly as I say and everything will be just fine." width="720">

An orchestration plugin for Claude Code (and Codex) that runs long, unattended engineering
sessions off a GitHub board: pick the Ready work, clear every human-needed decision up front,
build in parallel worktree lanes, merge one PR at a time, verify, and report.

> "I solve problems."

## Install

Claude Code:

```
/plugin marketplace add sempervire/winston
/plugin install winston@winston
/plugin install chattr@winston      # optional: peer coordination between sessions
```

Codex:

```
codex plugin marketplace add sempervire/winston
codex plugin add winston@winston
winston install-codex-agents        # Codex plugins cannot ship agents; this copies them
```

Codex asks you to trust the plugin's hooks once (`/hooks`).

Then, in a repo, `/winston:init`. It asks which of three setups this is and plans it before
changing anything:

| Setup | When | What it does |
|---|---|---|
| `join` | The repo already carries a `.winston/config.json`. | Checks your access (the `gh` project scope, the board, which is shared separately from the repo) and your machine. Changes nothing in the repo or on GitHub. |
| `new` | A new project. | Creates the GitHub repo, both branches, the board, the config, labels and triage workflow. |
| `adopt` | An existing repo Winston did not set up. | Fits a config to its default branch, an integration branch, a board already linked to it and its process docs; adds only what is missing. |

`/winston:doctor` is the one place to look afterwards, and safe to run as often as you
like. It prints a checklist (`done`, `needs you`, `could not check`), says for each open
item why it matters and how to fix it, and ends with a single **Next step:** line. A newer
Winston shows up there as one more item, with the update command. If its last run left
items open, the next session in that repo starts with one line saying so.

A board Winston builds has six Status columns, in order: `New`, `Ready`, `In Progress`,
`Verify`, `Verified`, `Done`, with fixed colours and descriptions, and a board view filtered
to a milestone whose cards show labels. On a board that already exists, missing columns are
added in that order and Labels is switched on for the view; nothing already there is
renamed, recoloured or removed.

Two steps cannot go through GitHub's API, which can delete a project workflow but not
create or enable one: on the board's Workflows page, **Auto-add to project** (this
repository, filter `is:issue`) and **Item added to project** (set Status to `New`). Without
them a new issue never reaches the board. `/winston:init` does both through browser
control, so have Claude in Chrome ready during setup: install the extension, sign in to
GitHub in that Chrome, and connect it with `/chrome` (or start with `claude --chrome`).
Without browser control it prints the two steps for you to do, and doctor reports them
until they are done.

The triage workflow needs two Actions secrets that only the owner can create: `GH_PAT`
(Issues on the repo, Projects on the board's owner) and `CLAUDE_CODE_OAUTH_TOKEN` (from
`claude setup-token`). `winston init` checks which exist, by name only, and prints numbered
steps for the missing ones, with the token type GitHub requires for the board's owner.
Until both are set new issues are not triaged automatically; `winston doctor` reports the
secrets and whether the workflow's latest runs failed.

Triage takes every rule from the repo's policy file (`triage.policy`, `TRIAGE.md` by
default). When that file is missing or has no triage rules (no heading that names triage,
no `risk:` tier), doctor says so and init offers a starter `TRIAGE.md` to edit and commit;
it never overwrites an existing one.

## Updating

Winston says when a newer version is out: a notice at the start of a session (it asks
GitHub at most once a day) and a line in `/winston:doctor`, both with the command to run.
It never updates itself, because an update replaces hooks and skills and needs a restart.

```
claude plugin marketplace update winston && claude plugin update winston@winston
```

Add `--scope project`, run from the project, for a project-scope install. Then restart
Claude Code. `"updateCheck": false` in the config turns the session notice off.

So that a run does not stop on permission prompts, `winston permissions` lists the Claude
Code allow rules Winston runs use in the repo and which the project's
`.claude/settings.json` lacks. The owner runs `winston permissions --apply` once: it adds
the missing rules to `permissions.allow`, and to `permissions.deny` a short list for what
an allow pattern cannot leave out (force pushes, pushes to the production branch, PR
approvals, forced deletions; deny wins over allow). It prints what it added and never
removes or loosens an existing rule. Allow rules never clear deny or ask rules, hooks,
production approval or secret grants.

## Commands

| Command | What it does |
|---|---|
| `/winston` | Orchestrator. No argument: set up a session from the board's Ready column. An argument is an instruction. |
| `/winston plan <draft>` | Turn a draft plan into a settled one, one decision at a time. Never implements. |
| `/winston:triage` | Whole-board triage pass under the repo's own policy (`TRIAGE.md`). |
| `/winston:radar` | What to work on next, batched into the time you have. |
| `/winston:verdict` | Debbie (is it worth doing?) and Sheldon (is it true and well engineered?), together. |
| `/winston:rex` | Session therapist and usage reports, run on Codex. |
| `/winston:closeout` | Can this session end without stranding work? |
| `/winston:handoff` | Hand the work to a fresh session. |
| `/winston:codex`, `/winston:gemini` | Read-only second opinions from other model families. |
| `/winston:doctor`, `/winston:init` | Check the setup Winston needs; join, create or adopt it. |
| `winston permissions [--apply]` | List, or add to the project's settings, the allow rules Winston runs use. |

Hooks: a production-deploy gate (blocks configured deploy actions until the owner types the
approval phrase in that session), a secret-handling grant, session titles, a starting-branch check (a session opened in the
main checkout on the production branch is moved to the integration branch and
fast-forwarded, when the checkout is clean), worktree setup, a one-line setup reminder at session start, a
browser-tab guard, and a once-per-turn Parallelism check nudge in Winston sessions (those
holding chattr's `resource:orchestrator` claim).

## Requirements

Claude Code and `gh` (with the `project` scope). Optional, each degrading cleanly when absent
(`/winston:doctor` says what is off): Codex CLI (Rex, `/winston:codex`), Gemini CLI and key
(`/winston:gemini`), chattr (claims and peer messages between sessions).

The workflow assumes two long-lived branches (integration and production) and a GitHub
Projects board with Status `New / Ready / Verify / Verified` and a Priority field.

## Configuration

`.winston/config.json` in the repo (committed), over `~/.winston/config.json` (per user).
Top-level keys merge shallowly; the repo wins. See `templates/config.sample.json`.

| Key | Purpose |
|---|---|
| `owner` | Who approves and decides. |
| `branches` | `integration` and `production` branch names. |
| `board` | Projects v2 owner, number, statuses, priority field. |
| `processDocs`, `triage.policy` | The repo docs whose rules win over Winston's. |
| `profiles.winston` | A repo-specific profile, read after each skill (one `## /winston:<skill>` section per skill). |
| `advisors` | Repo-specific agent names for Debbie, Sheldon and Radar. |
| `deployGate` | Approval phrase and the guarded actions (`pr-merge` into a base, `workflow-run`). |
| `secretGrant` | The phrase that grants secret handling for one session. |
| `permissions.allow` | The repo's own commands, as Claude Code rules (`Bash(npm test*)`), added to what `winston permissions` lists. |
| `updateCheck` | `false` turns off the session-start notice that a newer Winston is out. |
| `startBranch` | `false` leaves the main checkout on whatever branch it is on at session start. |
| `worktree`, `launcher` | Files copied or linked into new worktrees; the repo the launchers open. |

The repo's process docs always win over Winston where they conflict.

## Development

```
npm test
claude plugin validate .
claude --plugin-dir .
```

Releases are tagged on `main`; installs pin to tags.

## License

MIT
