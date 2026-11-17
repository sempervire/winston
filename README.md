# Winston

<img src="assets/winston.png" alt="Winston, the fixer: Just do exactly as I say and everything will be just fine." width="720">

Winston keeps a to-do board for your project and has Claude work through it, asking you
only when it must.

In more detail: Winston is a plugin for Claude Code (and Codex). It connects a repository
to a GitHub Projects board, keeps that board triaged, and runs long, unattended engineering
sessions off it: pick the Ready work, clear every human-needed decision up front, build in
parallel worktree lanes, merge one PR at a time, verify, and report.

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
   ```

   Codex plugins cannot ship agents, so then, in a Codex session, ask Codex to run
   `winston install-codex-agents`, which copies them. Codex asks you to trust the plugin's
   hooks once (`/hooks`). So that chattr works inside Codex's sandbox, add its message
   store to `~/.codex/config.toml` (doctor checks this):

   ```toml
   [sandbox_workspace_write]
   writable_roots = ["/Users/<you>/.agent-bridge"]
   ```

2. **Open Claude Code in your project's folder and type `/winston:init`.** (For a
   brand-new project, open it in a new, empty folder.) Winston looks at the folder, says
   which setup it is (joining a project someone already set up, a new project, or an
   existing project Winston has not set up yet; details under [Setup](#setup)), and shows
   its plan. Nothing changes until you say yes. Along the way you will be asked:
   - to confirm the plan, before anything is created;
   - to have Claude in Chrome connected and signed in to GitHub, for two board settings
     GitHub's API cannot change (without it, you get the two steps to click through);
   - to create two GitHub Actions secrets yourself, so new issues are triaged
     automatically. This is recommended (about 5 minutes; init prints every step and
     Claude tests it for you), and you can do it later;
   - to type `!winston permissions --apply` once in the Claude Code chat, so long runs do
     not stop on permission prompts (Claude is not allowed to grant itself permissions).

   If the repo has no triage policy and no `TRIAGE.md`, init writes a starter `TRIAGE.md`
   at the repo root; it never overwrites an existing file. Its standard risk ratings work
   as they are; Claude offers to tailor them to your project, and you can edit them any
   time.

3. **Type `/winston:doctor`.** It is the one place to look afterwards, changes nothing in
   the repo or on GitHub, and is safe to run as often as you like. It prints a checklist
   (`done`, `needs you`, `could not check`, `after setup`, `tip`), says for each open item
   why it matters and how to fix it, lists optional extras with how to turn each on, and
   ends with a single **Next step:** line. A newer Winston shows up there as one more item,
   with the update command. If its last run left items open, the next session in that repo
   starts with one line saying so; a project with no Winston setup gets one line, once,
   pointing at `/winston:init` (`"setupNudge": false` in `~/.winston/config.json` turns
   it off).

`winston` commands work inside Claude Code: in the chat, type them with `!` in front
(`!winston doctor`). The plugin's commands are not on a normal Terminal window's PATH. In
Codex, ask Codex to run `winston ...`, and to use a skill such as `winston:init` by name;
Winston's own output uses the form for the app it runs in.

Then `/winston` starts a session from the board's Ready column. See [Commands](#commands).

## What you need

**Software.** Claude Code (or Codex), [`git`](https://git-scm.com/downloads), the
[GitHub CLI `gh`](https://cli.github.com) (on a Mac: `brew install gh`) signed in with
`gh auth login` and given board access with `gh auth refresh -s project`, and
[Node.js](https://nodejs.org/en/download) 24 or later (Winston's CLI and hooks run on it,
chattr included). Doctor says which of these is missing and how to get it.

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

`/winston:init` runs `winston init`, which reads the folder, picks the setup below, says
which and why in plain words, and plans it before changing anything. It asks about the
setup only where the folder could be read two ways (saved history but no GitHub address:
a new project, or a copy of one already on GitHub). It refuses your home folder and a
folder that holds other projects. `winston init --mode join` (or `new`, or `adopt`)
chooses a different setup; `--yes` applies the plan, with the setup named.

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

Some steps cannot go through GitHub's API, which can delete a project workflow but not
create or enable one: on the board's Workflows page, **Auto-add to project** (this
repository, filter `is:issue`) and **Item added to project** (set Status to `New`). Without
them a new issue never reaches the board. A third is recommended, not required: **Item
closed** (set Status to `Done`), so an issue closed outside a release, completed or not
planned, moves to `Done` instead of staying in its column; doctor shows it as a `tip`.
`/winston:init` does all three through browser
control, so have [Claude in Chrome](https://code.claude.com/docs/en/chrome) ready during
setup: install the extension, sign in to GitHub in that Chrome, and connect it with
`/chrome` (or start with `claude --chrome`). Without browser control it prints the
steps for you to do, and doctor reports them until they are done.

Every config init writes has a deploy gate: merging a pull request into the production
branch waits until you type `approve production deploy` in that session. Where merges do
not deploy it costs nothing; where they do, nothing reaches production without you.
`deployGate` in the config changes the phrase or adds guarded workflows (see
`templates/config.sample.json`).

The triage workflow needs two Actions secrets that only the owner can create:

- `GH_PAT`, a GitHub token that can write the repo's issues and the board. When a person's
  account owns the board (as on most personal projects), it must be a **classic** token
  with the `repo` and `project` scopes: GitHub's fine-grained tokens cannot reach a
  project a person owns. When an organization owns both the board and the repo, a
  fine-grained token works. Those two scopes are enough: the script reaches the board
  through `gh api`, never the `gh project` commands, which also demand `read:org` and
  `read:discussion`.
- `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`, so triage runs on your Claude
  plan. No API key is used.

`winston init` checks which exist, by name only, and prints numbered steps for the missing
ones, with the token type GitHub requires for the board's owner and a link that opens
GitHub's token form already filled in. With Claude in Chrome the session offers to check
the form with you and stops before Generate; the token's value is typed only by you, in
your own terminal. Once you say both are set, Claude runs the workflow on a test issue and
tells you whether automatic triage works. Until both are set new issues are not triaged
automatically; `winston doctor` reports the secrets and whether the workflow's latest runs
failed.

Triage in GitHub Actions is a script, not an agent. For each issue it asks Claude, with
no tools, for one verdict, giving it the repo's triage policy and the issue (it asks once
more only if the first answer is unusable). The script then writes the verdict itself:
the `risk:` tier, Priority, the plan comment, the reporter as assignee (a person, not a
bot), and any other labels the policy allows. When triage cannot decide (say the title and
body contradict), it posts a "Triage stopped" comment with the reason and writes no label,
so the issue stays untriaged until someone answers. Because Claude has no tools in this
step, nothing it needs can be silently refused.

- **When it runs.** On each new issue filed by the owner, a collaborator or an
  organization member. And when you start it by hand from the Actions tab: one issue by
  number, or leave the number empty for a sweep of up to five open issues with no `risk:`
  tier yet (in the board's first two columns, filed by those same people over an hour ago,
  lowest number first, skipping any where triage stopped and is waiting for an answer).
  Nothing runs on a timer. Tick `dry_run` to see the verdict without anything being
  written. An issue that already has a `risk:` tier is left alone; re-triaging is the
  `/winston:triage` pass's job.
- **Which labels.** Every plan gets a `risk:` tier. Any other label must be named on the
  policy's "Labels triage applies" line. The starter `TRIAGE.md` allows `auto-verify` or
  `human-verify` (`auto-verify` only at `risk: low` when an agent can show the change
  works; otherwise `human-verify`), and at most one of `duplicate`, `invalid` or `wontfix`
  when an issue should not be worked. Triage never closes an issue; closing is yours.
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
open issues that have no milestone, and init sets it on them. When the board's views show
several milestones, init picks the one due soonest and says so in its plan. Moving to the
next phase is one edit: the `phase` line.

A repo that already has a workflow triaging every new issue would get a second one. Doctor
reports it as `Two workflows triage new issues`, and init writes nothing until the owner
chooses, because one answer deletes a file: `--triage replace` (recommended: Winston's
stays, theirs is deleted, so each issue is triaged once), `--triage keep` (theirs stays,
Winston installs none and records `triage.workflow: false`) or `--triage both` (recorded
under `triage.alongside`, so it is asked once).

Triage takes every rule from the repo's policy file (`triage.policy`, `TRIAGE.md` by
default). When that file is missing or has no triage rules (no heading that names triage,
no `risk:` tier), doctor says so and init writes a starter `TRIAGE.md`; it never
overwrites an existing one. The starter's risk ratings are a working default; doctor
shows a tip, not a problem, until they are tailored.

So that a run does not stop on permission prompts, `winston permissions` lists the Claude
Code allow rules Winston runs use in the repo and which the project's
`.claude/settings.json` lacks. The owner types `!winston permissions --apply` once in the
Claude Code chat (in Codex, asks Codex to run `winston permissions --apply`): it adds the
missing rules to `permissions.allow`, and to `permissions.deny` a short list for what an
allow pattern cannot leave out (force pushes, pushes to the production branch, PR
approvals, forced deletions; deny wins over allow). It prints what it added and never removes or loosens an existing rule. Allow rules never
clear deny or ask rules, hooks, production approval or secret grants. Because every config
init writes has a deploy gate, the list includes `gh pr merge`: Winston merges pull
requests into the work branch without asking, and a merge into the production branch still
waits for you to type `approve production deploy`.

## Contributing

This repository is itself managed by Winston: its `.winston/config.json` and board are
shared, so a contributor types `/winston:init` in Claude Code in a clone (it sees the
config and joins) to check their access and machine before working on it.

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
| `/winston:doctor` | The setup checklist: each item `done`, `needs you`, `could not check`, `after setup` or `tip`, with why and how to fix each open one, a line when a newer Winston is out, and one closing **Next step:** line. Changes nothing in the repo or on GitHub. `winston doctor --copy` also puts that step's command on the clipboard when it is a single command (macOS). |
| `/winston:init` | Join, create or adopt the setup. Picks the setup from the folder and says which, shows the plan, applies it only on your yes. `winston init --mode join` (or `new`, or `adopt`) plans a different one; `--yes` applies it. |
| `winston permissions [--apply]` | List, or add to the project's settings, the allow rules Winston runs use. |

Hooks: a production-deploy gate (blocks configured deploy actions until the owner types the
approval phrase in that session), a secret-handling grant, session titles, a
starting-branch check (a session opened in the main checkout on the production branch is
moved to the integration branch and fast-forwarded, when the checkout is clean), worktree
setup, a one-line setup reminder at session start, the newer-version notice, a browser-tab
guard, a once-per-turn Parallelism check nudge in Winston sessions (those
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
| `deployGate` | Approval phrase and the guarded actions (`pr-merge` into a base, `workflow-run`). init writes `{ "phrase": "approve production deploy", "guarded": [{ "kind": "pr-merge", "base": <production> }] }`. |
| `secretGrant` | The phrase that grants secret handling for one session. |
| `sharedCheckoutGuard` | `false` turns off the block on editing a folder another session is working in. On by default. |
| `permissions.allow` | The repo's own commands, as Claude Code rules (`Bash(npm test*)`), added to what `winston permissions` lists. |
| `updateCheck` | `false` turns off the session-start notice that a newer Winston is out. |
| `setupNudge` | `false` (user layer) turns off the once-per-project line in a project Winston is not set up in. |
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
