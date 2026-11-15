<!-- Winston starter triage policy. winston init replaces each `{{placeholder}}`: most
are keys in `.winston/config.json` (`board.statuses[0]` and `[1]` are the intake and the
ready-to-work status); `priorityOptions` comes from the board's Priority field and
`otherRules` from `processDocs`. The three sections marked
(per-repo) at the end work as written and are the ones to tailor. Delete this comment. -->

# Triage

Triage is a process where all issues are evaluated based on criteria and prepared for
processing.

During triage, only issues that are open and in status `{{board.statuses[0]}}` or `{{board.statuses[1]}}` are evaluated.

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

Everything in this file applies as written. The three sections marked **(per-repo)** at
the end hold what is specific to this repository; Winston fills them in, and you can edit
them any time. You don't need to read the rest: it is instructions for Winston.

---

## Calling this process

Triage is callable as a step inside other work. What a caller can rely on:

- **Inputs** — none. Triage reads the board.
- **Scope** — open issues in status `{{board.statuses[0]}}` or `{{board.statuses[1]}}`. Nothing else is touched.
- **Effects** — sets Priority and the `risk:` tier, writes a plan comment, assigns the
  issue to the person who filed it, and applies the labels named under "Labels triage
  applies" below.
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

**Labels triage applies**: the `risk:` tier, `auto-verify`, `human-verify`, `duplicate`, `invalid`, `wontfix`.

The unattended workflow reads that line: it writes a label only when the line names it,
and the `risk:` tier always. Remove a name from the line to stop triage applying that
label. Triage never applies or removes `auto-merge`.

---

## The per-issue entry point

Everything above describes a pass over the board. Triage also runs one issue at a time,
unattended, from the workflow named by `triage.workflow` in `.winston/config.json` — so
that a card carries its stamp before a `{{board.statuses[0]}}` -> `{{board.statuses[1]}}` move is possible, rather than
whenever the next whole-board pass happens to run. It runs when an issue is opened by the
owner or a collaborator, on a manual dispatch naming one issue number, and once a day as a
sweep. A run on an opened or dispatched issue triages that one issue and no other.

**The unattended pass applies the Effects above and nothing more.** The `risk:` tier,
Priority, the plan comment, the reporter assignment, and the labels the "Labels triage
applies" line names. **It never moves status**, and it
never edits a file, closes an issue, merges or deploys. A stamp at `{{board.statuses[0]}}` is triage's
record that the issue was read, never a promotion.

On the `opened` event the run waits for the board to add the issue and reads its status
there; an issue that never reaches the board gets nothing written, and the sweep takes it
once it is there. On a dispatch, read the status from the board; an issue that is closed,
not on the board, or at any status other than `{{board.statuses[0]}}` or `{{board.statuses[1]}}`, gets nothing written.

**The unattended pass skips an issue that already has a `risk:` tier.** Re-reading
triaged issues is the whole-board pass's job, and "no skip" applies there. A dispatch
with `dry_run` still decides such an issue and prints the verdict, writing nothing.

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
`/winston:radar` and `/winston:triage` already read. The daily sweep is the backstop: it takes
up to five open issues at `{{board.statuses[0]}}` or `{{board.statuses[1]}}` with no `risk:` tier, filed by the owner, a member
or a collaborator, oldest first, so an issue the `opened` run missed is stamped within a
day. It passes by an issue whose last triage comment is a stop nobody has answered (no
comment, body edit or rename since), so unresolved stops do not use up its five.

**The invariant is a normal-path guarantee, not an absolute one.** A card can still reach
`{{board.statuses[1]}}` unstamped, because nothing gates the `{{board.statuses[1]}}` move.

---

## What triage decides

Set Priority and the risk tier, assign the issue to its reporter, analyze the issue, and
write the plan onto it. At `{{board.statuses[0]}}` that is the input to the `{{board.statuses[0]}}` -> `{{board.statuses[1]}}` call, which is
the owner's. At `{{board.statuses[1]}}` it is what the session that takes the issue works from.

**`{{board.statuses[1]}}` issues get this too.** A `{{board.statuses[1]}}` issue gets the full treatment whether or not it
already carries a plan comment.

**Triage never moves status.** Evaluating an issue at `{{board.statuses[1]}}` does not move it, and
`{{board.statuses[0]}}` -> `{{board.statuses[1]}}` remains the owner's call.

**Risk tier.** Tag every issue `risk: low`, `risk: medium`, or `risk: high`, by the
criteria in "Risk tiers" below. An issue carries exactly one tier; changing it removes
the old one. **Blast radius, not diff size, sets the pace.**

**Verification label.** Every plan also says how the change will be shown to work, as one
label: `auto-verify` when the tier is `risk: low` and a test or command an agent runs can
show it; otherwise `human-verify`. `risk: high` never gets `auto-verify`. A stop gets
neither.

**Priority** goes in the board's `{{board.priorityField}}` field, never in the issue title — titles are
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
`<!-- triage-plan -->`, which is how a later run finds the plan to compare against. The
unattended workflow writes, just above it, a `<!-- triage-decision {...} -->` line holding
the tier, Priority, verification and resolution it decided, so a re-run that decides the
same writes no new comment however it words the plan.

**A previous conclusion is not a reason to skip.** An issue that already carries a plan is
read in full like every other, and a new plan comment is written if the history now says
something the old plan did not account for.

**An issue with nothing to act on** — a test filing, an empty or unintelligible body — is
triaged like any other: `risk: low`, the lowest Priority, and a plan that says there is no
actionable request and recommends closing it. Triage does not close it; that is the
owner's.

---

## Resolution

Some issues should not be worked: a duplicate, one that is not this repository's or
cannot be reproduced, or one the owner has already declined. Triage still writes a plan
for it, with a tier and a Priority, that says so, and applies exactly one of these labels:

- `duplicate` — the plan names the original issue.
- `invalid` — not reproducible, or not this repository's.
- `wontfix` — the owner has declined it; the plan says where.

**Triage never closes the issue.** The label and the plan are a recommendation; closing is
the owner's. When unsure, apply none. To turn this off, remove the three names from the
"Labels triage applies" line.

---

## Reporting

After a whole-board pass, give the owner the three lists under "Returns", stops first.

That is a **report, not a request**.

Once each qualifying issue has been processed, the triage process ends.

---

<!-- per-repo:names -->
## Names (per-repo)

<!-- Winston filled this in from `.winston/config.json`; edit it if you like, one line per item. -->

- **Owner**: `{{owner}}`.
- **Board**: project `{{board.number}}` of `{{board.owner}}`. Triage reads statuses
  `{{board.statuses[0]}}` and `{{board.statuses[1]}}`.
- **Priority options**: the options of the `{{board.priorityField}}` field, most urgent
  first: {{priorityOptions}}.
- **Branches**: work lands on `{{branches.integration}}`; `{{branches.production}}` is
  what is released. The unattended workflow runs from the repository's default branch,
  so a change to this file or to the workflow takes effect only once it is there.
- **Other rules**: {{otherRules}}.
<!-- /per-repo -->

<!-- per-repo:risk-tiers -->
## Risk tiers (per-repo)

<!-- These are Winston's standard risk ratings, and they work as they are. To tailor
them, ask Claude (or run /winston:init): it reads the repo and drafts three rows for this
repo's kinds of change, sorted by what breaks for a user if the change is wrong, not by how
large the diff is, naming real paths. -->

| Tier | Applies when the fix… |
|---|---|
| `risk: low` | is docs, copy or tooling only — nothing a user runs behaves differently |
| `risk: medium` | changes behavior a user sees, or spans several files, and is easy to undo |
| `risk: high` | touches stored data, money, access control, or anything hard to undo, or needs a decision only the owner can make |

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
