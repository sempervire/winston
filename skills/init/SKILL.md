---
name: init
description: Set Winston up in this repo, after asking which of three situations it is - joining a repo someone already set up for Winston, starting a new project from scratch, or adopting an existing repo Winston did not set up - then showing the plan and applying it only after the user confirms. Use when the user runs /winston:init, installs Winston and asks how to connect it to a repo, or after /winston:doctor reports missing setup the user wants created.
---

# /winston:init

`winston init` sets up one of three things, and which one is the user's call, never a guess.
It runs in three steps and never skips the first two.

1. **Ask which setup.** Run `winston init` from the repository root (or the empty directory
   for a new project), with no flags. It changes nothing and prints the three setups and
   which one the directory looks like. Ask the user in a question box (`AskUserQuestion` in
   Claude Code, `request_user_input` in Codex, or a plain question in chat), the detected
   one first:
   - **join** – the repo is already set up for Winston (its `.winston/config.json` is
     committed). Checks this person's access and machine. Changes nothing in the repo or on
     GitHub; gaps in the repo's own setup are reported as the owner's.
   - **new** – a new project. Creates the GitHub repo, the integration and production
     branches, the board, the config, the labels and the triage workflow.
   - **adopt** – an existing repo Winston did not set up. Fits a config to its default
     branch, an integration branch, a board already linked to it and its process docs, and
     adds only what is missing. Nothing existing is renamed or removed.
2. **Plan.** Run `winston init --mode <join|new|adopt>`, without `--yes`. It changes nothing
   and prints what it would do. Show that plan unaltered. If it lists several boards
   instead, ask which one in a question box and rerun with `--board <owner>/<number>` (or
   `--board new`). Other choices the user may state: `--integration <branch>`,
   `--owner <name>`, and for a new project `--repo <owner>/<name>` and `--public` (the
   repository is private unless they ask otherwise).
3. **Confirm, then apply.** Ask the user to confirm in a question box, with the plan's
   actions as the question text. Silence or a general go-ahead given earlier is not
   confirmation. Only after an explicit yes, rerun the same command with `--yes`, show its
   output unaltered, then run `winston doctor` to confirm the result. A plan with nothing
   under "would" needs no confirmation and no `--yes`.

The output's **By hand** list is for the user: GitHub has no API for those steps (the
board's two intake workflows), or they need access someone else grants. Relay it; do not
attempt them, and do not call the setup finished while it is non-empty.

If the `winston` command is not on PATH, run it by its path inside the plugin
(`<plugin root>/bin/winston`, the plugin root being two directories above this skill's
directory). If init fails partway, report what it did and what it did not; do not retry or
repair by hand.
