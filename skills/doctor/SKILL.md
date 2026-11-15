---
name: doctor
description: Check Winston's setup in this repo and on this machine - config, GitHub board, labels, branches, Node, chattr's leftovers from a separate install, the shared-checkout guard, and which optional tools (Codex, Gemini key) are on or off. Use when the user runs /winston:doctor, asks whether Winston is set up correctly, or a Winston skill reports a missing prerequisite.
---

# /winston:doctor

Run `winston doctor --copy` from the repository root and show its output unaltered. It is
read-only and safe to run again at any time. `--copy` puts the next step's command on the
clipboard (macOS); when it did, say so in one line.

If the `winston` command is not on PATH, say so in one line: the plugin's `bin/` is not on
this harness's PATH, so run it by its path inside the plugin (`<plugin root>/bin/winston
doctor --copy`, the plugin root being two directories above this skill's directory).

The person reading may not be technical. Every line you add says what to do, in plain
words; never leave a status or a warning without the next action.

The output is a checklist. Each line starts with a plain status:

- `done`
- `needs you`
- `could not check`: this account or network cannot see it. That is not the same as
  missing; never report it as missing. Its detail says what to look at.
- `after setup`: it follows from the setup `/winston:init` does. Nothing to do for it now.
- `tip`: nothing is wrong; an optional improvement, listed under **Tips**.
- `on` or `off`, for an optional tool or a switch (the shared-checkout guard). Each optional tool that is off is listed under
  **Optional extras** with who it is for and how to turn it on. Setup is complete without
  them; mention them only if the person asks, or in one line after the setup is complete.

Under **Needs you**, every open item says why it matters and how to fix it. The last line,
**Next step:**, names the first open item, so the user never has to choose. Offer that one
step in plain words, one command at a time, and after they do it run `winston doctor`
again. With nothing open it says setup is complete.

Where a command is typed: in Claude Code, `/winston:init` and `!winston ...` go in the
chat; in Codex, the person asks Codex to use the `winston:init` skill or to run
`winston ...` (doctor's output says so at the top when it runs outside Claude Code);
`gh`, `claude setup-token` and `brew` go in the Terminal app. Say which every time.

Who does what:

- A fix that reads `/winston:init` is setup init creates. Offer `/winston:init` in one
  line. Do not run it yourself without the person's go-ahead: init writes to GitHub and
  asks for its own confirmation.
- The board's two intake workflows (GitHub has no API for them) are work `/winston:init`
  does through browser control: offer that rather than leaving it with the user.
- **Automatic triage keys** and **Automatic triage is working** mean the installed triage
  workflow is not triaging. Say so plainly, since nothing else reports it, recommend
  fixing it now (about 5 minutes), and relay the numbered steps; the first is a link that
  opens GitHub's token form filled in. By
  default the owner opens it themselves and you explain the fields. Whenever you have
  browser tools, offer in one plain line, right after giving the link, to open the page
  and fill in the fields for them, stopping before Generate; proceed only on their yes,
  as `/winston:init` step 5 describes. If they say no or do not answer, they open it
  themselves; if the harness or a hook stops you from opening the page, that is the stop,
  and you do not ask for a grant phrase. Never click Generate. Once the fields are filled,
  say so, and take no further browser action in that tab or window – no screenshot, no
  page read, no navigation, no close – until the owner says in chat that the token is
  copied and the tab is closed (or tells you to close it after they have navigated away).
  The owner types the token into `gh secret set` in their own terminal; never run
  `gh secret set` yourself. A token is a credential and stays with the owner. When they
  say both are set, run the proof yourself as `/winston:init` step 5 describes.
- **Triage rules**: the policy file is absent or has no triage rules, so a triage run
  changes nothing; `/winston:init` adds a `TRIAGE.md` starter. **Triage rules: blanks to
  fill**: lines that still say "fill this in". **Risk ratings for this project** (a tip):
  the starter's standard ratings work as they are; offer to tailor them from reading the
  repo and show the draft. By now `TRIAGE.md` may be committed or edited, so write the
  draft only on the person's explicit yes in a question box (yes recommended).
- **Fewer permission prompts**: one command the owner types in this chat,
  `!winston permissions --apply` (in Codex: ask Codex to run `winston permissions --apply`; Claude is not allowed to grant itself permissions; deny
  wins over allow). Relay it, never run it yourself.
- **separate chattr plugin**, **old chattr install.sh hooks**, **stray chattr command**:
  chattr is part of Winston, and these are what is left of a separate install. While the
  plugin or the old hooks are there, Winston's own copy of chattr's hooks stays off so
  nothing runs twice. Relay the fix lines as they stand; the owner runs them in the Terminal
  app and restarts every Claude Code and Codex session. Do not run them yourself: the
  current session may depend on the separate copy until it restarts.
- **Codex can write the chattr store**: give the owner the two `config.toml` lines and say
  where the file is (`~/.codex/config.toml`); they add them, since editing the Codex config
  is theirs to do. Without them, claims and peer messages fail inside Codex.
- **shared-checkout guard** is `on` by default: it blocks an edit while another session
  works in the same folder. If the owner wants it off for a repo, the line is
  `"sharedCheckoutGuard": false` in `.winston/config.json`; say what they lose first.
- **Node.js version**: every hook runs on the `node` on PATH, and Winston needs 24 or later;
  relay the doctor's install line (https://nodejs.org/en/download, or `brew install node`
  in the Terminal app).
- **Winston version**: a newer version is out. Give the user the update line as it stands,
  command included: they run it and restart. Do not run the update yourself; it replaces
  the hooks and skills this session is running on.

**Closing report: no item without an action.** Doctor is read-only and performs no fix:
the only thing it does itself is rerun `winston doctor`. Each item is (a) already done (doctor says `done`), or (b) a concrete command, which, when it is one for the user to paste, is also put on the
clipboard with `pbcopy` (macOS) with the report saying so, or (c) a pointer to the skill that
does the fix ("/winston:init does this") as a question-box choice with the recommended option first. Never end on a bare statement such as "tell me if you want X".
