# Winston

<img src="assets/winston.png" alt="Winston Wolf with his sports car: Just do exactly as I say and everything will be just fine." width="720">

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

## Codex

Use a separate Winston clone for Codex if you want to leave Claude's checkout untouched. For example:

```sh
git clone https://github.com/sempervire/winston.git ~/Developer/winston-codex
cd ~/Developer/winston-codex
```

From that checkout, install the skill as a link:

```sh
codex_skills_dir="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$codex_skills_dir"
ln -s "$PWD/codex/skills/winston" "$codex_skills_dir/winston"
```

`ln` stops if `winston` already exists; inspect that path before replacing anything. In a new Codex session, invoke `$winston` to start setup or `$winston <instruction>` to give it a specific instruction. The skill reads this checkout's `workflow.md` and applicable profile. Pull updates in the Codex checkout to apply published Winston changes to new Codex sessions. Claude's checkout, command, and installation need no change.
