---
name: doctor
description: Check Winston's setup in this repo and on this machine - config, GitHub board, labels, branches, and which optional tools (Codex, Gemini key, chattr) are on or off. Use when the user runs /winston:doctor, asks whether Winston is set up correctly, or a Winston skill reports a missing prerequisite.
---

# /winston:doctor

Run `winston doctor` from the repository root and show its output unaltered. It is read-only.

If the `winston` command is not on PATH, say so in one line: the plugin's `bin/` is not on
this harness's PATH, so run it by its path inside the plugin (`<plugin root>/bin/winston
doctor`, the plugin root being two directories above this skill's directory).

When it reports missing setup, or that the repo is not set up for Winston, offer
`/winston:init` in one line. Do not run it: init asks which setup fits, writes to GitHub and
needs its own confirmation. Its **In the browser** list (the board's intake workflows,
which GitHub has no API for) is work `/winston:init` does through browser control: offer
that rather than leaving it with the user. Relay its **By hand** list as it stands.

A **Triage workflow** list means the installed triage workflow is not triaging: its secrets
are missing, or its latest runs failed. Say so plainly, since nothing else reports it, and
offer `/winston:init`, which prints the owner's steps for the secrets. A missing `triage policy` means the policy file is
absent or has no triage rules, so a triage run changes nothing; `/winston:init` offers a
`TRIAGE.md` starter. `unknown` on either
workflow line means this account cannot see them, not that they are missing. Never create a token or
set a secret yourself.

`off` on `project permission rules` lists the allow rules a Winston run uses that the
project's `.claude/settings.json` lacks. The fix is one command the owner runs,
`winston permissions --apply`; relay it, never run it yourself.
