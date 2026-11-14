---
name: doctor
description: Check Winston's setup in this repo and on this machine - config, GitHub board, labels, branches, and which optional tools (Codex, Gemini key, chattr) are on or off. Use when the user runs /winston:doctor, asks whether Winston is set up correctly, or a Winston skill reports a missing prerequisite.
---

# /winston:doctor

Run `winston doctor` from the repository root and show its output unaltered. It is read-only
and safe to run again at any time.

If the `winston` command is not on PATH, say so in one line: the plugin's `bin/` is not on
this harness's PATH, so run it by its path inside the plugin (`<plugin root>/bin/winston
doctor`, the plugin root being two directories above this skill's directory).

The output is a checklist. Each line starts with a plain status:

- `done`
- `needs you`
- `could not check`: this account or network cannot see it. That is not the same as
  missing; never report it as missing.
- `on` or `off`, for an optional tool.

Under **Needs you**, every open item says why it matters and how to fix it. The last line,
**Next step:**, names the first open item, so the user never has to choose. Offer that one
step in plain words, one command at a time, and after they do it run `winston doctor`
again. With nothing open it says setup is complete. `winston doctor --copy` also puts the
next step's command on the clipboard (macOS); use it only when the user asks for that.

Who does what:

- A fix that reads `winston init --mode adopt` is setup `/winston:init` creates. Offer
  `/winston:init` in one line. Do not run it: init asks which setup fits, writes to GitHub
  and needs its own confirmation.
- The board's two intake workflows (GitHub has no API for them) are work `/winston:init`
  does through browser control: offer that rather than leaving it with the user.
- **triage workflow secrets** and **triage workflow runs** mean the installed triage
  workflow is not triaging. Say so plainly, since nothing else reports it, and relay the
  numbered steps; the first is a link that opens GitHub's token form filled in. With
  browser control, offer to open it and check or fill the fields with the user, stopping
  before the Generate button, as `/winston:init` step 5 describes. The owner clicks
  Generate and types the token into `gh secret set` in their own terminal. Never click
  Generate, read the page once a token is shown, or handle a token's value: it is a
  credential and stays with the owner.
- **triage policy**: the policy file is absent or has no triage rules, so a triage run
  changes nothing; `/winston:init` offers a `TRIAGE.md` starter. **triage policy blanks**:
  lines that still say "fill this in". **triage risk tiers**: the starter's example tiers
  have not been rewritten for this repo; offer to propose tiers from reading the repo, and
  write them only after the user approves.
- **project permission rules**: one command the owner runs, `winston permissions --apply`
  (deny wins over allow). Relay it, never run it yourself.
- **Winston version**: a newer version is out. Give the user the update line as it stands,
  command included: they run it and restart. Do not run the update yourself; it replaces
  the hooks and skills this session is running on.
