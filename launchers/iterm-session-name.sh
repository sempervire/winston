#!/bin/bash
# Set the title of the iTerm2 session this process is running under.
#
# Usable from inside an agent (Claude Code, Codex): the agent's Bash subprocess
# has no controlling terminal - `tty` reports "not a tty" and /dev/tty is
# "device not configured" - so OSC title escapes can never reach the tab; the
# harness captures them as tool output. iTerm's AppleScript interface addresses
# the session by id instead, and ITERM_SESSION_ID is inherited all the way down
# from the launching shell.
#
# This sets the iTerm session name and nothing else. It deliberately does NOT
# also record state for Claude's native session-title hook: that hook can only
# publish on the NEXT user prompt, so welding the two together would give one
# command two pipelines with two different latencies and two failure modes.
# Claude's native title is driven separately.
#
# For the name to be what the tab shows, the profile's title must be set to
# Session Name only (Preferences -> Profiles -> Session -> Title). With the Job
# Name component enabled the tab shows the foreground process instead.
#
#   iterm-session-name.sh "Fix the login redirect"
#   iterm-session-name.sh            # clears it, profile default returns

set -u

# The iTerm session id identifies the whole iTerm session, not a tmux pane, so
# several agents multiplexed into one session would silently overwrite each
# other's title. Refuse rather than rename the wrong thing.
if [ -n "${TMUX:-}" ]; then
    printf 'iterm-session-name: running under tmux; the iTerm session is shared between panes, so a per-pane title is not possible. Not renaming.\n' >&2
    exit 1
fi

if [ -z "${ITERM_SESSION_ID:-}" ]; then
    printf 'iterm-session-name: not running under iTerm2; nothing to do\n' >&2
    exit 0
fi

uuid="${ITERM_SESSION_ID##*:}"

# Whitespace collapses FIRST, before control characters are stripped. A newline
# or tab is itself a control character, so stripping first would delete it
# outright and weld the surrounding words together ("Fix\tthis" -> "Fixthis").
# A newline surviving into the AppleScript below would also break the string
# literal and leave a malformed statement, not just an ugly title.
title=$(printf '%s' "${*:-}" | tr '\n\r\t' '   ' | tr -s ' ' | sed 's/^ //; s/ $//')
title=$(printf '%s' "$title" | tr -d '\000-\037\177')

# iTerm's own cap, so a pathological title cannot be used to build a long
# AppleScript statement.
if [ ${#title} -gt 200 ]; then
    title="${title:0:200}"
fi

# AppleScript string literals take backslash and double-quote escapes only.
escaped=${title//\\/\\\\}
escaped=${escaped//\"/\\\"}

result=$(osascript <<APPLESCRIPT
tell application "iTerm"
	repeat with w in windows
		repeat with t in tabs of w
			repeat with s in sessions of t
				if (id of s) is "$uuid" then
					set name of s to "$escaped"
					return "ok"
				end if
			end repeat
		end repeat
	end repeat
	return "not found"
end tell
APPLESCRIPT
) || exit 1

if [ "$result" != "ok" ]; then
    printf 'iterm-session-name: session %s not found in iTerm\n' "$uuid" >&2
    exit 1
fi
