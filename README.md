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

Then, in a repo: `/winston:doctor`, and `/winston:init` for anything it reports missing.

## Commands

| Command | What it does |
|---|---|
| `/winston` | Orchestrator. No argument: set up a session from the board's Ready column. An argument is an instruction. |
| `/winston plan <draft>` | Turn a draft plan into a settled one, one decision at a time. Never implements. |
| `/winston:triage` | Whole-board triage pass under the repo's own policy (`TRIAGE.md`). |
| `/winston:radar` | What to work on next, batched into the time you have. |
| `/winston:consult` | Debbie (is it worth doing?) and Sheldon (is it true and well engineered?), together. |
| `/winston:rex` | Session therapist and usage reports, run on Codex. |
| `/winston:closeout` | Can this session end without stranding work? |
| `/winston:handoff` | Hand the work to a fresh session. |
| `/winston:codex`, `/winston:gemini` | Read-only second opinions from other model families. |
| `/winston:doctor`, `/winston:init` | Check, then create, the setup Winston needs. |

Hooks: a production-deploy gate (blocks configured deploy actions until the owner types the
approval phrase in that session), a secret-handling grant, session titles, worktree setup, a
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
| `dismissalGrant` | The phrase that lets `/winston` post review dismissals under the repo's documented conditions. |
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
