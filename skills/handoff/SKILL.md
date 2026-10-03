---
name: handoff
description: Hand the current work to a fresh session - run the closeout gate, compose a successor prompt carrying the authorization contract, and on macOS with iTerm arm a new Claude tab that starts once this session exits. Use when the user runs /winston:handoff or asks to continue this work in a new session.
---

# /winston:handoff

Hand the current work to a fresh session. The handoff text is the successor's first prompt; do not write it to a file.

## 1. Resolve the handoff

Treat arguments as a natural-language focus. With no arguments, continue the current work. If the intended work is unclear, ask one concise question and recommend the most likely focus.

Use the current session's absolute working directory in every case. A different repository is outside this workflow. For a different focus in the same repository, tell the successor which base ref to branch from and which project naming and claim rules to follow after it starts.

Choose a session name from an issue number or a specific three-to-five-word summary. Use permission mode `auto` unless the user explicitly requests another installed Claude mode. Never use `plan`: planning-only authorization belongs in the prompt and remains binding even when the CLI runs in `auto` mode.

For Claude auto-launch, require macOS, iTerm, `claude`, `uuidgen`, `$CLAUDE_PID`, and `$CLAUDE_CODE_SESSION_ID`. The launcher checks the runtime prerequisites again. On Codex, another operating system, or a missing prerequisite, complete the gate and prompt below, then print the prompt instead of launching anything.

## 2. Run the closeout gate

Load the `/winston:closeout` skill and run it as written. Closeout reports only; it performs no repair.

- `Blocked:` or `Uncertain:` means settle the named items within the authorization already granted, then rerun closeout.
- If an item cannot be settled without new permission, ask for that specific preserving action.
- If it remains unresolved, stop and do not arm a successor.
- Continue only after `No blockers.`

Preserve important work as closeout requires. Do not push unconditionally: the successor inherits this checkout. Push only when preservation requires it and the current task authorization permits it.

Settle or explicitly carry forward unanswered questions, unrecorded decisions, discovered work that has not been filed, and branches that have not been linked. Handoff does not authorize filing, publishing, pushing, or changing external state beyond the permissions already granted.

## 3. Compose the prompt

Reference issues, commits, branches, specs, and durable files instead of copying their contents. Name any skills the successor should load. Redact secrets and personally identifiable information.

Include:

- the focus and the next concrete action;
- completed and outstanding work;
- the current absolute directory, branch, base ref, and relevant issue or PR;
- the predecessor's `$CLAUDE_CODE_SESSION_ID` when Claude provided one;
- project-specific branching and claim instructions needed for a different focus;
- unresolved questions and pending approvals;
- that the session title is already set and should change only when the task genuinely changes;
- the authorization contract below.

### Authorization contract

Record what the user authorized for the unfinished task, its exact scope, explicit restrictions, and pending approvals. Quote the relevant user instruction when practical, and distinguish confirmed authorization from inference.

Authorization belongs to the bounded task and survives the handoff. Approved implementation continues without reapproval solely because the session changed. Planning-only and read-only tasks remain planning-only or read-only, including under CLI permission mode `auto`.

A changed focus does not inherit unrelated permissions. New scope and actions that normally require explicit approval remain gated by the active project's rules. CLI permission mode controls tool prompts; it is not user authorization. Do not claim that cached tool approvals or platform permissions transferred.

## 4. Arm Claude in iTerm

For Claude on supported macOS/iTerm, derive the absolute directory and predecessor pid from the current Bash environment, generate a new UUID with `uuidgen`, and encode the prompt as base64. Feed the prompt through a single-quoted heredoc whose delimiter does not occur in the prompt; do not interpolate or evaluate the prompt. The launcher decodes it into one quoted argument, and command substitution deliberately strips trailing newlines.

Run the launcher by its absolute path, where `<skill-dir>` is this skill's base directory (the folder holding this SKILL.md):

```sh
<skill-dir>/scripts/launch-iterm.sh --open-tab \
  --wait-pid "$CLAUDE_PID" \
  --dir "$absolute_directory" \
  --name "$session_name" \
  --mode "$permission_mode" \
  --session-id "$successor_uuid" \
  --prompt-b64 "$prompt_b64"
```

The launcher passes values to AppleScript as positional arguments. AppleScript applies `quoted form of` to every argument and types exactly one command into the new tab. Decoded prompt content is never shell code.

The new tab checks the target directory, installed CLI and requested mode, the predecessor pid, and its recorded `ps -o lstart= -p` start time. It prints an `Armed` line, waits until that pid disappears or its start time changes, and gives up after four hours by default. Only then does it start:

```sh
claude --session-id "$successor_uuid" --name "$session_name" --permission-mode "$permission_mode" "$decoded_prompt"
```

The wait prevents predecessor and successor overlap in this directory. Never set or inherit `CLAUDE_ALLOW_SHARED_CWD`. A third session is still governed by the existing shared-directory guard.

After the tab opens, release this session's relevant chattr claims (where chattr is installed) with `handed to <successor_uuid>` as the note. The successor claims normally when it starts; there is no claim transfer. Automatic `owner_gone` reconciliation remains a fallback.

If `osascript` succeeds, report exactly:

> `Tab opened for <name> — check it shows "Armed", then exit this session.`

The user exits manually. Do no further task work, do not poll for the successor, and do not report that it started.

If the environment is unsupported or preflight fails, print the full handoff prompt in chat. If `osascript` fails, report the error and print the full prompt; do not open a second tab automatically. A failure inside the tab prints its reason and decoded prompt there, including a dead predecessor, failed directory change, unavailable mode, timeout, or Claude start failure.

## 5. Codex behavior

Codex keeps the closeout gate, preservation rules, prompt contents, and authorization contract. It does not auto-launch Claude or another Codex session. Print the full handoff prompt for the user.
