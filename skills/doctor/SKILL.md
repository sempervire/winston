---
name: doctor
description: Check Winston's setup in this repo and on this machine - config, GitHub board, labels, branches, and which optional tools (Codex, Gemini key, chattr) are on or off. Use when the user runs /winston:doctor, asks whether Winston is set up correctly, or a Winston skill reports a missing prerequisite.
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
- `on` or `off`, for an optional tool. Each optional tool that is off is listed under
  **Optional extras** with who it is for and how to turn it on. Setup is complete without
  them; mention them only if the person asks, or in one line after the setup is complete.

Under **Needs you**, every open item says why it matters and how to fix it. The last line,
**Next step:**, names the first open item, so the user never has to choose. Offer that one
step in plain words, one command at a time, and after they do it run `winston doctor`
again. With nothing open it says setup is complete.

Where a command is typed: `/winston:init` and `!winston ...` go in this Claude Code chat;
`gh`, `claude setup-token` and `brew` go in the Terminal app. Say which every time.

Who does what:

- A fix that reads `/winston:init` is setup init creates. Offer `/winston:init` in one
  line. Do not run it yourself without the person's go-ahead: init writes to GitHub and
  asks for its own confirmation.
- The board's two intake workflows (GitHub has no API for them) are work `/winston:init`
  does through browser control: offer that rather than leaving it with the user.
- **triage workflow secrets** and **triage workflow runs** mean the installed triage
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
  repo, show the draft, and write it unless the person objects.
- **Fewer permission prompts**: one command the owner types in this chat,
  `!winston permissions --apply` (Claude is not allowed to grant itself permissions; deny
  wins over allow). Relay it, never run it yourself.
- **Winston version**: a newer version is out. Give the user the update line as it stands,
  command included: they run it and restart. Do not run the update yourself; it replaces
  the hooks and skills this session is running on.
