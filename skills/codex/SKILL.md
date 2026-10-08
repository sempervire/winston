---
name: codex
description: Ask Codex, a second model family over the codex CLI, for a read-only second opinion or a diff review from any project. Use when the user runs /winston:codex, or when a workflow calls for a Codex consult (e.g. evaluating discovered work). Requires the codex CLI.
---

# /winston:codex

Ask Codex whatever is in front of us: `/winston:codex does this migration need a backfill?`.
With no argument, hand it the decision on the table.

Codex is **not** one of the repo's advisor agents. It has no agent file, no verdict
vocabulary, and no persona — it is a second model reached over the `codex` CLI.
`/winston:verdict` does not govern it.

**Codex is required.** Check `command -v codex` first. If it is absent, say in one line that
`/winston:codex` is off because the `codex` CLI is not installed, and stop.

**Read `second-opinion.md` in this skill's directory too.** It holds the prompt's two blocks, the review
rules and the verbatim relay rule. This file covers only Codex's invocation and quirks.

The user typed this, verbatim:

````
$ARGUMENTS
````

## There is no MCP path — do not look for one

`codex-cli` (as of 0.154.0) has no `mcp-server` subcommand; the string does not exist in the
binary. `codex mcp` manages the MCP servers *Codex itself* consumes, and
`codex app-server` exposes only `daemon`/`proxy`/`generate-*`. Anything that registers
`codex mcp-server` as a stdio MCP server — a root `.mcp.json`, an `[mcp_servers.codex]`
block — dies with `stdin is not a terminal`, which Claude Code reports as
`codex (CONNECTION_CLOSED)`. Such a definition can live outside the repo as well as in
it — `~/.codex/config.toml` and `~/.claude.json` both register servers — so check there
before concluding the registration is absent. Do not create one, and do not build an MCP
shim that wraps the CLI: a wrapper between the calling agent and Codex is out of scope.

## How to consult it

**Never interpolate the prompt into the command line.** Write it to a file with a
quoted heredoc, then pass the file's contents. The user's words routinely contain
backticks, `$`, and quotes; inside a double-quoted shell argument those are live
shell syntax, so ``/codex is `rm -rf build` safe in CI?`` would run `rm -rf build`
here before Codex ever saw the question, and `/codex why is $PATH empty?` would send
an expanded `$PATH` instead of what they asked. A quoted heredoc (`<<'CODEX_PROMPT'`)
expands nothing, which is the only way "pass the user's words through unchanged" is
actually true.

```
PROMPT=$(mktemp /tmp/codex-prompt.XXXXXX)
ANSWER=$(mktemp /tmp/codex-answer.XXXXXX)

cat > "$PROMPT" <<'CODEX_PROMPT'
<the two blocks from second-opinion.md, "The assembled prompt">
CODEX_PROMPT

codex exec --cd "$(git rev-parse --show-toplevel)" --sandbox read-only \
  -o "$ANSWER" "$(cat "$PROMPT")" < /dev/null \
  && cat "$ANSWER" \
  || echo "CONSULT FAILED — do not read $ANSWER, it is empty or stale"
```

- **`--sandbox read-only` always**, unless the user has authorized writes for that request.
- **Redirect stdin: `< /dev/null`.** Without it `codex exec` inherits the Bash tool's
  open non-TTY stdin, prints `Reading additional input from stdin...` and hangs
  forever — it never reaches the model. This is the cause of essentially every hang.
- **`mktemp` the answer file, and check the exit code before reading it.** On auth
  expiry, a rate limit or a bad model, `codex exec` exits non-zero *without writing
  the file*. A fixed path like `/tmp/codex-answer.md` then still holds the previous
  consult's reply, and relaying it verbatim hands the user a stale second opinion as a
  fresh one with nothing in the output to reveal it. Concurrent sessions clobber a
  fixed path the same way — peer sessions do run consults in this tree.
- **`-o <file>` (`--output-last-message`)** writes just the final message. Without it
  Codex prints its answer twice on stdout and you are parsing around `tokens used`.
- **Derive `--cd` from the session's cwd**, as above — do not hardcode the main tree.
  Agent sessions run in `.claude/worktrees/`, and a hardcoded path points Codex at a
  different checkout of the files under discussion. It reads code that is not the
  code being argued about, and says nothing about the mismatch.
- **`--add-dir <DIR>` makes a directory WRITABLE**, despite the name — `codex exec
  --help`: "Additional directories that should be writable alongside the primary
  workspace." It is not a read grant. Under `--sandbox read-only` it is a no-op, so
  reads outside `--cd` already work without it; if the user has authorized writes, adding
  a path here hands the model write access to that tree. It is also not a remedy for
  a hang — see the stdin bullet.
- **Set the Bash tool's own `timeout` to ~240000.** `timeout(1)` may not exist
  (stock macOS lacks it), and a consult takes a minute or two. Expect ~20-30k Codex-side
  tokens for a simple question.
- There is no `--ask-for-approval` flag on `exec` in this version.

## When it answers about itself

Any question about its own model, routing or configuration must come back with each
claim labelled: **observed from `~/.codex/config.toml`**, **observed from `codex doctor`**,
or **inferred from runtime behavior**. The three disagree, and `codex doctor` currently
reports reachability failures against `api.openai.com` while inference works fine — so
an unlabelled answer is not evidence of anything. Ask for the labels in the prompt.


## Reviewing a diff with Codex

**Run it from the worktree holding the change**, so `--cd` points Codex at the same checkout
the diff came from. A consult run from the wrong tree reads different files and says nothing
about the mismatch.

**In a worktree-isolated session, pass `--cd` as a literal path**, not
`"$(git rev-parse --show-toplevel)"`. The isolation guard refuses a command that computes a
value at runtime inside a construct it cannot verify, and `$(cat "$PROMPT")` is refused for
the same reason. Two consequences, both measured:

- Put the prompt in the argument as a literal, or point Codex at the prompt file by path and
  let it read the file. Do **not** redirect the prompt in on stdin — `codex exec` accepts it
  but answers as though it had received a notification, and `-o` captures a one-line
  acknowledgement instead of a review.
- When Codex is pointed at a file, its review lands on **stdout** and `-o` may capture only
  a trailing meta-remark. Capture stdout to a file as well as `-o`, and check both before
  relaying. `> /dev/null` will throw the review away with exit code 0.

