# Triage policy

The rules `/winston:triage` and the triage-on-new-issue workflow obey in this repository.
The triage skill is only an engine: every judgment it makes comes from this file. This is a
starter written by `winston init`. Edit it to fit the project; the owner (config `owner`)
decides what it says.

## Scope

- A whole-board pass covers every open issue on the board (config `board`) whose Status is
  the intake status (the first of `board.statuses`, `New` by default) or that has no
  `risk:` label.
- A run started for one issue (the workflow on a new issue) covers that issue only.
- Pull requests and closed issues are out of scope.

## What is read

The whole issue: title, body, labels, milestone and every comment. Where a comment
contradicts the body, the comment wins.

## Risk tiers

Every triaged issue carries exactly one of these labels. When the tier changes, remove the
old label.

- `risk: high` – touches credentials, secrets, auth or `.github/workflows/`, deletes data,
  needs changes in another repository, has open-ended scope, or needs a decision from the
  owner.
- `risk: medium` – a logic change, or a change that spans several files.
- `risk: low` – docs, copy, or an isolated one-file fix.

In doubt between two tiers, take the higher.

## Priority

Set the board's Priority field (config `board.priorityField`) to one of:

- `P0` – production is broken or data is at risk; work stops for it.
- `P1` – blocks the current milestone or a user's main path.
- `P2` – should be done in the current milestone; has a workaround.
- `P3` – worth doing, not scheduled.

A Priority the owner set by hand is kept.

## Effects

Triage writes these and nothing else. It never edits code, moves Status, closes an issue,
merges or deploys.

1. One `risk:` label, as above.
2. The Priority value, as above.
3. `auto-verify` when an agent can run the verification, otherwise `human-verify`.
4. `auto-merge` only on a `risk: low` issue whose verification is `auto-verify`.
5. One comment, only when the tier, the Priority or the plan is new or has changed: the
   tier and why, the Priority and why, and a plan of a few lines. A run that reaches what
   is already recorded writes nothing.

## Test and junk issues

An issue that is plainly a test, spam, empty, or a duplicate gets `risk: low`, Priority
`P3`, and a one-line comment saying which it is (naming the duplicate's number). Triage
does not close it; the owner does.

## Report

End every pass with:

- one line per issue: number, title, tier, Priority, and what was written or "unchanged";
- the issues that need the owner's decision, with the question for each;
- anything that could not be read or written, and why.
