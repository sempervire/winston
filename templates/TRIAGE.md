# Triage policy

Starter policy for `/winston:triage`, written by `winston init` because a repo cannot run
a pass without one. Edit this file until it says how triage actually works here; nothing
in it is special to Winston.

## Scope

Every open issue on the board, in any status. An issue already carrying one of the `risk:`
labels below has already been triaged; re-read it only when a later comment says something
its label or plan does not account for.

## Risk

Read the issue and every comment completely — where a comment contradicts the body, the
comment wins — then apply exactly one of these labels:

- `risk: high` — touches credentials, secrets, auth, or `.github/workflows/`; deletes
  data; has open-ended scope; needs a decision from the owner; or needs changes in
  another repository too.
- `risk: medium` — a logic change, or one that spans several files.
- `risk: low` — docs, copy, or an isolated one-file fix.

## Priority

Set the board's Priority field: `P0` broken now and user-facing, `P1` should land this
cycle, `P2` normal backlog, `P3` nice to have. Leave it unset where neither the issue nor
this policy gives a clear signal.

## Verification

Apply where the risk tier allows it:

- `auto-merge` — may be built, verified and merged without a further ask.
- `auto-verify` — an agent can run the verification itself (tests, a script, a build).
- `human-verify` — verification needs a person.

`risk: high` gets none of these: it stops for a decision before any work starts.

## Reporting

For each issue triaged this pass: its number, the risk tier and why, the Priority set, and
the verification label applied. List separately any issue that already carried a `risk:`
label whose comments now say something that label no longer fits.
