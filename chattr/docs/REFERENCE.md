# chattr reference

chattr is part of Winston: the CLI is `chattr/chattr.mjs` (run as `chattr` through Winston's
`bin/chattr`), and Winston's `hooks/hooks.json` registers its hooks. This page carries over
the reference from the retired sempervire/chattr README. The contract, JSON shapes and
proofs are in `../SPEC.md`; peer rules in `AGENT-RULES.md`; wake paths in `WAKE.md`.

## Requirements

- macOS. chattr reads `ps` and `lsof`, wakes Claude Code through its local socket
  (`/tmp/cc-socks/<pid>.sock`) and Codex through `codex queue`. It uses no iTerm, no
  AppleScript and no network.
- Node.js 24 or later (`node:sqlite`), the same as Winston.
- For Codex: `~/.agent-bridge` in `[sandbox_workspace_write] writable_roots` in
  `~/.codex/config.toml`, so a sandboxed session can write the store. `winston doctor`
  checks it.

## How it works

Store: `~/.agent-bridge/bridge.db` (override `CHATTR_DB`). Identity: `CHATTR_SESSION`
(Claude, set via `CLAUDE_ENV_FILE`), else `CODEX_THREAD_ID` (Codex exports it to every
command).

**Sandbox:** Codex `workspace-write` cannot write `~/.agent-bridge` unless it is in
`writable_roots`; with that, a WAL write from inside Codex succeeds. Inside the sandbox
`ps` is denied and `kill -0` works.

**Hooks.** Per-CLI code lives only in `hook/adapters/`. Stop composes, in order:
delivery, status, notify (BEL), with at most 2 delivery continues since the last human
prompt. The hook also wakes idle recipients of the session's queued directed messages,
because a sandboxed Codex sender cannot reach `codex queue` or a Claude socket itself. A
broadcast is passive: it wakes nobody and never continues a Stop on its own. Winston's
registrations pass `--bundled`, and stand down while the separate chattr plugin or the old
`install.sh` hooks are present (`hook/standdown.mjs`).

**Shared-checkout guard.** `hooks/worktree-guard.mjs` blocks an edit while another live
session works in the same folder, and blocks when it cannot tell (fail closed).
`hooks/worktree-session-start.mjs` warns once at session start. `CLAUDE_ALLOW_SHARED_CWD=1`
lets one session share; `"sharedCheckoutGuard": false` in `.winston/config.json` turns both
off for a repository.

## Command reference (`--json` default, `--text` for humans)

| Command | Does |
|---|---|
| `join --kind K [--session ID] [--source startup\|resume\|compact] [--pid --tty --surface --wake-endpoint --cwd]` | enroll; new incarnation unless `compact`. The hooks do this; never run it by hand. |
| `leave` | mark self `gone` |
| `who [--repo] [--all] [--coverage [--cwd P \| --under P]]` | sessions with computed status; coverage = live root `claude`/`codex` processes, enrollment counts, and `unenrolled` roots with no matching live session; `complete` requires no unenrolled roots; `--cwd` scopes to exactly P, `--under` to P and below |
| `status <uuid\|session>` | per-recipient delivery states and least-advanced summary, or one session |
| `send <to> <body>` · `consult <to> <body>` | `<to>` = session id or `kind:<kind>` |
| `broadcast <body>` | every other live session in the same repo |
| `reply --to <consult> [--status answered\|interrupted\|unknown] <body>` | answers and acks a consult |
| `claim <resource> [note…]` · `release <resource> [note…]` | atomically take or free `<kind>:<name>` (`issue:115`, `resource:preview-db`) and announce it; first claim wins, a conflict returns the owner |
| `inbox [--after <uuid>] [--limit N]` | unacked messages for self, in send order |
| `ack <uuid…>` | ack deliveries; repeats are no-ops |
| `expire <uuid>` · `supersede <old> <new>` | sender withdraws or replaces a message |
| `state` | self, same-repo peers, last 10 live broadcasts, unacked, every active claim in the repo |
| `hook <event> [--agent <kind>] [--bundled]` · `wake <session>` | composed CLI hook; wake an idle session (`wake.mjs`) |
| `uninstall-hooks [--dry-run \| --snapshot <dir>] [--home <dir>]` | remove the old installer's chattr hook registrations |

A body of `-` is read from stdin. Delivery into a session's context happens only at turn
boundaries (`start`, `prompt`, `stop`) through the hook.

## States

- Session: `working | idle | blocked | error | gone | unknown` (`unknown` = pid alive, last seen > 10 min ago).
- Delivery: `queued | injected | acked | stale | expired | superseded`; a consult also reports
  `answered | interrupted | unknown` once replied. A delivery re-injected past 3 attempts is `stale`.

## Exit codes

`0` ok · `2` usage · `3` not enrolled · `4` unknown recipient, message, consult or claim, resource claimed, or not permitted.

## Wake facts (Codex 0.154, verified 2026-09-15)

- `codex queue --thread <uuid> --message <text>` writes `~/.codex/queue_1.sqlite` `queued_items`;
  the live TUI consumes the row within about 5 s and runs it as a turn. Exit 0 is not delivery;
  the row vanishing is.
- Never queue by name: `--thread <name>` fails and queues nothing. Names live only in
  `~/.codex/state_5.sqlite` `threads.name`; `/status` prints `Session: <uuid>`.
- A prompt arriving mid-turn does not open a new turn; it steers the running one. Wake only idle sessions.
- Rollout bracket per turn: `task_started{turn_id}` … `task_complete` or `turn_aborted{reason:"interrupted"}`.
  The newest rollout is not an identity (subagents and the apps write there too).
- Wakes carry `chattr inbox`, never a message body.

## Tests

Part of Winston's `npm test` (a temp `CHATTR_DB` per test): `chattr/test/`, `chattr/hook/test/`,
`chattr/hooks/test/`. The live end-to-end harness of the chattr repo was not carried over; it
was built on the retired installer.
