---
name: init
description: Set Winston up in this repo - it reads the folder to tell whether this is joining a repo someone already set up for Winston, starting a new project, or adopting an existing repo Winston did not set up, shows a plain-language plan, and applies it only after the user confirms. Use when the user runs /winston:init, installs Winston and asks how to connect it to a repo, or after /winston:doctor reports missing setup the user wants created.
---

# /winston:init

The person running this may not be technical. Winston's default setup is the chosen model:
settle every policy question with its default and say what you chose, and ask only what
the person must decide. Ask only these: the plan confirmation, anything that deletes or
overwrites a file of theirs, production deploys and other gated actions, and secrets
(the person types every token value themselves). Every question goes in a question box
(`AskUserQuestion` in Claude Code, `request_user_input` in Codex, or a plain question in
chat) with a one-line plain explanation and the recommended answer first, marked
(Recommended).

Whenever you give the person a command to type, say where: a `winston` command goes in
this Claude Code chat with `!` in front (`!winston permissions --apply`), because the
plugin's commands are not on a normal Terminal's PATH; `gh`, `claude setup-token` and
`brew` go in the Terminal app. On macOS also put the exact text on the clipboard with
`pbcopy` and say so.

It runs in five steps.

1. **Plan.** Run `winston init` from the project's folder (or the empty folder for a new
   project), with no flags. It reads the folder, picks the setup, says which and why in
   plain words, and prints the plan. It changes nothing.
   - **join** – the repo is already set up for Winston (its `.winston/config.json` is
     committed). Checks this person's access and machine. Changes nothing in the repo or on
     GitHub; gaps in the repo's own setup are reported as the owner's.
   - **new** – a new project. Creates the GitHub repo, the integration and production
     branches, the board, the config, the labels and the triage workflow.
   - **adopt** – an existing repo Winston did not set up. Fits a config to its default
     branch, an integration branch, a board already linked to it and its process docs, and
     adds only what is missing. Nothing existing is renamed or removed.

   Do not ask which setup it is: the plan confirmation in step 3 covers it. Two exceptions:
   - The output starts **This folder doesn't look like a project** (the home folder, a
     standard folder such as Documents, or a folder that holds other projects): relay it
     and stop. Never offer `--mode new` there.
   - The output has a **Check first** block (the project has saved history but no GitHub
     address, so it may be a copy of a project already on GitHub): ask one question box,
     "Is this project already on GitHub?", with **No, make a new GitHub repository
     (Recommended)** and **Yes, connect it to the existing one**. On yes, ask for the
     address and give the `git remote add origin <address>` line to run in the Terminal
     app, then rerun `winston init`.

   If the person names a different setup, run `winston init --mode <join|new|adopt>`.
2. **Show the plan.** First a 3-5 line plain summary in your own words: "Here's what I'll
   set up, and what I'll need from you: ...". Then the plan as printed. If it lists
   several boards instead, ask which one in a question box, with the line marked
   **Recommended** as the first option and its reason, then run the command it gives
   (`--board <owner>/<number>`, or `--board new`). Other choices the person may state:
   `--integration <branch>`, `--owner <name>`, and for a new project `--repo <owner>/<name>`
   and `--public` (the repository is private unless they ask otherwise). The plan's
   settings line says that merging into the release branch will need them to type
   `approve production deploy`: that is the default deploy gate, written into every
   config; mention it in the summary in one plain sentence.
   If the plan has a **Triage workflow, your choice** block, the repo already has a
   workflow that triages every new issue, and Winston's would be a second one. Ask the
   user in a question box, because one answer deletes a file: **replace** it with
   Winston's (Recommended: "Winston's replaces yours, so each issue is triaged once";
   theirs is deleted), **keep** theirs (Winston installs none), or **both** (every new
   issue is triaged twice). Rerun the plan with `--triage <keep|replace|both>` and show it
   again before confirming. A deleted workflow keeps running until the deletion is
   committed to the default branch: offer to commit it with the config.
3. **Confirm, then apply.** Ask the user to confirm in a question box, with the plan's
   actions as the question text. Silence or a general go-ahead given earlier is not
   confirmation. Only after an explicit yes, run the command the plan ends with
   (`To go ahead: winston init --mode <mode> ... --yes`), show its output, then run
   `winston doctor` to confirm the result. A plan with nothing under "Winston will" needs
   no confirmation and no `--yes`.

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
   with `Note:` lines and a **Turn on automatic triage** list, and `winston doctor`
   can report `triage workflow secrets` as `needs you` — all are non-blocking, so don't present
   them as bare facts or errors; say what to do about them, and always offer the next step.
   - **A note to commit the config and workflows:** the files only start working once they
     are saved to the default branch on GitHub. Say that in one plain sentence and make it
     the recommended default: "I'll commit and push these now – OK?" in a question box,
     with yes (Recommended) first. On yes, commit exactly the files the notes name, and
     get them onto the default branch the way the repo's rules allow (a pull request into
     it where pushing to it directly is blocked).
   - **`triage workflow secrets` under Needs you, or the Turn on automatic triage list:**
     this is part of Winston's standard setup, so recommend doing it now (about 5
     minutes): without it, Winston won't triage new issues until asked. "Later" is the
     second option, never a problem. Explain both secrets in plain terms: `GH_PAT`
     is a token over this repo with Issues read/write and Projects read/write on the board
     owner (`GITHUB_TOKEN` cannot reach an org/user project); `CLAUDE_CODE_OAUTH_TOKEN`
     comes from running `claude setup-token`. The numbered steps under **Turn on automatic
     triage** are the walkthrough: the CLI checked which of the two names exist
     (names only), and prints the exact steps for the missing ones. Present those steps
     unaltered. They name the token type, not a guess: a fine-grained token for a board
     an organization owns, a classic token (`repo`, `project`) for a board a user owns,
     because GitHub's fine-grained tokens cannot reach a user's projects. The expiry is
     90 days; doctor reports it when it runs out.
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
     read `done`. Then prove it yourself; this handles no secret. Once the workflow file is
     on the default branch: pick an open issue (`gh issue list --limit 1`), or, with none,
     file one titled "Winston triage test" and say so; run
     `gh workflow run <workflow> -f issue=<number>`; watch `gh run list --workflow
     <workflow> --limit 1` until it completes; report "Automatic triage works" or the
     failure with what to do about it (a failed run: `gh run view <id> --log-failed`,
     usually a mistyped or under-scoped token, so walk them through making it again).
     Close a test issue you filed once the run has triaged it. In **join** the secrets are
     the repo owner's; say so and stop.

**Fewer permission prompts** in the output is one more step for the owner: the project lacks
some of the Claude Code allow rules a Winston run uses, so those actions would prompt
mid-run. Explain it in one line ("lets Winston run everyday git and GitHub commands without
asking you each time, while still blocking risky ones"), then give the one command for
them to type in this chat, `!winston permissions --apply`, and put it on the clipboard.
The rules always go in the project's own settings; never ask which scope. Never run
`--apply` yourself or edit a settings file to grant yourself a permission: Claude is not
allowed to grant itself permissions. It writes only the project's `.claude/settings.json`:
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
and changes nothing. The starter holds the triage behavior, with the config's values filled
in, and Winston's standard risk ratings, which work as they are. After applying, tailor the
ratings yourself: read the repo (what it ships, which paths hold data, sign-in, money or
release machinery), draft the three **Risk tiers** rows naming real paths, and show them as
"Here's how I'll rate risk in this project (you can change this any time in TRIAGE.md)".
Write them into the `TRIAGE.md` init just wrote unless the person objects, and include the
file in the commit offered for the notes. init never overwrites an existing `TRIAGE.md` or
edits the doc the config pointed at; a `TRIAGE.md` that was already there is changed only
on an explicit yes.

A plan line that puts every new issue in the current phase is the **issue phase**. The board view
is filtered to one milestone, and a new issue has none, so without this it reaches the
board and never appears in that view. init sets `phase` in the config to that milestone
and writes `.github/workflows/set-issue-phase.yml`, which sets it on each new issue and
once a day on any open issue with none; it needs no secret and never changes a milestone
that is set. A second line sets the milestone on the open issues that have none now. Say
in plain words that both only take effect once the workflow and the config are committed
to the default branch, and offer to commit them. To move to the next phase the owner
edits that one `phase` line. When the board's views show several milestones, the plan
line names the one Winston picked (due soonest) and says so: relay that, and change
`phase` only if the person says another is current. `"phase": false` means the owner
chose to go without.

Anything under **By hand** needs a person: access someone else grants, or a missing policy
file. Relay it as it stands, with the next action it names.

`winston init` is safe to run again: it shows what is left, skips what is done, and never
overwrites a finished step. When it stops, its message names the cause and the next
action; relay both. `/winston:doctor` is the one checklist of what is open and how to fix
it.

If the `winston` command is not on PATH, run it by its path inside the plugin
(`<plugin root>/bin/winston`, the plugin root being two directories above this skill's
directory). If init fails partway, report what it did and what it did not; do not retry or
repair by hand.
