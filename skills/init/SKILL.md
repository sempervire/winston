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
3. **Confirm, then apply.** Ask the user to confirm in a question box, with the plan's
   actions as the question text. Silence or a general go-ahead given earlier is not
   confirmation. Only after an explicit yes, rerun the same command with `--yes`, show its
   output unaltered, then run `winston doctor` to confirm the result. A plan with nothing
   under "would" needs no confirmation and no `--yes`.

4. **Do the browser steps.** The output's **In the browser** list is the board's two intake
   workflows, "Auto-add to project" and "Item added to project". Without them a new issue
   never reaches the board at its intake status. GitHub's API cannot create, edit or enable
   a project workflow, so they are done on the board's Workflows page. They are part of
   the setup, not an afterthought: say so in the plan you confirm in step 3, and do not
   call the setup finished while `winston doctor` still lists them. In **join** they are
   the owner's; relay them and stop.
   - **With browser control** (Claude Code with Claude in Chrome: the
     `mcp__claude-in-chrome__*` tools): do them yourself, in a new tab, exactly as each
     line says. Open the `/workflows` address given. For "Item added to project": select
     it, **Edit**, under **Set value** choose the Status named, **Save and turn on
     workflow**. For "Auto-add to project": select it, **Edit**, pick this repository,
     replace the filter with `is:issue`, **Save and turn on workflow**. Touch nothing else
     on the page, close the tab, then run `winston doctor` and show that both checks pass.
     With chattr, claim `resource:chrome` first and release it after.
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
   - **A note to commit the config and workflow:** it names the exact files and the reason
     (GitHub runs the triage workflow from the default branch only). Relay that reason, and
     offer to commit those two files yourself now (`git add` and `git commit` them) rather
     than leaving the user to work out why they're uncommitted.
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
        credential: it stays with the owner. With chattr, claim `resource:chrome` first
        and release it after.
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

Anything under **By hand** needs a person: access someone else grants, or a missing policy
file. Relay it as it stands.

`winston init` is safe to run again: it shows what is left, skips what is done, and never
overwrites a finished step. Whenever it stops on something missing, point the user at
`/winston:doctor`, the one checklist of what is open and how to fix it.

If the `winston` command is not on PATH, run it by its path inside the plugin
(`<plugin root>/bin/winston`, the plugin root being two directories above this skill's
directory). If init fails partway, report what it did and what it did not; do not retry or
repair by hand.
