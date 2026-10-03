---
name: init
description: Create the GitHub setup Winston needs in this repo (board, statuses, priority field, labels, triage workflow template, .winston config), showing the plan first and applying it only after the user confirms. Use when the user runs /winston:init, or after /winston:doctor reports missing setup the user wants created.
---

# /winston:init

`winston init` writes to GitHub and to the repository, so it runs in two steps and never
skips the first.

1. **Plan.** Run `winston init` from the repository root, without `--yes`. It changes nothing
   and prints what it would create. Show that plan unaltered.
2. **Confirm.** Ask the user to confirm in a question box (`AskUserQuestion` in Claude Code,
   `request_user_input` in Codex, or a plain question in chat), with the plan's actions as the
   question text. Silence or a general go-ahead given earlier is not confirmation.
3. **Apply.** Only after an explicit yes, run `winston init --yes` and show its output
   unaltered, then run `winston doctor` to confirm the result.

If the `winston` command is not on PATH, run it by its path inside the plugin
(`<plugin root>/bin/winston`, the plugin root being two directories above this skill's
directory). If init fails partway, report what it created and what it did not; do not retry
or repair by hand.
