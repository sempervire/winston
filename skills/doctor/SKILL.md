---
name: doctor
description: Check Winston's setup in this repo and on this machine - config, GitHub board, labels, branches, and which optional tools (Codex, Gemini key, chattr) are on or off. Use when the user runs /winston:doctor, asks whether Winston is set up correctly, or a Winston skill reports a missing prerequisite.
---

# /winston:doctor

Run `winston doctor` from the repository root and show its output unaltered. It is read-only.

If the `winston` command is not on PATH, say so in one line: the plugin's `bin/` is not on
this harness's PATH, so run it by its path inside the plugin (`<plugin root>/bin/winston
doctor`, the plugin root being two directories above this skill's directory).

When it reports missing GitHub setup that `winston init` creates, offer `/winston:init` in one
line. Do not run it: init writes to GitHub and needs its own confirmation.
