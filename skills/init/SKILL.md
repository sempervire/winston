---
name: init
description: Set Winston up in this repo, after asking which of three situations it is - joining a repo someone already set up for Winston, starting a new project from scratch, or adopting an existing repo Winston did not set up - then showing the plan and applying it only after the user confirms. Use when the user runs /winston:init, installs Winston and asks how to connect it to a repo, or after /winston:doctor reports missing setup the user wants created.
---

# /winston:init

`winston init` sets up one of three things, and which one is the user's call, never a guess.
It runs in five steps and never skips the first two.

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
   If the plan has a **Triage workflow, your choice** block, the repo already has a
   workflow that triages every new issue, and Winston's would be a second one. Ask the
   user in a question box, in plain words, with the block's three lines as the options:
   **keep** theirs (Winston installs none), **replace** it with Winston's (theirs is
   deleted), or **both** (every new issue is triaged twice). Never pick for them. Rerun
   the plan with `--triage <keep|replace|both>` and show it again before confirming. A
   deleted workflow keeps running until the deletion is committed to the default branch:
   offer to commit it with the config.
3. **Confirm, then apply.** Ask the user to confirm in a question box, with the plan's
   actions as the question text. Silence or a general go-ahead given earlier is not
   confirmation. Only after an explicit yes, rerun the same command with `--yes`, show its
   output unaltered, then run `winston doctor` to confirm the result. A plan with nothing
   under "would" needs no confirmation and no `--yes`.

4. **Do the browser steps.** The output's **In the browser** list is the board's two intake
   workflows, "Auto-add to project" and "Item added to project", and, ahead of them when
   another project is capturing this repo's issues, a line naming that project. Without the
   two workflows a new issue never reaches the board at its intake status, and while the
   other project keeps its Auto-add on, each new issue also lands on it. GitHub's API cannot create, edit or enable
   a project workflow, so they are done on the board's Workflows page. They are part of
   the setup, not an afterthought: say so in the plan you confirm in step 3, and do not
   call the setup finished while `winston doctor` still lists them. In **join** they are
   the owner's; relay them and stop.
   - **With browser control** (Claude Code with Claude in Chrome: the
     `mcp__claude-in-chrome__*` tools): do them yourself, in a new tab, exactly as each
     line says, in the order listed. Open the `/workflows` address given. For the other
     project's line ("project N auto-adds this repo's issues"): open that project's
     `/workflows` page, select **Auto-add to project**, **Edit**, remove this repository
     from it (or, if this repository is the only one it adds from, turn the workflow off),
     **Save**. Touch no other project setting, and never delete the project. For "Item added to project": select
     it, **Edit**, under **Set value** choose the Status named, **Save and turn on
     workflow**. For "Auto-add to project": select it, **Edit**, pick this repository,
     replace the filter with `is:issue`, **Save and turn on workflow**. Touch nothing else
     on the page, close the tab, then run `winston doctor` and show that these checks pass (the other-project line clears once its Auto-add no longer takes new issues, and can read as present until one more issue is filed).
     Claim `resource:chrome` first (`chattr claim resource:chrome`) and release it after.
   - **The page shows GitHub's 404 or a Sign in link:** that Chrome is not signed in to
     GitHub, or is signed in as an account without access to the board. Ask the user to
     sign in to GitHub in that Chrome window as the board's owner and tell you when done.
     Never type credentials yourself.
   - **No browser control in this session:** tell the user how to turn it on, then wait:
     install the Claude in Chrome extension in Chrome, sign in to GitHub there, and
     connect it to this session with `/chrome` (or start Claude Code with
     `claude --chrome`). When they say it is on, carry out the steps. If they would
     rather not, or the harness has no browser control (Codex), give them the two lines
     from the output to do by hand, and run `winston doctor` once they say they have.

5. **Carry the plan's notes through as help, not status.** `winston init`'s output can end
   with `Note:` lines and a **Secrets the triage workflow needs** list, and `winston doctor`
   can report `triage workflow secrets` as `needs you` — all are non-blocking, so don't present
   them as bare facts or errors; say what to do about them, and always offer the next step.
   - **A note that no deploy gate is set:** ask once in a question box whether merges into
     the production branch deploy, "No, nothing deploys" recommended when the repo has no
     deploy workflow; on yes, add `deployGate` to the config as the README shows.
   - **A note to commit the config and workflow:** it names the exact files and the reason
     (GitHub runs the triage workflow from the default branch only). Relay that reason, and
     ask in a question box (recommended: commit them now): on yes, commit those two files on
     a new branch from the default branch, push it and open a pull request into it, using
     the note's command; merging that PR follows the merge rule in the closing report below.
   - **`triage workflow secrets` under Needs you, or the Secrets list:** the workflow skips cleanly
     without them, so frame this as an optional next step, not a problem; until it is done,
     new issues are not triaged automatically. Explain both secrets in plain terms: `GH_PAT`
     is a token over this repo with Issues read/write and Projects read/write on the board
     owner (`GITHUB_TOKEN` cannot reach an org/user project); `CLAUDE_CODE_OAUTH_TOKEN`
     comes from running `claude setup-token`. The numbered steps under **Secrets the triage
     workflow needs** are the walkthrough: the CLI checked which of the two names exist
     (names only), and prints the exact steps for the missing ones. Present those steps
     unaltered. They name the token type, not a guess: a fine-grained token for a board
     an organization owns, a classic token (`repo`, `project`) for a board a user owns,
     because GitHub's fine-grained tokens cannot reach a user's projects.
   - **Help create the token, as far as possible.** The first step is a link that opens
     GitHub's token form with the fields filled in (scopes for a classic token; name,
     resource owner, expiration and the two permissions for a fine-grained one). In order
     of preference:
     1. **The owner opens the link themselves**, in their own signed-in browser. You
        explain each field from the numbered steps, including what the link cannot fill
        (the Note on a classic token; "Only select repositories" and this repository on a
        fine-grained one), and answer questions as they go. This is the default, and what
        happens if they say no to the offer below or do not answer it.
     2. **Whenever you have browser tools** (Claude in Chrome), **offer the help** in one
        plain line right after giving the link, for example: "I can also open this page in
        your browser and fill in the fields for you, stopping before Generate – want me
        to?" Proceed only on the owner's yes. Then open that link in a new tab in their
        signed-in browser, check each field against the steps, and fill in what the link
        could not. Never click Generate, and never type a password
        or a two-factor code. Once the fields are filled, say so, and take **no further
        browser action in that tab or window** – no screenshot, no page read, no
        navigation, no close – until the owner says in chat that the token is copied and
        the tab is closed (or tells you to close it after they have navigated away). The
        owner clicks Generate and answers any password or two-factor prompt; GitHub then
        shows the token in that same tab, which is why you do not look. A token is a
        credential: it stays with the owner. Claim `resource:chrome` first and release
        it after.
     - **If the harness or a hook stops you from opening that page, that is the stop.**
       Do not ask the owner to type a grant phrase for this. Go back to 1: the owner
       opens the link, and you give the numbered directions.
     - **The page shows a sign-in form, or the form does not match the steps:** say so
       and go back to 1 with the numbered directions; never sign in for them.
     - **No browser control:** give them the link and the numbered directions, which
       name every field and value, and wait.
   - **The token's value stays with the owner.** They run `claude setup-token` and the two
     `gh secret set` lines in their own terminal, where `gh secret set` prompts for the
     value. For `claude setup-token`, explain what each prompt is for (it opens a browser
     to sign in to Claude, they approve, it prints a long-lived token to copy); do not run
     it. Never create a token, never ask for a token's value in chat, and never run
     `gh secret set` yourself; the owner runs it in their own terminal. The owner doing it
     by hand needs no secret-grant phrase (config `secretGrant.phrase`); that phrase
     governs an agent handling secrets, and here no agent does.
   - **When they say it is done,** run `winston doctor`: `triage workflow secrets` should
     read `done`, and after the proving run in the steps `triage workflow runs` should show
     `last run: success`. In **join** the secrets are the repo owner's; say so and stop.

**Permission rules** in the output is one more step for the owner: the project lacks some
of the Claude Code allow rules a Winston run uses, so those actions would prompt mid-run.
Relay its one command, `winston permissions --apply`, for the owner to run themselves (in
their terminal, or with the `!` prefix). Never run `--apply` yourself or edit a settings
file to grant yourself a permission. It writes only the project's `.claude/settings.json`:
the allow rules, and a short deny list for what an allow pattern cannot leave out (force
pushes including `--force-with-lease`, pushes to the production branch, PR approvals,
forced deletions; so a pushed branch is updated by merging its base, not by rebasing). Deny wins over
allow, and an allow rule never clears a deny or ask rule, a hook, production approval or a
secret grant.

**Values to fill in** lists lines of the new `TRIAGE.md` that say "fill this in", where
the config had no value (an owner, a branch, a board number). They are the owner's to
write; relay the lines.

A plan line that writes `TRIAGE.md` means the repo's triage policy (config `triage.policy`)
is missing or holds no triage rules: no heading that names triage and no `risk:` tier. The
triage skill takes every rule from that file, so without them a triage run finishes clean
and changes nothing. The starter holds the triage behavior, with the config's values filled in, and
three sections marked **(per-repo)** that are generic. Say plainly that the **Risk tiers**
section must be written for this repo before triage can judge anything: its rows are an
example. After applying, offer to propose tiers: read the repo (what it ships, which paths
hold data, auth, money or release machinery), draft the three rows naming real paths, and
show them to the user; write them into `TRIAGE.md` only after an explicit yes. Then tell
the user to review the file and commit it to the default branch, where the workflow reads
it. init never overwrites an existing `TRIAGE.md` or edits the doc the config pointed at.

A plan line that gives every new issue a milestone is the **issue phase**. The board view
is filtered to one milestone, and a new issue has none, so without this it reaches the
board and never appears in that view. init sets `phase` in the config to that milestone
and writes `.github/workflows/set-issue-phase.yml`, which sets it on each new issue and
once a day on any open issue with none; it needs no secret and never changes a milestone
that is set. A second line sets the milestone on the open issues that have none now. Say
in plain words that both only take effect once the workflow and the config are committed
to the default branch, and ask in a question box (recommended: commit them now). To move to the next phase the owner
edits that one `phase` line. If doctor says the board's views filter to several
milestones, ask the user which is the current one in a question box, write it as `phase`
in `.winston/config.json` after their answer, and rerun the plan. `"phase": false` means
the owner chose to go without.

Anything under **By hand** needs a person: access someone else grants, or a missing policy
file. Do not relay it as a bare statement: say who must do it, then give the exact next
action (the link to open and the fields to fill, or the command), and for a missing policy
file offer to write the starter in a question box.

**Closing report: no item without an action.** These actions are yours to take as the agent running this skill (the `winston` command only prints the plan). This covers step 5 and every "Left for
you", "Note:" and "By hand" item. Each pending item at the end of the run is one of: (a)
already done; (b) a concrete command, which, when it is one for the user to paste, is also
put on the clipboard with `pbcopy` (macOS) with the report saying so; or (c) a question-box
choice with the recommended option first. Anything init is authorized to do itself is
simply done, not offered. Never end a line with "tell me if you want", "say if", or a
status the user must turn into a decision. In particular:

- **Setup PR.** init reviews a setup PR it opened (the review posted on the PR) and merges
  it only when all of these hold: the owner has given merge authority explicitly (a
  standing policy in the user's own instructions that names this repo, or this session's
  approval; write access alone is not authority), every existing check passes, and the
  merge needs no bypass. Never use `gh pr merge --admin` or any other bypass of branch
  protection or required reviews.
- **A merge into the production branch is a production deploy** wherever merges there
  deploy (`deployGate` configured, or the deploy-gate question above answered yes). Then
  init does not merge on its own authority: it uses the deploy gate's approval phrase when
  the owner has given it, and otherwise asks once in a question box. Never merge silently.
- **When init may not merge,** ask once in a question box with "Review and merge it" first,
  or give the plain command `gh pr merge <n> --merge`, which is also put on the clipboard.
- **A `processDocs` entry** in `.winston/config.json` that names a file that does not exist:
  if the file is absent from the repo and from the default branch's history (`git log
  --all -- <path>` is empty), init removes that one entry and says which. If the file
  existed once or the name looks intended, ask once in a question box with "Remove the
  entry" recommended. The config edit goes into the same setup commit or PR as the rest,
  never straight onto the default branch.

`winston init` is safe to run again: it shows what is left, skips what is done, and never
overwrites a finished step. Whenever it stops on something missing, point the user at
`/winston:doctor`, the one checklist of what is open and how to fix it.

If the `winston` command is not on PATH, run it by its path inside the plugin
(`<plugin root>/bin/winston`, the plugin root being two directories above this skill's
directory). If init fails partway, report what it did and what it did not; do not retry or
repair by hand.
