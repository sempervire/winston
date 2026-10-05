#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

bin_dir="$tmp_dir/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/uname" <<'EOF'
#!/bin/sh
printf 'Darwin\n'
EOF

cat > "$bin_dir/uuidgen" <<'EOF'
#!/bin/sh
printf '11111111-2222-4333-8444-555555555555\n'
EOF

cat > "$bin_dir/ps" <<'EOF'
#!/bin/sh
count=0
if test -f "$HANDOFF_TEST_PS_COUNT"; then
  count=$(cat "$HANDOFF_TEST_PS_COUNT")
fi
count=$((count + 1))
printf '%s\n' "$count" > "$HANDOFF_TEST_PS_COUNT"
case ${HANDOFF_TEST_PS_MODE:-exit-after-two} in
  exit-after-two)
    if test "$count" -le 2; then
      test ! -e "$HANDOFF_TEST_CLAUDE_CAPTURE"
      printf 'Mon Sep 22 12:00:00 2026\n'
      exit 0
    fi
    exit 1
    ;;
  dead) exit 1 ;;
  alive)
    printf 'Mon Sep 22 12:00:00 2026\n'
    ;;
  reused)
    if test "$count" -eq 1; then
      printf 'Mon Sep 22 12:00:00 2026\n'
    else
      printf 'Mon Sep 22 12:01:00 2026\n'
    fi
    ;;
  *) exit 2 ;;
esac
EOF

cat > "$bin_dir/claude" <<'EOF'
#!/bin/sh
if test "${1-}" = --help; then
  printf '%s\n' \
    '  --permission-mode <mode>              Permission mode to use for the session' \
    '                                        (choices: "acceptEdits", "auto",' \
    '                                        "bypassPermissions", "manual",' \
    '                                        "dontAsk", "plan")' \
    '  --plugin-dir <path>                   Load plugins from a directory (choices: "auto")'
  exit 0
fi
: > "$HANDOFF_TEST_CLAUDE_CAPTURE"
for arg do
  printf '%s' "$arg" | base64 | tr -d '\n' >> "$HANDOFF_TEST_CLAUDE_CAPTURE"
  printf '\n' >> "$HANDOFF_TEST_CLAUDE_CAPTURE"
done
EOF

cat > "$bin_dir/osascript" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1-}" == -e ]]; then
  exit 0
fi
[[ "${1-}" == - ]]
shift
cat > "$HANDOFF_TEST_APPLESCRIPT_CAPTURE"
grep -F 'quoted form of' "$HANDOFF_TEST_APPLESCRIPT_CAPTURE" >/dev/null
command_text=''
for arg in "$@"; do
  printf -v quoted '%q' "$arg"
  if [[ -n "$command_text" ]]; then
    command_text+=' '
  fi
  command_text+="$quoted"
done
printf '%s\n' "$command_text" > "$HANDOFF_TEST_COMMAND_CAPTURE"
bash -c "$command_text"
EOF

chmod +x "$bin_dir/uname" "$bin_dir/uuidgen" "$bin_dir/ps" "$bin_dir/claude" "$bin_dir/osascript"

project_dir="$tmp_dir/project with spaces, quote ' and unicode 雪"
mkdir -p "$project_dir"
name="Issue 1: quotes '\" dollar $ backtick \` slash \\ snow 雪"
marker="$tmp_dir/prompt-was-executed"
prompt_core="First line with 'single' and \"double\" quotes.
Literal dollar: \$(touch \"$marker\")
Literal backtick: \`touch \"$marker\"\`
Backslash: \\ and Unicode: 雪"
prompt_b64=$(printf '%s\n\n' "$prompt_core" | base64 | tr -d '\n')

export HANDOFF_TEST_PS_COUNT="$tmp_dir/ps-count"
export HANDOFF_TEST_CLAUDE_CAPTURE="$tmp_dir/claude-capture"
export HANDOFF_TEST_APPLESCRIPT_CAPTURE="$tmp_dir/applescript-capture"
export HANDOFF_TEST_COMMAND_CAPTURE="$tmp_dir/command-capture"
export HANDOFF_TEST_PS_MODE=exit-after-two
export HOME="$tmp_dir/home"
mkdir -p "$HOME"
handoffs_dir="$HOME/.winston/handoffs"

PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" --open-tab \
  --wait-pid 4242 \
  --dir "$project_dir" \
  --name "$name" \
  --mode auto \
  --prompt-b64 "$prompt_b64"

assert_not_grep() {
  if grep -F -- "$1" "$2" >/dev/null; then
    printf 'unexpected match for %s in %s\n' "$1" "$2" >&2
    exit 1
  fi
}

grep -F -- '--prompt-file' "$HANDOFF_TEST_COMMAND_CAPTURE" >/dev/null
assert_not_grep '--prompt-b64' "$HANDOFF_TEST_COMMAND_CAPTURE"
test -z "$(ls -A "$handoffs_dir" 2>/dev/null)"

test ! -e "$marker"
test -s "$HANDOFF_TEST_APPLESCRIPT_CAPTURE"
test -s "$HANDOFF_TEST_COMMAND_CAPTURE"

expected="$tmp_dir/expected-capture"
: > "$expected"
for arg in \
  --session-id 11111111-2222-4333-8444-555555555555 \
  --name "$name" \
  --permission-mode auto \
  "$prompt_core"
do
  printf '%s' "$arg" | base64 | tr -d '\n' >> "$expected"
  printf '\n' >> "$expected"
done
diff -u "$expected" "$HANDOFF_TEST_CLAUDE_CAPTURE"

assert_failure() {
  expected_reason=$1
  shift
  output="$tmp_dir/failure-output"
  if "$@" >"$output" 2>&1; then
    printf 'expected launcher failure containing: %s\n' "$expected_reason" >&2
    exit 1
  fi
  grep -F "$expected_reason" "$output" >/dev/null
  grep -F "First line with 'single'" "$output" >/dev/null
}

rm -f "$HANDOFF_TEST_PS_COUNT" "$HANDOFF_TEST_CLAUDE_CAPTURE"
export HANDOFF_TEST_PS_MODE=dead
assert_failure 'predecessor pid 4242 is not alive' \
  env PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" \
    --wait-pid 4242 --dir "$project_dir" --name "$name" --mode auto \
    --prompt-b64 "$prompt_b64" --session-id 11111111-2222-4333-8444-555555555555
test ! -e "$HANDOFF_TEST_CLAUDE_CAPTURE"

rm -f "$HANDOFF_TEST_PS_COUNT" "$HANDOFF_TEST_CLAUDE_CAPTURE"
export HANDOFF_TEST_PS_MODE=alive
assert_failure 'did not exit within 1 seconds' \
  env PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" \
    --wait-pid 4242 --dir "$project_dir" --name "$name" --mode auto \
    --prompt-b64 "$prompt_b64" --session-id 11111111-2222-4333-8444-555555555555 \
    --max-wait-seconds 1
test ! -e "$HANDOFF_TEST_CLAUDE_CAPTURE"

rm -f "$HANDOFF_TEST_PS_COUNT" "$HANDOFF_TEST_CLAUDE_CAPTURE"
export HANDOFF_TEST_PS_MODE=reused
PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" \
  --wait-pid 4242 --dir "$project_dir" --name "$name" --mode auto \
  --prompt-b64 "$prompt_b64" --session-id 11111111-2222-4333-8444-555555555555 >/dev/null
diff -u "$expected" "$HANDOFF_TEST_CLAUDE_CAPTURE"

rm -f "$HANDOFF_TEST_PS_COUNT" "$HANDOFF_TEST_CLAUDE_CAPTURE"
export HANDOFF_TEST_PS_MODE=dead
assert_failure 'permission mode imaginary is unavailable' \
  env PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" \
    --wait-pid 4242 --dir "$project_dir" --name "$name" --mode imaginary \
    --prompt-b64 "$prompt_b64" --session-id 11111111-2222-4333-8444-555555555555
assert_failure 'the target directory is unavailable' \
  env PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" \
    --wait-pid 4242 --dir "$tmp_dir/missing" --name "$name" --mode auto \
    --prompt-b64 "$prompt_b64" --session-id 11111111-2222-4333-8444-555555555555

fail_bin="$tmp_dir/fail-bin"
mkdir -p "$fail_bin"
cat > "$fail_bin/claude" <<'EOF'
#!/bin/sh
if test "${1-}" = --help; then
  chmod -x "$0"
  printf '%s\n' '  --permission-mode <mode> (choices: "auto")'
  exit 0
fi
exit 99
EOF
chmod +x "$fail_bin/claude"
rm -f "$HANDOFF_TEST_PS_COUNT" "$HANDOFF_TEST_CLAUDE_CAPTURE"
export HANDOFF_TEST_PS_MODE=reused
assert_failure 'claude could not start' \
  env PATH="$fail_bin:$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" \
    --wait-pid 4242 --dir "$project_dir" --name "$name" --mode auto \
    --prompt-b64 "$prompt_b64" --session-id 11111111-2222-4333-8444-555555555555

# Issue #17 regression: a prompt too large to type as one base64 argument must
# still arm correctly, and the typed re-invocation command must stay short.
large_prompt=$(i=0; while test "$i" -lt 200; do
  printf 'The quick brown fox jumps over the lazy dog, line %03d.\n' "$i"
  i=$((i + 1))
done)
large_prompt_b64=$(printf '%s\n\n' "$large_prompt" | base64 | tr -d '\n')
test "$(printf '%s' "$large_prompt_b64" | wc -c)" -gt 5000

rm -f "$HANDOFF_TEST_PS_COUNT" "$HANDOFF_TEST_CLAUDE_CAPTURE" "$HANDOFF_TEST_COMMAND_CAPTURE" "$HANDOFF_TEST_APPLESCRIPT_CAPTURE"
export HANDOFF_TEST_PS_MODE=exit-after-two
PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" --open-tab \
  --wait-pid 4242 \
  --dir "$project_dir" \
  --name "$name" \
  --mode auto \
  --prompt-b64 "$large_prompt_b64"

command_len=$(wc -c < "$HANDOFF_TEST_COMMAND_CAPTURE")
test "$command_len" -lt 2000
grep -F -- '--prompt-file' "$HANDOFF_TEST_COMMAND_CAPTURE" >/dev/null
assert_not_grep '--prompt-b64' "$HANDOFF_TEST_COMMAND_CAPTURE"
test -z "$(ls -A "$handoffs_dir" 2>/dev/null)"

expected_large="$tmp_dir/expected-capture-large"
: > "$expected_large"
for arg in \
  --session-id 11111111-2222-4333-8444-555555555555 \
  --name "$name" \
  --permission-mode auto \
  "$large_prompt"
do
  printf '%s' "$arg" | base64 | tr -d '\n' >> "$expected_large"
  printf '\n' >> "$expected_large"
done
diff -u "$expected_large" "$HANDOFF_TEST_CLAUDE_CAPTURE"

# --prompt-file also works as a direct, non-open-tab input.
rm -f "$HANDOFF_TEST_PS_COUNT" "$HANDOFF_TEST_CLAUDE_CAPTURE"
export HANDOFF_TEST_PS_MODE=reused
direct_prompt_file="$tmp_dir/direct-prompt.txt"
printf '%s' "$prompt_core" > "$direct_prompt_file"
PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" \
  --wait-pid 4242 --dir "$project_dir" --name "$name" --mode auto \
  --prompt-file "$direct_prompt_file" --session-id 11111111-2222-4333-8444-555555555555 >/dev/null
diff -u "$expected" "$HANDOFF_TEST_CLAUDE_CAPTURE"
test ! -e "$direct_prompt_file"

# A missing prompt file is reported, not silently swallowed.
missing_file_output="$tmp_dir/missing-file-output"
if PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" \
    --wait-pid 4242 --dir "$project_dir" --name "$name" --mode auto \
    --prompt-file "$tmp_dir/does-not-exist.prompt" --session-id 11111111-2222-4333-8444-555555555555 \
    >"$missing_file_output" 2>&1
then
  printf 'expected launcher failure for a missing prompt file\n' >&2
  exit 1
fi
grep -F 'the prompt file is missing' "$missing_file_output" >/dev/null

# --prompt-b64 and --prompt-file are mutually exclusive, and one is required.
assert_usage_failure() {
  output="$tmp_dir/usage-output"
  if "$@" >"$output" 2>&1; then
    printf 'expected launcher usage failure\n' >&2
    exit 1
  fi
  grep -F 'usage: launch-iterm.sh' "$output" >/dev/null
}
assert_usage_failure env PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" \
  --wait-pid 4242 --dir "$project_dir" --name "$name" --mode auto \
  --session-id 11111111-2222-4333-8444-555555555555
assert_usage_failure env PATH="$bin_dir:$PATH" "$repo_dir/scripts/launch-iterm.sh" \
  --wait-pid 4242 --dir "$project_dir" --name "$name" --mode auto \
  --prompt-b64 "$prompt_b64" --prompt-file "$tmp_dir/unused-prompt.txt" \
  --session-id 11111111-2222-4333-8444-555555555555

printf 'handoff: iTerm transport test passed\n'
