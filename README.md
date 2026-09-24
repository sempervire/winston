# Winston

<img src="assets/winston.png" alt="Winston" width="720">

Orchestration persona for long, unattended Claude Code work sessions. Winston selects the work, clears human-needed tasks up front, waits for authorization, then runs lanes, merges, and verification through subagents.

## Install

```sh
sed "s|__WORKFLOW_PATH__|$PWD/workflow.md|" claude/commands/winston.md > ~/.claude/commands/winston.md
```

## Use

- `/winston`: choose the work set and begin setup. Nothing starts until you authorize the two lists it shows.
- `/winston <instruction>`: follow the instruction.

Winston runs in the main session, not as a subagent, so it ships no agent file. ShareView checkouts and worktrees apply `profiles/shareview.md`. The repository's process docs win where they conflict with the workflow.

## Release history

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
