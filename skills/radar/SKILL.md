---
name: radar
description: Read-only planning aide that picks the next task, batches related work into the time available, and protects warm context. Use when the user runs /winston:radar, asks what to work on next, has a time block to fill (e.g. "I have 45 minutes"), or wants work sequenced; also used by /winston for work selection.
---

# /winston:radar

Consult Radar on what to do next, how to batch the available time, or how to sequence the work
in front of us. With an argument, aim him at that: `/winston:radar I have 45 minutes, what
should I do?`. With none, hand him the current planning context.

The Radar agent definition owns his judgment and output format. This file only covers how he
is reached.

## Config and profile

Read the merged config with `winston config` (if unavailable, read `~/.winston/config.json`
and the repo's `.winston/config.json`, repo winning).

- **Which agent.** Config `advisors.radar` names a repo-specific Radar when set. Otherwise use
  the generic one: `winston:radar` in Claude Code, `radar` in Codex (installed by
  `winston install-codex-agents`). If it is not available, say so in one line and stop.
- **Profile.** If config `profiles.winston` names a file, read its `## /winston:radar` section,
  if any, completely and follow it; it replaces the state checks, relay and follow-up steps
  below where it covers them. Use exactly one flow; never combine the two.

## How to consult him

**Once per session, then keep him.** Spawn him the first time (Claude Code:
`Agent(subagent_type: <radar agent>, run_in_background: false)`). Every consult after that goes
to the same Radar (`SendMessage` in Claude Code), so his context is intact and he remembers
what the user has already done, deferred, or said about available time.

**Address him by the `agentId` the spawn result gives us, never by the bare name `radar`.** Keep
that string for the session and pass it as `to:`. If the ID is lost, recover his row from
`ListAgents`; do not spawn a second Radar just to get a fresh ID.

**Always synchronous.** `run_in_background: false`, without exception. Radar exists to guide the
next decision, so a delayed answer defeats the purpose.

**Pass the user's words through verbatim.** Do not summarize, sharpen, or add context they did not
give. They are talking to Radar; we are the wire.

User typed this, verbatim:

````
$ARGUMENTS
````

With no argument, provide the useful planning context already available in the session. Do not
require a formal brief.

## Establish current state first

Run read-only state checks before the first spawn and pass the results in. Re-run them when the
work may have moved: after a merge, an issue close, or when results are more than about an hour
old. Adapt these to your repository:

```sh
gh issue list --state open --limit 100 --json number,title,labels
gh pr list --state open --json number,title,headRefName,statusCheckRollup
git branch --show-current
git log --oneline -10
```

Where config names a `board`, add its open items and their Status from `gh` (Projects v2 for
`board.owner` / `board.number`). Where chattr is installed, add `chattr state` so claimed work
is not offered; without it, say ownership is unknown.

**Repository access is a hard prerequisite.** If a required read fails, stop. Report the failed
read and its real error; do not consult Radar from stale or remembered state. Where a check comes
back dirty, pass it dirty; naming the gap is his job.

## Relaying him back

**His answer must appear in the main conversation thread.** Finishing the agent call is not
completion. After the call returns, emit one assistant response whose body begins with his
returned text, unaltered, header line and all.

**After his block: nothing**, unless a factual correction is required. Radar is advisory and does
not create issues, edit files, or change project state.
