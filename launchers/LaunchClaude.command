#!/bin/bash
# Double-clickable launcher: asks for an iTerm session name, then starts a new
# Claude session in its own worktree (launch-session.sh).

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

read -r -p "Session name (blank = auto): " name

# Set the iTerm session name, not an OSC title: with a profile showing Session
# Name only, a terminal-set title is never displayed. Fails open when not
# launched inside iTerm.
if [ -n "$name" ]; then
    "$here/iterm-session-name.sh" "$name" || true
fi

exec "$here/launch-session.sh" claude
