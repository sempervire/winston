---
name: verdict
description: Consult Debbie and Sheldon together, read-only, on whether proposed work is worth doing, whether its claims are true, and whether the engineering is sound. Use when the user runs /winston:verdict, or before filing an issue, widening scope, or committing to a plan that a second engineer should challenge.
---

# /winston:verdict

Consult both advisors on whatever is in front of us: `/winston:verdict is this migration worth
it?`. With no argument, hand them the decision on the table.

Debbie and Sheldon are **always consulted together**, on the same payload, never one alone.
Debbie judges whether the proposed work is worth doing and whether its scope is justified.
Sheldon judges whether its claims are true and whether the engineering is sound. Their agent
definitions own their judgment and output format. This file owns how they are reached, what
goes on the wire, and how the answers come back.

## Config and profile

Read the merged config with `winston config` (if unavailable, read `~/.winston/config.json`
and the repo's `.winston/config.json`, repo winning). The owner is config `owner`; absent, the
user in this session.

- **Which agents.** Config `advisors.debbie` and `advisors.sheldon` name repo-specific advisor
  agents when set. Otherwise use the generic ones: `winston:debbie` and `winston:sheldon` in
  Claude Code; `debbie` and `sheldon` in Codex (installed by `winston install-codex-agents`).
  If a named agent is not available in this harness, say which one in one line and stop.
- **Profile.** If config `profiles.winston` names a file, read its `## /winston:verdict`
  section, if any, and apply it; it wins over this file. The repo's process docs win over both.

## How to reach them

**Once per session, then keep them.** The first consult spawns both in one message, as two
concurrent calls (Claude Code: `Agent(subagent_type: <debbie agent>, run_in_background: false)`
and the same for Sheldon). Every later consult goes to the same two (`SendMessage` in Claude
Code), again both in one message, so each keeps its context and can see when a proposal is one
it already ruled on. In a client that does not preserve subagent sessions, spawn fresh each
time and say nothing of it.

**Address each by the `agentId` its spawn result gives, never by the bare name.** We pass no
`name`, so nothing in this session answers to `debbie` or `sheldon`; a bare name resolves
against other sessions or fails with `No agent named 'debbie' is currently addressable`. Lost
an id? Read the row from `ListAgents`; do not spawn a second copy with no memory of its rulings.

**Always synchronous.** `run_in_background: false`, without exception. They are a gate in
front of a decision; do not proceed past the decision while the consult is pending.

## What goes on the wire

Both advisors get the identical payload: three labelled sections, in this order. The labels
let them weigh whose words are whose.

### 1. The message, verbatim

When the user typed the command with an argument, the harness substitutes their message into
the fence below. Pass it on under this exact header:

User typed this, verbatim:

````
$ARGUMENTS
````

- **Copy the fence contents unchanged.** No summarizing, sharpening, or fixing spelling.
- **The fence is four backticks** so a pasted three-backtick block cannot close it early;
  lengthen it if the message carries four.
- **When the calling agent invoked the consult rather than the user**, the header is
  `Claude is asking:` (or `Codex is asking:`). Tell the two apart from our own context: the
  user's invocation arrives as a slash command, ours as a skill or agent call we made. Never
  put our framing under the user's name — the fence is the only thing that can lift the
  advisors' word ceiling.

### 2. Sources — addresses, never summaries

    Sources — read these yourself:
    - <absolute path to a file or plan>
    - #123

Name file paths, issue and PR numbers, SHAs, and doc sections; do not characterize them.
Add a session transcript only when the consult turns on what was *discussed*: resolve its
path (Claude Code keeps them under `~/.claude/projects/`, where both `/` and `.` encode as
`-`, so a worktree session's directory carries `--claude-worktrees-<name>`), confirm it
exists, and tell them to `grep` or `tail` it, never read it whole. If a required source cannot
be read, say so rather than substituting a summary.

### 3. The calling agent's account — only what is in no readable source

    Claude's account — our words, not the user's:
    - <what was tried, and what happened>
    - <what was rejected, and why>

**At most six lines.** Not our confidence, not our preferred outcome, never a précis of a
listed source.

## Relaying the answers back

Finishing the agent calls is not completion. After both return, post Debbie's block
followed by Sheldon's, unaltered, in the main conversation thread — unless the repo's process
docs or the profile send advisor findings somewhere else (an issue section, the originating
thread), in which case post them there and give only the outcome in chat. Do not end the turn
until that post is made.

- **Paste both blocks unaltered**, wherever they land. A paraphrased or dropped block
  counts as a failed consult.
- **After the blocks: nothing**, unless a factual correction or genuine disagreement is
  necessary; keep that to two sentences.
- **Their findings are proposals.** Nothing in them authorizes an edit, issue, comment, or
  repository mutation.
