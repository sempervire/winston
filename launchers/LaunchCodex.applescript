-- Opens an iTerm tab (or window) with the "codex" profile and starts a new Codex
-- session in its own worktree. The launcher is read from the Winston
-- marketplace checkout, which keeps one path across plugin versions;
-- WINSTON_ROOT overrides it.
set launchCommand to "exec \"${WINSTON_ROOT:-$HOME/.claude/plugins/marketplaces/winston}/launchers/launch-session.sh\" codex"

set itermWasRunning to application "iTerm" is running

tell application "iTerm"
	activate
	if itermWasRunning and (count of windows) > 0 then
		tell current window
			create tab with profile "codex"
			tell current session to write text launchCommand
		end tell
	else
		set newWindow to (create window with profile "codex")
		tell current session of newWindow to write text launchCommand
	end if
end tell
