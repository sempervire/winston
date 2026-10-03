---
name: triage
description: Run a whole-board triage pass by the repo's own triage policy (TRIAGE.md or config triage.policy) - read every in-scope issue and comment completely, reconcile the board against the repo, apply the policy's labels and Priority, and report. Use when the user runs /winston:triage or another workflow calls triage as a step.
---

# /winston:triage

Run triage. This skill is the **engine**; the repo's triage policy owns **every** rule it
obeys — the scope, what is read, the priority and risk judgments, which labels are applied and
when, what a stop is, and what the pass returns. This file decides none of that and restates
none of it. It covers how the pass is started, how the read is fetched, and how to tell that
the board it was scoped from was itself complete.

Where that leaves a gap this file cannot close on its own — an open issue the board filter
does not return — it says so in the report and names it. It does not invent a rule to
handle it; changing what triage returns or what stops it is an edit to the policy, and that
is the owner's (config `owner`) call under the repo's process-change rules.

## Config and policy

Read the merged config with `winston config` (if unavailable, read `~/.winston/config.json`
and the repo's `.winston/config.json`, repo winning).

- **Policy**: the file named by config `triage.policy`, default `TRIAGE.md` at the repo root.
  Read it completely before anything else. **No policy file, no pass**: say so in one line and
  stop. Triage without a policy is a guess.
- **Board**: config `board` — `owner`, `number`, `statuses`, `priorityField`. No board
  configured: say so in one line and stop. `winston init` creates one; `winston doctor` checks it.
- **Fetch**: config `triage.fetch`, a repo script that performs the read below. Optional.
- **Reconcile**: config `triage.reconcile`, a repo script that performs the reconciliation
  below. Optional.
- **Profile**: if config `profiles.winston` names a file, apply its `## /winston:triage`
  section, if any. The policy wins over it.

## The read

**One complete read, never a per-issue `gh issue view` loop.**

If config `triage.fetch` names a script, run it. It must follow this contract, and its exit
status is read, not its output:

| Exit | Means | Do |
|---|---|---|
| 0 | a complete read | proceed |
| 1 | it came back short, and the missing issue or truncated thread is named | stop |
| 2 | the question could not be asked — no `gh`, no auth, no board | stop |

Otherwise do the read yourself with `gh api graphql`, to the same contract:

1. **Scope** from the board: page `organization(login:)` / `user(login:)` →
   `projectV2(number:)` → `items` (100 per page, follow `pageInfo` to the end), keeping Issue
   items from this repository and their Status (and Priority, from `board.priorityField`).
   Pass `includeArchived`-style options explicitly where the API offers them: an issue closed,
   archived off the board and later reopened is open work. Apply the policy's scope (statuses,
   milestones, excluded labels) to that list.
2. **Content**: for every in-scope issue, title, body, labels, milestone, and **every
   comment**, in aliased batches rather than one call per issue. Page any comment connection
   whose `totalCount` exceeds what came back.
3. **Completeness guard**: compare each connection's `totalCount` with the rows returned. Any
   shortfall — a missing issue, a truncated thread, a GraphQL error or null — is exit 1:
   name it and stop.

**An unreachable board is never an empty scope.** Check the status rather than the output; a
pass that "found nothing to do" because the board was unreachable is the worst available
outcome. A partial read is just as bad: it is how an issue gets an approval label for a defect
its own comments had already retracted.

## Reconcile the board before trusting the scope

The read scopes through the board, so anything the board does not return is outside the pass
by construction — and absence is what a clean run looks like. Check it directly.

If config `triage.reconcile` names a script, run it. Its exits: **0** — clean, the scope can be
trusted; **1** — it names each `MISSING-FROM-BOARD` issue on stdout; **2** — a side was
truncated or unreadable, the diff would lie, **stop** rather than reading silence as a clean
board.

Otherwise compare the two complete lists yourself: every open issue in the repository
(`gh issue list --state open --limit <N> --json number`, where a result at the limit is
truncated — widen it or stop) against every open issue the board returned. Guard both sides
before diffing; a truncated side is exit 2.

**A left-only number is an open issue no board-scoped query returns.** Name every one of
them at the top of the report, and **do not describe the pass as covering the board** while
any card is unaccounted for. An issue can be open, on the board, unarchived, in scope by every
field, and still absent from a board query for hours while one filed later is returned.

**This is a reporting rule, not a triage rule, and deliberately so.** The policy owns what
triage decides and what it returns. Making an invisible card an extra return, or a hard stop,
changes that contract and is the owner's call on the policy; propose it through the repo's
process-change route rather than taking it here. Until then the pass runs, and the gap is
loud in the report instead of silent in the scope.

## Apply what the policy decides

Write only what the policy's effects name — labels, the Priority value, a plan comment —
with `gh`: `gh issue edit --add-label/--remove-label`, `gh issue comment`, and for a board
field `gh project item-edit` (or the GraphQL mutation the policy names, for example a
repository issue field rather than a project field). Never move status unless the policy says
triage does. A run that reaches the conclusion already recorded writes nothing, where the
policy says so.

## Scope is never narrowed to the cards someone named

Radar or another caller may report missing readiness; this skill still runs whole-scope
unless the policy itself defines a narrower entry point. An issue already carrying a plan is
re-read and its plan rewritten where the history now says something the old plan did not
account for — if the policy says so.

## Reporting

Report exactly what the policy's reporting section asks for, preceded by any
`MISSING-FROM-BOARD` issues from the reconciliation. That is a report, not a request.
