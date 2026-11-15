# Winston

<img src="assets/winston.png" alt="Winston, the fixer: Just do exactly as I say and everything will be just fine." width="720">

Winston is a plugin for Claude Code (and Codex). It connects a repository to a GitHub
Projects board, keeps that board triaged, and runs long, unattended engineering sessions off
it: pick the Ready work, clear every human-needed decision up front, build in parallel
worktree lanes, merge one PR at a time, verify, and report.

> "I solve problems."

## Set up in three steps

1. **Install the plugin.** In Claude Code:

   ```
   /plugin marketplace add sempervire/winston
   /plugin install winston@winston
   ```

   In Codex:

   ```
   codex plugin marketplace add sempervire/winston
   codex plugin add winston@winston
   winston install-codex-agents        # Codex plugins cannot ship agents; this copies them
   ```

   Codex asks you to trust the plugin's hooks once (`/hooks`). So that chattr works inside
   Codex's sandbox, add its message store to `~/.codex/config.toml` (doctor checks this):

   ```toml
   [sandbox_workspace_write]
   writable_roots = ["/Users/<you>/.agent-bridge"]
   ```

2. **Run `/winston:init` in the repo.** It changes nothing until you confirm. You will be
   asked:
   - which of three setups this is: joining a repo someone already set up, a new project,
     or an existing repo Winston did not set up (details under [Setup](#setup));
   - to confirm the plan it prints, before anything is created;
   - to have Claude in Chrome connected and signed in to GitHub, for two board settings
     GitHub's API cannot change (without it, you get the two steps to click through);
   - to create two GitHub Actions secrets yourself, if you want new issues triaged
     automatically (init prints the steps; you can do this later);
   - to run `winston permissions --apply` once, so long runs do not stop on permission
     prompts.

   If the repo has no triage policy and no `TRIAGE.md`, init writes a starter `TRIAGE.md`
   at the repo root; it never overwrites an existing file. Rewrite its **Risk tiers**
   section for your repo (init offers to draft it) and commit the file to the default
   branch. Until you do, triage judges by the starter's example tiers and doctor flags them.

3. **Run `/winston:doctor`.** It is the one place to look afterwards, changes nothing in
   the repo or on GitHub, and is safe to run as often as you like. It prints a checklist (`done`, `needs you`,
   `could not check`), says for each open item why it matters and how to fix it, and ends
   with a single **Next step:** line. A newer Winston shows up there as one more item, with
   the update command. If its last run left items open, the next session in that repo
   starts with one line saying so.

Then `/winston` starts a session from the board's Ready column. See [Commands](#commands).

## What you need

**Software.** Claude Code (or Codex), `git`, the GitHub CLI `gh` signed in with the
`project` scope, and [Node.js](https://nodejs.org/en/download) 24 or later (Winston's CLI
and hooks run on it, chattr included).

**Accounts.** Plans and prices change, so this links to each vendor's page rather than
quoting them.

| Account | Needed for | Minimum |
|---|---|---|
| GitHub | The repo, the board, Actions | A free account ([plans](https://github.com/pricing)). |
| Claude | Claude Code; Claude in Chrome for setup's browser steps | A Claude Pro or Max plan, or API billing ([plans](https://claude.com/pricing)). |
| Claude, for triage in GitHub Actions | The token from `claude setup-token` | A Pro or Max plan, plus Actions minutes: free on public repos, a monthly allowance on private ones ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). Optional. |
| ChatGPT or OpenAI | Codex: Rex, `/winston:codex`, the local review pass in build lanes, Codex sessions | A ChatGPT plan that includes Codex, or an OpenAI API key ([Codex pricing](https://developers.openai.com/codex/pricing)). Optional: each feature is off without the Codex CLI. |
| Google Gemini | `/winston:gemini` | A paid-tier Gemini API key ([pricing](https://ai.google.dev/gemini-api/docs/pricing)). Optional. |
| chattr (part of Winston) | Claims, peer messages, the shared-checkout guard | No account. |

The floor is a free GitHub account plus one agent account: Claude Code on a Pro or Max
plan or API billing, or Codex. Winston is built around Claude Code; in Codex alone,
setup's browser steps are yours to click through, and the triage workflow in Actions
still needs the Claude token.

**Platform.** Winston is developed and used on macOS. These parts need it:

- `/winston:handoff` opens the successor session in a new tab only from Claude Code on
  macOS with [iTerm](https://iterm2.com/); in Codex, on another system, or when a
  prerequisite it checks is missing, it prints the prompt for you to paste.
- The `launchers/` scripts drive iTerm through AppleScript.
- `winston doctor --copy` uses the macOS clipboard.
- Doctor's Gemini key check reads the macOS keychain. `/winston:gemini` itself also takes
  the key from the `GEMINI_API_KEY` environment variable, so doctor can show the key as
  off when the variable supplies it, and always does off macOS.
- chattr has only been run on macOS: it reads `ps` and `lsof`, Claude Code's local message
  socket and Codex's message queue. It needs no iTerm and makes no network call.

Nothing else is tied to a terminal or an operating system, but it is untested off macOS.

**Repo shape.** Two long-lived branches (integration and production) and a GitHub Projects
board with the six Status columns below and a Priority field. `/winston:init` sets up what
is missing.

## Setup

`/winston:init` runs `winston init`, which asks which of three setups this is and plans it
before changing anything. To skip the question, run `winston init --mode join`
(or `new`, or `adopt`); it prints the plan, and `--yes` applies it.

| Setup | When | What it does |
|---|---|---|
| `join` | The repo already carries a `.winston/config.json`. | Checks your access (the `gh` project scope, the board, which is shared separately from the repo) and your machine. Changes nothing in the repo or on GitHub. |
| `new` | A new project. | Creates the GitHub repo, both branches, the board, the config, labels and triage workflow. |
| `adopt` | An existing repo Winston did not set up. | Fits a config to its default branch, an integration branch, a board already linked to it and its process docs; adds only what is missing. |

A board Winston builds has six Status columns, in order: `New`, `Ready`, `In Progress`,
`Verify`, `Verified`, `Done`, with fixed colours and descriptions, and a board view filtered
to a milestone whose cards show labels. On a board that already exists, missing columns are
added in that order and Labels is switched on for the view; nothing already there is
renamed, recoloured or removed. Doctor reports any column the board lacks.

Two steps cannot go through GitHub's API, which can delete a project workflow but not
create or enable one: on the board's Workflows page, **Auto-add to project** (this
repository, filter `is:issue`) and **Item added to project** (set Status to `New`). Without
them a new issue never reaches the board. `/winston:init` does both through browser
control, so have [Claude in Chrome](https://code.claude.com/docs/en/chrome) ready during
setup: install the extension, sign in to GitHub in that Chrome, and connect it with
`/chrome` (or start with `claude --chrome`). Without browser control it prints the two
steps for you to do, and doctor reports them until they are done.

The triage workflow needs two Actions secrets that only the owner can create:

- `GH_PAT`, a GitHub token that can write the repo's issues and the board. When a person's
  account owns the board (as on most personal projects), it must be a **classic** token
  with the `repo` and `project` scopes: GitHub's fine-grained tokens cannot reach a
  project a person owns. When an organization owns both the board and the repo, a
  fine-grained token works.
- `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`, so triage runs on your Claude
  plan. No API key is used.

`winston init` checks which exist, by name only, and prints numbered steps for the missing
ones, with the token type GitHub requires for the board's owner and
a link that opens GitHub's token form already filled in. With Claude in Chrome the session
offers to check the form with you and stops before Generate; the token's value is typed
only by you, in your own terminal.
Until both are set new issues are not triaged automatically; `winston doctor` reports the
secrets and whether the workflow's latest runs failed.

Triage in GitHub Actions is a script, not an agent. For each issue it asks Claude, with
no tools, for one verdict, giving it the repo's triage policy and the issue (it asks once
more only if the first answer is unusable). The script then writes the verdict itself: the `risk:` tier, Priority, the plan comment,
the reporter as assignee, and any other labels the policy allows. Because Claude has no
tools in this step, nothing it needs can be silently refused.

- **When it runs.** On each new issue filed by the owner, a collaborator or an
  organization member. Once a day, as a sweep of up to five open issues with no `risk:`
  tier yet (in the board's first two columns, filed by those same people over an hour ago,
  lowest number first, skipping any where triage stopped and is waiting for an answer).
  And when you start it by hand from the Actions tab (one issue by number, or leave the
  number empty for the sweep). Tick `dry_run` to see the verdict without anything being written.
  An issue that already has a `risk:` tier is left alone; re-triaging is the
  `/winston:triage` pass's job.
- **Which labels.** The policy's "Labels triage applies" line lists them; triage writes no
  label that line does not name. The starter `TRIAGE.md` names the `risk:` tier,
  `auto-verify` or `human-verify` (`auto-verify` only at `risk: low` when an agent can show
  the change works; otherwise `human-verify`), and one of `duplicate`, `invalid` or
  `wontfix` when an issue should not be worked. Triage never closes an issue; closing is
  yours.
- **Model.** `opus`, unless the repository variable `TRIAGE_MODEL` names another.
- **Older repos.** The script comes from Winston at a pinned commit. Doctor says which kind
  of triage workflow a repo has; init offers to replace the older agent-based one
  (`claude-code-action` with a tool list), and when Winston's pin is newer it updates only
  the pinned `ref:` line.

The board view is filtered to one milestone, and a new issue has none, so it would reach
the board and never show in that view. init sets `phase` in the config to that milestone
and installs `set-issue-phase.yml`, which gives every new issue the milestone (and, once a
day, any open issue with none). It uses the workflow's own token, needs no secret, never
changes a milestone that is set, and runs from the default branch only. Doctor reports
open issues that have no milestone, and init sets it on them. Moving to the next phase is
one edit: the `phase` line.

A repo that already has a workflow triaging every new issue would get a second one. Doctor
reports it as `triage workflow conflicts`, and init writes nothing until the owner chooses:
`--triage keep` (theirs stays, Winston installs none and records `triage.workflow: false`),
`--triage replace` (Winston's stays, theirs is deleted) or `--triage both` (recorded under
`triage.alongside`, so it is asked once).

Triage takes every rule from the repo's policy file (`triage.policy`, `TRIAGE.md` by
default). When that file is missing or has no triage rules (no heading that names triage,
no `risk:` tier), doctor says so and init offers a starter `TRIAGE.md` to edit and commit;
it never overwrites an existing one.

## Contributing

This repository is itself managed by Winston: its `.winston/config.json` and board are
shared, so a contributor runs `winston init --mode join` (or `/winston:init`) in a clone
to check their access and machine before working on it.

## Updating

Winston says when a newer version is out: a notice at the start of a session (it asks
GitHub at most once a day) and a line in `/winston:doctor`, both with the command to run
for the app Winston was installed in, Claude Code or Codex (doctor shows both when it
cannot tell). It never updates itself, because an update replaces hooks and skills and
needs a restart. In Claude Code:

```
claude plugin marketplace update winston && claude plugin update winston@winston
```

Add `--scope project`, run from the project, for a project-scope install. Then restart
Claude Code. In Codex, run the following, then start a new Codex session:

```
codex plugin marketplace upgrade winston && codex plugin add winston@winston
```

Codex trusts each hook by its position, so an update that adds or moves hooks (as the one
that brought chattr in did) needs one more step: in the new session, open `/hooks` and
trust them once.

`"updateCheck": false` in the config turns the session notice off.

So that a run does not stop on permission prompts, `winston permissions` lists the Claude
Code allow rules Winston runs use in the repo and which the project's
`.claude/settings.json` lacks. The owner runs `winston permissions --apply` once: it adds
the missing rules to `permissions.allow`, and to `permissions.deny` a short list for what
an allow pattern cannot leave out (force pushes, pushes to the production branch, PR
approvals, forced deletions; deny wins over allow). It prints what it added and never
removes or loosens an existing rule. Allow rules never clear deny or ask rules, hooks,
production approval or secret grants.

## Commands

| Command | What it does |
|---|---|
| `/winston` | Orchestrator. No argument: set up a session from the board's Ready column. An argument is an instruction. |
| `/winston plan <draft>` | Turn a draft plan into a settled one, one decision at a time. Never implements. |
| `/winston:triage` | Whole-board triage pass under the repo's own policy (`TRIAGE.md`). |
| `/winston:radar` | What to work on next, batched into the time you have. |
| `/winston:verdict` | Debbie (is it worth doing?) and Sheldon (is it true and well engineered?), together. Called `/winston:consult` before 0.1.15. |
| `/winston:rex` | Session therapist and usage reports, run on Codex. |
| `/winston:closeout` | Can this session end without stranding work? |
| `/winston:handoff` | Hand the work to a fresh session. |
| `/winston:codex`, `/winston:gemini` | Read-only second opinions from other model families. |
| `/winston:doctor` | The setup checklist: each item `done`, `needs you` or `could not check`, with why and how to fix each open one, a line when a newer Winston is out, and one closing **Next step:** line. Changes nothing in the repo or on GitHub. `winston doctor --copy` also puts that step's command on the clipboard when it is a single command (macOS). |
| `/winston:init` | Join, create or adopt the setup. Asks which, shows the plan, applies it only on your yes. `winston init --mode join` (or `new`, or `adopt`) plans one directly; `--yes` applies it. |
| `winston permissions [--apply]` | List, or add to the project's settings, the allow rules Winston runs use. |

Hooks: a production-deploy gate (blocks configured deploy actions until the owner types the
approval phrase in that session), a secret-handling grant, session titles, a starting-branch check (a session opened in the
main checkout on the production branch is moved to the integration branch and
fast-forwarded, when the checkout is clean), worktree setup, a one-line setup reminder at session start, a
browser-tab guard, a once-per-turn Parallelism check nudge in Winston sessions (those
holding chattr's `resource:orchestrator` claim), and chattr's hooks (below).

## chattr: sessions that see each other

chattr is part of Winston. Every Claude Code and Codex session with Winston installed
joins it when it starts, through Winston's hooks, so sessions can see who else works in the
repository, message each other, and claim work so that two sessions never take the same
task. Messages wait in one local SQLite file, `~/.agent-bridge/bridge.db`; nothing leaves
the machine. A message reaches a session at its next turn; an idle session is woken
through Claude Code's own local message socket or `codex queue`, never by typing into a
terminal.

The command is `chattr`. Claude Code puts it on PATH. Codex does not, so each session is
told its full path when it starts. The common commands:

```sh
chattr who --repo --text                 # live sessions in this repository
chattr claim issue:42 "taking the login bug"
chattr state --text                      # peers, broadcasts, unread messages, claims
chattr send <session-id> "rebased staging, re-run your tests"
```

Sessions follow the peer rules in `chattr/docs/AGENT-RULES.md`. Every command, state and
exit code is in `chattr/docs/REFERENCE.md`, wake paths in `chattr/docs/WAKE.md`, and the
contract in `chattr/SPEC.md`.

**Shared-checkout guard.** Two sessions editing one folder can overwrite each other's
work. When another session is live in the same folder, Winston blocks the edit and says to
move into a worktree. It is on for every install. To let one session share a folder, start
it with `CLAUDE_ALLOW_SHARED_CWD=1`. To turn it off for a repository, set
`"sharedCheckoutGuard": false` in `.winston/config.json`. Doctor shows whether it is on.

**Moving from the separate chattr plugin.** chattr used to be its own plugin. If it is
still installed, or its old `install.sh` hooks are in `~/.claude/settings.json` or
`~/.codex/hooks.json`, Winston's copy of the hooks stays off so that nothing runs twice.
Do it in this order: uninstall the separate plugin first (`claude plugin uninstall
chattr@winston`, `codex plugin remove chattr@winston`), then update Winston, restart, and in
Codex trust the new hooks with `/hooks`. The update removes chattr from Winston's
marketplace; if you update first and the uninstall then reports the plugin missing, doctor
shows the line to delete by hand. A repository that installed the plugin for itself
(project scope, or enabled in its own `.claude/settings.json`) keeps the old copy running
in sessions there; doctor lists each such repository, with its worktrees, and the steps.
`/winston:doctor` names what is left and gives the exact removal command for each
(`claude plugin uninstall chattr@winston`, `codex plugin remove chattr@winston`, the old
hooks' `uninstall-hooks`, a `~/.local/bin/chattr` link). Restart every session afterwards.
The store and the `chattr` command are unchanged, so sessions on either install see each
other during the move.

## Configuration

`.winston/config.json` in the repo (committed), over `~/.winston/config.json` (per user).
Top-level keys merge shallowly; the repo wins. See `templates/config.sample.json`.

| Key | Purpose |
|---|---|
| `owner` | Who approves and decides. |
| `branches` | `integration` and `production` branch names. |
| `board` | Projects v2 owner, number, statuses, priority field. `statuses` names the four columns Winston moves cards through (`New`, `Ready`, `Verify`, `Verified` by default); `In Progress` and a `Done` column after the four are expected under those fixed names. On a board Winston creates, GitHub's own closing workflow moves closed items to `Done`; on an existing board that depends on its own workflow settings. |
| `processDocs`, `triage.policy` | The repo docs whose rules win over Winston's. |
| `phase` | The current milestone, given to every new issue. `false` to go without. |
| `triage.workflow`, `triage.alongside` | The triage workflow's file name, or `false` when another workflow is the repo's triage; other triage workflows kept knowingly. |
| `profiles.winston` | A repo-specific profile, read after each skill (one `## /winston:<skill>` section per skill). |
| `advisors` | Repo-specific agent names for Debbie, Sheldon and Radar. |
| `deployGate` | Approval phrase and the guarded actions (`pr-merge` into a base, `workflow-run`). |
| `secretGrant` | The phrase that grants secret handling for one session. |
| `sharedCheckoutGuard` | `false` turns off the block on editing a folder another session is working in. On by default. |
| `permissions.allow` | The repo's own commands, as Claude Code rules (`Bash(npm test*)`), added to what `winston permissions` lists. |
| `updateCheck` | `false` turns off the session-start notice that a newer Winston is out. |
| `startBranch` | `false` leaves the main checkout on whatever branch it is on at session start. |
| `worktree`, `launcher` | Files copied or linked into new worktrees; the repo the launchers open. |

The repo's process docs always win over Winston where they conflict.

## Development

```
npm test
claude plugin validate .
claude --plugin-dir .
```

Installs do not pin to tags. The marketplace installs Winston from `main` (the old tags
stop at `v0.1.2`, and there are no GitHub releases), so the version in
`.claude-plugin/plugin.json` on `main` is the current release, and the update notice
compares against it.

## License

MIT
