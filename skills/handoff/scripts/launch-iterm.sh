#!/bin/sh
set -eu

open_tab=false
wait_pid=
target_dir=
session_name=
permission_mode=auto
session_id=
claude_path=
prompt_b64=
prompt_file=
max_wait_seconds=14400

usage() {
  printf '%s\n' 'usage: launch-iterm.sh [--open-tab] --wait-pid PID --dir DIR --name NAME --mode MODE (--prompt-b64 BASE64 | --prompt-file FILE) [--session-id UUID] [--max-wait-seconds SECONDS]' >&2
  exit 2
}

while test "$#" -gt 0; do
  case $1 in
    --open-tab)
      open_tab=true
      shift
      ;;
    --wait-pid|--dir|--name|--mode|--prompt-b64|--prompt-file|--session-id|--claude-path|--max-wait-seconds)
      test "$#" -ge 2 || usage
      option=$1
      value=$2
      shift 2
      case $option in
        --wait-pid) wait_pid=$value ;;
        --dir) target_dir=$value ;;
        --name) session_name=$value ;;
        --mode) permission_mode=$value ;;
        --prompt-b64) prompt_b64=$value ;;
        --prompt-file) prompt_file=$value ;;
        --session-id) session_id=$value ;;
        --claude-path) claude_path=$value ;;
        --max-wait-seconds) max_wait_seconds=$value ;;
      esac
      ;;
    *) usage ;;
  esac
done

if test -n "$prompt_b64" && test -n "$prompt_file"; then
  usage
fi
if test -z "$prompt_b64" && test -z "$prompt_file"; then
  usage
fi

if test -n "$prompt_file"; then
  if ! test -f "$prompt_file"; then
    printf '%s\n' 'Handoff failed: the prompt file is missing.' >&2
    exit 1
  fi
  if ! prompt=$(cat "$prompt_file"); then
    printf '%s\n' 'Handoff failed: the prompt file could not be read.' >&2
    exit 1
  fi
  rm -f "$prompt_file"
else
  if ! prompt=$(printf '%s' "$prompt_b64" | base64 -d 2>/dev/null); then
    printf '%s\n' 'Handoff failed: the prompt was not valid base64.' >&2
    exit 1
  fi
fi

fail() {
  printf 'Handoff failed: %s\n\n%s\n' "$1" "$prompt" >&2
  exit 1
}

case $wait_pid in
  ''|*[!0-9]*) fail 'the predecessor pid must be a positive integer.' ;;
esac
test "$wait_pid" -gt 0 || fail 'the predecessor pid must be a positive integer.'
test -n "$target_dir" || fail 'the target directory is empty.'
test -n "$session_name" || fail 'the session name is empty.'
case $max_wait_seconds in
  ''|*[!0-9]*) fail 'the maximum wait must be a positive integer.' ;;
esac
test "$max_wait_seconds" -gt 0 || fail 'the maximum wait must be a positive integer.'

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || fail 'the launcher path could not be resolved.'
script_path="$script_dir/launch-iterm.sh"

if test -z "$claude_path"; then
  command -v claude >/dev/null 2>&1 || fail 'claude is not available on PATH.'
  claude_path=$(command -v claude)
fi
test -x "$claude_path" || fail "claude is not executable: $claude_path"
if test "$permission_mode" = plan; then
  fail 'permission mode plan cannot run an unattended handoff.'
fi
if ! claude_help=$("$claude_path" --help 2>&1); then
  fail 'the installed claude CLI could not report its permission modes.'
fi
# The help text wraps the choices list onto continuation lines; join lines before matching.
if ! printf '%s\n' "$claude_help" | tr -s '\n ' '  ' | sed -n 's/.*--permission-mode[^(]*(choices: \([^)]*\)).*/\1/p' | grep -F "\"$permission_mode\"" >/dev/null; then
  fail "permission mode $permission_mode is unavailable in the installed claude CLI."
fi
if ! cd -- "$target_dir"; then
  fail "the target directory is unavailable: $target_dir"
fi
if ! predecessor_start=$(ps -o lstart= -p "$wait_pid" 2>/dev/null) || test -z "$predecessor_start"; then
  fail "predecessor pid $wait_pid is not alive."
fi
if test -z "$session_id"; then
  command -v uuidgen >/dev/null 2>&1 || fail 'uuidgen is unavailable.'
  session_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
fi
if ! printf '%s\n' "$session_id" | grep -E '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' >/dev/null; then
  fail 'the successor session id is not a valid UUID.'
fi

if test "$open_tab" = true; then
  test "$(uname -s)" = Darwin || fail 'automatic launch requires macOS.'
  command -v osascript >/dev/null 2>&1 || fail 'osascript is unavailable.'
  if ! osascript -e 'id of application "iTerm2"' >/dev/null 2>&1; then
    fail 'iTerm is not installed.'
  fi
  test -n "${HOME:-}" || fail 'HOME is not set; cannot stage the handoff prompt file.'
  # iTerm "write text" types the whole re-invocation command over the pty; a long
  # base64 blob in that typed line is what truncates (issue #17). Stage the decoded
  # prompt in a file instead and type only a short --prompt-file reference.
  staged_handoff_dir="$HOME/.winston/handoffs"
  (umask 077 && mkdir -p "$staged_handoff_dir") || fail "cannot create the handoff directory: $staged_handoff_dir"
  staged_prompt_file="$staged_handoff_dir/$session_id.prompt"
  (umask 077 && printf '%s' "$prompt" > "$staged_prompt_file") || fail "cannot write the handoff prompt file: $staged_prompt_file"
  if ! osascript - \
    "$script_path" \
    --wait-pid "$wait_pid" \
    --dir "$target_dir" \
    --name "$session_name" \
    --mode "$permission_mode" \
    --session-id "$session_id" \
    --claude-path "$claude_path" \
    --prompt-file "$staged_prompt_file" \
    --max-wait-seconds "$max_wait_seconds" <<'APPLESCRIPT'
on run argv
  set commandText to ""
  repeat with argumentValue in argv
    if commandText is not "" then set commandText to commandText & " "
    set commandText to commandText & quoted form of (contents of argumentValue)
  end repeat

  tell application "iTerm2"
    activate
    if (count of windows) is 0 then
      set newWindow to create window with default profile
      set newTab to current tab of newWindow
    else
      tell current window to set newTab to create tab with default profile
    end if
    tell newTab to select
    tell current session of newTab to write text commandText
  end tell
end run
APPLESCRIPT
  then
    rm -f "$staged_prompt_file"
    fail 'osascript could not open the iTerm tab.'
  fi
  printf 'Tab opened for %s — check it shows "Armed", then exit this session.\n' "$session_name"
  exit 0
fi

armed_at=$(date '+%Y-%m-%d %H:%M:%S %Z')
printf 'Armed %s; waiting for %s (pid %s) to exit…\n' "$armed_at" "$session_name" "$wait_pid"
started_at=$(date +%s)
deadline=$((started_at + max_wait_seconds))

while :; do
  current_start=
  if current_start=$(ps -o lstart= -p "$wait_pid" 2>/dev/null) && test "$current_start" = "$predecessor_start"; then
    now=$(date +%s)
    if test "$now" -ge "$deadline"; then
      fail "the predecessor did not exit within $max_wait_seconds seconds."
    fi
    sleep 1
    continue
  fi
  break
done

if (
  exec "$claude_path" \
    --session-id "$session_id" \
    --name "$session_name" \
    --permission-mode "$permission_mode" \
    "$prompt"
); then
  exit 0
fi
fail 'claude could not start.'
