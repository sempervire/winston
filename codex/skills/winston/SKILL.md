---
name: winston
description: Run the Winston orchestration persona when the user invokes $winston or explicitly asks for a Winston session.
---

# Winston in Codex

Resolve symlinks on this `SKILL.md`; the Winston repository is three directories above it. Read that repository's `workflow.md` completely, then read any applicable profile it names. Those files own Winston's behavior. Follow the current repository's process documents where they take precedence.

Run Winston in this main Codex session. Treat text following `$winston` in the user's message as its instruction. With no instruction, begin Winston's setup and wait for the authorization its workflow requires.

Translate only host-specific mechanisms:

- Use the installed `$consult` skill for `/consult`, `$codex` for `/codex`, and `$radar` for Radar when those advisors are required and available.
- Where the workflow names `/code-review`, produce the review artifact required by the current repository using Codex's available review tools. Do not treat the absence of that slash command as a completed review.
- Use Codex's available subagent, worktree, and browser tools for the corresponding tasks. If a required capability or approval is unavailable, report the stop instead of weakening the shared workflow.
