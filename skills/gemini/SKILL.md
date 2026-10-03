---
name: gemini
description: Ask Gemini, a third model family, for a read-only, low-cost second opinion or diff review from any project via the gemini CLI. Use when the user runs /winston:gemini or wants a cheap independent review. Requires the gemini CLI and a paid-tier GEMINI_API_KEY.
---

# /winston:gemini

Ask Gemini whatever is in front of us: `/winston:gemini review PR 351`, or
`/winston:gemini is a unique index enough here?`. With no argument, hand it the decision on the
table.

Gemini is a **third model family** next to Claude and Codex, used for low-cost reviews
and second opinions. Like Codex, it is not an advisor agent. It is advisory only and
satisfies no project gate unless that project's rules say it does.

**Read `../codex/second-opinion.md` (relative to this skill's directory) too.** It holds the prompt's two blocks, the review
rules and the verbatim relay rule. This file covers only Gemini's invocation and quirks.

**Gemini is required.** Check `command -v gemini` and that a key is available (below). If
either is missing, say in one line which, that `/winston:gemini` is off, and stop.

The user typed this, verbatim:

````
$ARGUMENTS
````

## How to consult it

```
PROMPT=$(mktemp "${TMPDIR:-/tmp}/gemini-prompt.XXXXXX")
ANSWER=$(mktemp "${TMPDIR:-/tmp}/gemini-answer.XXXXXX")

cat > "$PROMPT" <<'GEMINI_PROMPT'
<the two blocks from second-opinion.md, "The assembled prompt">
GEMINI_PROMPT

cd <literal path of the worktree holding the change> && \
GEMINI_API_KEY=${GEMINI_API_KEY:-$(security find-generic-password -s GEMINI_API_KEY -w)} \
gemini -m gemini-3.8-flash --approval-mode plan --skip-trust \
  -p "Answer the request in the input. Do not modify anything." \
  < "$PROMPT" > "$ANSWER" \
  && cat "$ANSWER" \
  || echo "CONSULT FAILED - do not read $ANSWER, it is empty or partial"
```

- **`--approval-mode plan` always.** It is the CLI's read-only mode: file writes and
  shell commands are denied by policy, as measured on 0.61.0. The one write it allows is
  a plan `.md` in the CLI's own plans directory outside the repo. Never use `yolo` or
  `auto_edit`.
- **The prompt goes in on stdin, and `-p` carries only the fixed instruction.** `-p` is
  appended to stdin, so the user's words never pass through the shell. The quoted heredoc
  rule from `/winston:codex` applies unchanged: the user's words never touch the command line.
- **Run it from the worktree holding the change, and write that path as a literal**,
  not `$(git rev-parse ...)`. The CLI's workspace is the cwd, and the worktree
  isolation guard refuses computed paths.
- **Check the exit code before reading the answer.** A bad model exits 1 and a missing
  key exits 41. Either way the answer file holds no review.
- **stderr is noise** (for example `Ripgrep is not available`). The answer is stdout.
- **Set the Bash tool's `timeout` to ~240000.**

## Which model

| Use | Model | Approx. cost per review |
|---|---|---|
| Default | `gemini-3.8-flash` | ~$0.05 |
| High blast radius (auth, access control, payments, schema, production data) | `gemini-3.1-pro-preview` | ~$0.14 |

These are estimates at ~50k input and ~3k output tokens, at 2026-09-25 prices. Flash
rates double on 2027-01-01.

## The key

`GEMINI_API_KEY` comes from the environment, or else from the macOS keychain (service
`GEMINI_API_KEY`), as the command above reads it. Use a **paid-tier** key restricted to the
Gemini API, so prompts are not used for training. Never use a free-tier key: free-tier
prompts are used for training. If the key shares a project's rate limit with production
traffic, do not fan out parallel consults.

## Relaying

Name the reviewer and the head SHA as `second-opinion.md` says: "Gemini
(`gemini-3.8-flash`) reviewed `<sha>`".
