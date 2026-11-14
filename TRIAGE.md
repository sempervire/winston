<!-- Winston starter triage policy, written by winston init. Rewrite the three sections
marked (per-repo) at the end for this repository, then delete this comment. -->

# Triage

Triage is a process where all issues are evaluated based on criteria and prepared for
processing.

During triage, only issues that are open and in status `New` or `Ready` are evaluated.

**Read the whole issue — title, body, and every comment — before evaluating it.**

Filed bodies are historical records, not specifications. Start with the body, then read
the comments for corrections and later decisions.

- Read **every** comment, not the newest one. A correction sits wherever it was written,
  which is usually mid-history with later comments piled on top of it.
- Where the body and a later comment disagree, **the comment wins**.
- Where the **title** and the body disagree, stop. One of them has already been corrected
  and no plan can be written until you know which. **Report the stop** — it is one of the
  lists triage returns. An issue that silently gets no plan is one an unattended run never
  sees.

There is **no skip**. Every in-scope issue is read in full on every run, including one
that has been triaged before.

If circumstances change, it's OK to alter an issue during triage to reflect new information.

Everything in this file applies as written except the three sections marked
**(per-repo)** at the end, which hold what is specific to this repository.

---

## Calling this process

Triage is callable as a step inside other work. What a caller can rely on:

- **Inputs** — none. Triage reads the board.
- **Scope** — open issues in status `New` or `Ready`. Nothing else is touched.
- **Effects** — sets Priority and the `risk:` tier, writes a plan comment, and assigns the
  issue to the person who filed it.
  **The reporter becomes the sole assignee, replacing any existing assignee**; an issue
  whose author is a bot or CI is left with its assignees untouched.
  **A plan comment is written only when there is no plan yet, or when re-reading changes
  one.** A run that reaches the same conclusion writes nothing. Silence means
  "re-read, unchanged".
- **Returns** — three lists: the issues whose tier, Priority or plan this run set or
  changed; any open issue that is **not on the board or has no status**; and any issue
  triage **stopped on** — a title and body that disagree, or any other contradiction it
  could not resolve by reading. A stop is not a plan, so the issue must leave triage by
  name rather than by absence.

Triage applies no label other than the `risk:` tier. Where `auto-merge`, `auto-verify`
and `human-verify` exist, triage neither applies nor removes them.

---

## The per-issue entry point

Everything above describes a pass over the board. Triage also runs one issue at a time,
unattended, from the workflow named by `triage.workflow` in `.winston/config.json` — so
that a card carries its stamp before a `New` -> `Ready` move is possible, rather than
whenever the next whole-board pass happens to run. It runs when an issue is opened by the
owner or a collaborator, and on a manual dispatch naming one issue number. The run
triages that one issue and no other.

**The unattended pass applies the Effects above and nothing more.** The `risk:` tier,
Priority, the plan comment, and the reporter assignment. **It never moves status**, and it
never edits a file, closes an issue, merges or deploys. A stamp at `New` is triage's
record that the issue was read, never a promotion.

On the `opened` event the status is `New`. On a dispatch, read the status from the board;
an issue that is closed, or at any status other than `New` or `Ready`, gets nothing
written.

**A stop writes no label at all.** Where the title and the body disagree, the run posts the
stop and its reason and leaves the card in the untriaged queue, because the tier is the
record that triage *ran* and a run that could not resolve the issue did not triage it. The
next whole-board pass finds it there, and so does `/winston:radar`. The stop does not
leave Priority unset: choose the best-supported value from the evidence available, and
revisit it when the contradiction is resolved. Where the last triage comment on the issue
is already a stop, do not post another.

**When Actions is unavailable the card stays unstamped, and that is the designed
failure.** A budget that has run out, an outage, or a failed run all produce the same
visible state — a card with no `risk:` tier, which is the untriaged queue both
`/winston:radar` and `/winston:triage` already read. There is no scheduled backstop: an
issue the `opened` run missed waits for the next whole-board pass.

**The invariant is a normal-path guarantee, not an absolute one.** A card can still reach
`Ready` unstamped, because nothing gates the `Ready` move.

---

## What triage decides

Set Priority and the risk tier, assign the issue to its reporter, analyze the issue, and
write the plan onto it. At `New` that is the input to the `New` -> `Ready` call, which is
the owner's. At `Ready` it is what the session that takes the issue works from.

**`Ready` issues get this too.** A `Ready` issue gets the full treatment whether or not it
already carries a plan comment.

**Triage never moves status.** Evaluating an issue at `Ready` does not move it, and
`New` -> `Ready` remains the owner's call.

**Risk tier.** Tag every issue `risk: low`, `risk: medium`, or `risk: high`, by the
criteria in "Risk tiers" below. An issue carries exactly one tier; changing it removes
the old one. **Blast radius, not diff size, sets the pace.**

**Priority** goes in the board's `Priority` field, never in the issue title — titles are
for the short description. Its options are fixed and listed in "Names" below. It is a
field on the project item: read it from the board and write it with
`gh project item-edit`.

**Every issue triage evaluates gets a Priority.** Judge its user impact, time sensitivity,
and whether it blocks other work; Priority is a scheduling judgment, separate from the
`risk:` tier. Read the existing value, keep it if the evidence still supports it, and
change it when circumstances warrant. If the choice is uncertain, make the best-supported
guess from the issue history and set the field anyway. Do not leave it blank or assign a
fixed default in place of a judgment.

**The `risk:` label is the record that triage ran.** Triage sets one on every issue it
reads, so `-label:"risk: low" -label:"risk: medium" -label:"risk: high"` is the
untriaged queue. There is no separate marker.

**The plan comment** starts with `## Plan`, states what the fix is and which files it
touches, how it will be shown to work, and the tier and Priority with the reasoning where
the choice is not obvious, plus whatever "What a plan names" below adds. A stop starts
with `## Triage stopped` and gives the reason instead. Either ends with the line
`<!-- triage-plan -->`, which is how a later run finds the plan to compare against.

**A previous conclusion is not a reason to skip.** An issue that already carries a plan is
read in full like every other, and a new plan comment is written if the history now says
something the old plan did not account for.

**An issue with nothing to act on** — a test filing, an empty or unintelligible body — is
triaged like any other: `risk: low`, the lowest Priority, and a plan that says there is no
actionable request and recommends closing it. Triage does not close it; that is the
owner's.

---

## Reporting

After a whole-board pass, give the owner the three lists under "Returns", stops first.

That is a **report, not a request**.

Once each qualifying issue has been processed, the triage process ends.

---

<!-- per-repo:names -->
## Names (per-repo)

<!-- Fill in from `.winston/config.json`; keep one line per item. -->

- **Owner**: `Dave Hecker`.
- **Board**: project `6` of `sempervire`. Triage reads statuses
  `New` and `Ready`.
- **Priority options**: the options of the `Priority` field, most urgent
  first: `P0`, `P1`, `P2`, `P3`.
- **Branches**: work lands on `staging`; `main` is
  what is released. The unattended workflow runs from the repository's default branch,
  so a change to this file or to the workflow takes effect only once it is there.
- **Other rules**: none. This repo has no separate working-rules file; this file is the
  only triage policy.
<!-- /per-repo -->

<!-- per-repo:risk-tiers -->
## Risk tiers (per-repo)

| Tier | Applies when the fix… |
|---|---|
| `risk: low` | is docs, copy or tests only: `README.md`, `assets/`, `test/`, or wording in `skills/` or `agents/` that leaves what a run does unchanged |
| `risk: medium` | changes what a session does but stays inside that session and is undone by a plugin update: skill and agent behavior in `skills/`, `agents/` and `codex/agents/`; `launchers/`; read-only CLI commands in `bin/winston` such as `doctor` and `title`; the hooks that only inform (`hooks/session-title.mjs`, `hooks/update-check.mjs`, `hooks/parallelism-check.mjs`, `hooks/start-branch.mjs`) |
| `risk: high` | touches a guard, or anything that writes outside the session: `hooks/deploy-gate.mjs`, `hooks/secret-grant.mjs`, `hooks/browser-tab-guard.mjs`, `hooks/worktree-setup.mjs`, `hooks/hooks.json`; `winston init` and `winston permissions --apply` in `bin/winston`, which change a user's repo, board and settings; `lib/config.mjs` and `lib/update.mjs`; `templates/`, which land in users' repos and run with their secrets; the `.claude-plugin/` manifests and the released version; or needs a decision only the owner can make |

Batch the low ones and move fast. Give the high ones more room however small the diff
looks.
<!-- /per-repo -->

<!-- per-repo:plan -->
## What a plan names (per-repo)

<!-- List what every plan in this repo must state beyond the fix, its files and how it
will be shown to work - for example a required test, or an environment the change must
be confirmed in. Leave the single line below if there is nothing to add. -->

- Nothing beyond the above.
<!-- /per-repo -->
