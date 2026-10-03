# Second-opinion rules

Shared by `/winston:codex` and `/winston:gemini`. Read this together with the model's own
SKILL.md, which covers how to invoke that model and its quirks.
These are other model families giving read-only opinions. They are not the
`/winston:consult` advisors (Debbie and Sheldon) and `/winston:consult` does not govern them.

## The prompt: context, then the message

The model cold-starts on every consult. It has no memory of prior consults and no view
into this conversation — a plan we have been building in chat, a diagnosis, a design
half-argued, none of it exists to the model until it is written into the prompt. The repo
it can read for itself. **The conversation it cannot.**

So the prompt carries two blocks, in this order, under these exact headers.

### 1. Context the calling agent is supplying

Assemble this before running the command. It is the calling agent's writing and must be labelled
as its own — never fold it into the user's block, and never put our framing under their name.

- **The decision on the table.** State it in full, as it currently stands, in enough
  detail that someone who has read the repo but not this conversation could argue
  either side. If we are mid-plan, that means the actual plan — the steps, not a
  gesture at them.
- **The paths it touches.** Files, directories, issue numbers, PR numbers. Give the model
  the pointers and let it read; do not paste file contents it can open itself.
- **What has already been ruled out, and why.** Otherwise it spends its answer
  re-proposing the thing we rejected an hour ago.
- **Our current lean, and where the real doubt is.** Which way we are leaning and
  what is genuinely unresolved. Without this a consult reads as neutral when it
  rarely is, and the model spends its answer confirming the part we were already sure
  of instead of attacking the part we are not.
- **What we actually want from it** — a sanity check, a missed failure mode, a
  cheaper approach, a second read on a tradeoff.
- **Nothing else.** Not the session's history, not our reasoning chain, not
  transcript dumps. Context is what the model needs to answer, not everything we know;
  padding it buys worse answers and more tokens.

When there is genuinely no context — a standalone question that stands on its own —
say so in one line rather than omitting the header.

### 2. The user's words, verbatim

Pass the user's words through unchanged — do not retype from memory, summarize, or sharpen.
When the agent is asking rather than the user, say so instead of putting our framing under
their name.

Their message is the four-backtick fence in the invoking SKILL.md (`/winston:codex` or
`/winston:gemini`), where the harness substitutes it.

### The assembled prompt

Both blocks go into the heredoc, in this order, under these headers:

    Context the calling agent is supplying (not the user's words):

    <the context block>

    User typed this, verbatim:

    <their message, exactly as it appears above>

## Reviewing a diff

A consult can carry a code change instead of a question: an **optional, read-only second
opinion** on a diff. It uses the model file's invocation unchanged — same
two blocks, same failure handling. It adds no transport, no wrapper, no response schema,
no automatic trigger and no gate.

Before using a consult as a code-review artifact, read the current repository's rules and required checks. The consult is advisory and satisfies no project gate unless that project's rules explicitly say it does. Ask the model for findings only; the caller decides whether and where to publish them.


### What the context block carries

Everything under "1. Context the calling agent is supplying" still applies. For a review it means:

- **The diff itself**, actually pasted in: `gh pr diff <N> --repo <owner>/<repo>`
  for an open PR, or `git diff <base>...<head>` for a committed branch. This is the one
  case where pasting content earns its tokens. The model *can* reconstruct a committed diff
  itself once it has the base and head SHAs — pasting is not the only way — but the tree it
  reads is the post-change state, so leaving it to reconstruct means it may diff the wrong
  pair of refs and say nothing about having done so. Paste the exact comparison.
- **What is being reviewed**: repository, issue and PR number, target branch, and the head
  SHA. The SHA is what makes the review re-checkable later.
- **The problem and the intended behavior**, so it can judge whether the change solves it
  rather than only whether it parses.
- **Constraints from outside the changed lines** — the repository rules that apply, and any
  compatibility or security boundary the change sits near. Point at files; do not paste
  what the model can open.
- **What has been exercised**: test commands and their results, known gaps, and the specific
  thing being worried about.

### What to ask for

Actionable findings **introduced by the change** — correctness, regression, security, test
coverage — each with a file and line reference and the impact. Ask it to read the callers
and tests around the diff rather than the diff alone, and to say plainly where it lacked
context or coverage rather than filling the gap with a guess.

### Relaying a review

The verbatim rule in "Relaying the answer back" applies without exception, plus two things
a review needs:

- **Name the reviewer and the head SHA** — "Codex (`<model>`) reviewed `<sha>`" or "Gemini (`<model>`) reviewed `<sha>`" — so a
  reader knows what was looked at and that it was not `/code-review`.
- **Report "no findings" as a result, and its limits with it.** A clean read of a thin diff
  is weak evidence, and saying so is part of the answer.

**A failed consult is not a clean review.** The exit-code check in the model's SKILL.md is what separates the
two: if the CLI exits non-zero the answer file is empty or stale, and there is no
review — not an empty one.

## Relaying the answer back

**The model's answer must appear in the main conversation thread, verbatim.** It is
something to relay, never something to parse. Do not impose a schema, a verdict enum
or a JSON shape on it, and do not branch orchestration on its contents; what to do
with a second opinion is the user's call after they read it.

**Finishing the consult is not completion.** The answer arrives in a file rather than
in chat, which makes this the easiest consult to leave unrelayed — reading `$ANSWER`
and acting on it is not delivery. The turn must not end until a user-visible
assistant response carrying the answer has been sent to the user.

Its answers are opinions. Nothing in them authorizes an edit.
