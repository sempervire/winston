# Winston: ShareView profile

Applies when the current repository's `origin` is `ShareViewLLC/ShareView`.

## Read first

`CLAUDE.md` names the process docs. Read `QA-PROCESS.md`, `TRIAGE.md`, `AGENTS.md`, and
`COMMUNICATION.md` before setup. They win over `workflow.md` where they conflict.

## Board

- Board: `ShareViewLLC` Projects v2 number 1. Read it with `scripts/board-query.sh`.
- Choose only from `Ready`, current phase (`.github/current-phase`) unless Dave says otherwise.
- `New` → `Ready` is Dave's (`TRIAGE.md`). Never move it.

## Verify

- Winston moves an approved issue to `Verified` only under the authorized-session exception in
  `TRIAGE.md` Track B (ShareViewLLC/ShareView#231, Part 1).
- **Until that rule is on `staging`, every `human-verify` issue stops at Dave.** Check
  `TRIAGE.md` on `origin/staging` at setup; do not rely on memory.
- Under the rule, the check runs against the deployed commit, the evidence comment carries the
  planned check and falsifier, the deployed target (URL and commit), the observed result, and
  any in-flight changes, and states that the session authorization was used. The label stays.
- Never verify a card carrying `HOLD`. `verify-prod` issues are out of scope.

## Merge

- Dave's approval of the session is the dispatching-prompt grant in `AGENTS.md` rule 16 for
  every approved issue, lanes included.
- It never covers a merge across the Claude/Rex boundary (`AGENTS.md` rule 17).
- Feature branches are cut from `staging`; review with `/code-review origin/staging`.

## Claims

- `chattr claim resource:orchestrator` at setup.
- `chattr claim issue:<N>` for every approved issue on authorization; release at `Verified` or
  when dropped.
- `chattr claim resource:chrome` for the session.
- Name any other shared resource with its object id, e.g. `resource:preview-db`.

## Advisors

- Debbie and Sheldon: `/consult`. Codex: `/codex`. Radar: `shareview-radar` in a subagent.
