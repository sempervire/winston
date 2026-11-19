---
name: handoff
description: Compatibility alias for Winston handoff mode. Run the closeout gate, compose a successor prompt carrying the authorization contract, and print it for a fresh session with clipboard output where available. Use when the user runs /winston:handoff or asks to continue this work in a new session.
---

# /winston:handoff

This skill remains as a public compatibility alias. Run `/winston handoff [focus]` and follow
the **Handoff mode** section in `skills/winston/SKILL.md`. That mode preserves the closeout
gate, successor prompt, authorization contract, full chat output, and `pbcopy` output where
available. It is universal and prompt-only: it never launches iTerm, Claude, Codex, or any
other session. Do not delete or invoke the legacy launcher files as part of handoff.

Closing report rule: every pending item is already done, a concrete command
(put on the clipboard when it is one command on macOS), or a question-box choice with the
recommended option first. Never end on a bare statement. If closeout reports a blocker, name
the smallest action that clears it and ask for that preserving action.
