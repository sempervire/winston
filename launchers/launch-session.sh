#!/bin/bash
# launch-session.sh <claude|codex> — start a NEW agent session in its own git worktree.
#
# Every launch gets a fresh worktree cut from the configured base, so parallel
# sessions never share a checkout, an index or a branch, and the main checkout's
# dirty state is never touched. Config (see lib/config.mjs):
#
#   launcher.repo     the checkout to launch in (user layer; ~ allowed)
#   launcher.base     the remote-tracking ref to start from, e.g. origin/main
#                     (default: origin/<branches.integration>)
#   worktree.copy     gitignored files to copy in from the main checkout
#   worktree.link     directories to symlink in (e.g. node_modules)
#
# Any failure stops the launch before the agent starts and keeps the half-made
# worktree for inspection. The worktree outlives the session; remove it with
# `git worktree remove` when done.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
worktree=""
fail() {
    echo "launch-session: $*" >&2
    if [ -n "$worktree" ]; then
        echo "launch-session: preserved for inspection: $worktree" >&2
    fi
    exit 1
}

# cfg <dir> <dotted.key>: the merged config value for <dir>; arrays one item per line.
cfg() {
    (cd "$1" && node --input-type=module -e '
        const { loadConfig } = await import(process.argv[1])
        let v = loadConfig(process.cwd())
        for (const k of process.argv[2].split(".")) v = v?.[k]
        if (Array.isArray(v)) v.forEach((x) => console.log(x))
        else if (v != null) console.log(v)
    ' "$ROOT/lib/config.mjs" "$2")
}

agent="${1:-}"
case "$agent" in
    claude|codex) ;;
    *) fail "usage: launch-session.sh <claude|codex>" ;;
esac
[ "$#" -eq 1 ] || fail "This launcher starts new sessions only; extra arguments are not accepted."
command -v "$agent" >/dev/null || fail "$agent is not on PATH."
command -v node >/dev/null || fail "node is not on PATH."

repo="$(cfg "$HOME" launcher.repo)" || fail "Cannot read the Winston config."
[ -n "$repo" ] || fail "Set launcher.repo in ~/.winston/config.json."
repo="${repo/#\~/$HOME}"
cd "$repo" || fail "Cannot enter $repo."
repo="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "$repo is not a git checkout."
cd "$repo"
repo="$(pwd -P)"

base_ref="$(cfg "$repo" launcher.base)" || fail "Cannot read the Winston config for $repo."
if [ -z "$base_ref" ]; then
    integration="$(cfg "$repo" branches.integration)" || fail "Cannot read the Winston config for $repo."
    [ -n "$integration" ] || fail "Set launcher.base (or branches.integration) in the Winston config."
    base_ref="origin/$integration"
fi
copy=()
while IFS= read -r line; do [ -n "$line" ] && copy+=("$line"); done < <(cfg "$repo" worktree.copy || echo "__fail__")
link=()
while IFS= read -r line; do [ -n "$line" ] && link+=("$line"); done < <(cfg "$repo" worktree.link || echo "__fail__")
case " ${copy[*]:-} ${link[*]:-} " in *" __fail__ "*) fail "Cannot read the worktree lists from the Winston config." ;; esac

base="$(git rev-parse --verify --quiet "refs/remotes/$base_ref^{commit}")" || fail "Local $base_ref is unavailable; fetch it before launching."
mkdir -p "$repo/.claude/worktrees" || fail "Cannot create the worktree directory."
worktree="$(mktemp -d "$repo/.claude/worktrees/$agent-XXXXXXXX")" || fail "Cannot reserve a unique worktree."
branch="session/$(basename "$worktree")"
git worktree add -b "$branch" "$worktree" "$base" || fail "Cannot create isolated worktree."
cd "$worktree" || fail "Cannot enter isolated worktree."
[ "$(git rev-parse --show-toplevel)" = "$worktree" ] || fail "Unexpected worktree root."
[ "$(git rev-parse HEAD)" = "$base" ] || fail "Unexpected starting commit."

for rel in ${copy[@]+"${copy[@]}"}; do
    case "/$rel/" in */../*) fail "Refusing a worktree.copy path that leaves the checkout: $rel" ;; esac
    src="$repo/$rel"
    dst="$worktree/$rel"
    if [ ! -e "$src" ] && [ ! -L "$src" ]; then
        echo "launch-session: $rel not available; app setup may be needed." >&2
        continue
    fi
    [ -f "$src" ] || fail "Source $rel is not a regular file."
    # A symlinked parent directory in the worktree would carry the copy elsewhere.
    parent="$(dirname "$rel")"
    while [ "$parent" != "." ] && [ "$parent" != "/" ]; do
        [ ! -L "$worktree/$parent" ] || fail "Refusing provisioning through a $parent symlink."
        parent="$(dirname "$parent")"
    done
    if [ -e "$dst" ] || [ -L "$dst" ]; then
        [ -f "$dst" ] && [ ! -L "$dst" ] || fail "Unexpected existing $rel."
        cmp -s "$src" "$dst" || fail "Existing $rel differs from source; refusing to overwrite it."
        continue
    fi
    mkdir -p "$(dirname "$dst")" || fail "Cannot create directory for $rel."
    cp -p "$src" "$dst" || fail "Cannot copy $rel."
    [ -f "$dst" ] && [ ! -L "$dst" ] && cmp -s "$src" "$dst" || fail "Copy verification failed for $rel."
done

for rel in ${link[@]+"${link[@]}"}; do
    case "/$rel/" in */../*) fail "Refusing a worktree.link path that leaves the checkout: $rel" ;; esac
    if [ -d "$repo/$rel" ]; then
        if [ ! -e "$worktree/$rel" ] && [ ! -L "$worktree/$rel" ]; then
            mkdir -p "$(dirname "$worktree/$rel")" || fail "Cannot create directory for $rel."
            ln -s "$repo/$rel" "$worktree/$rel" || fail "Cannot link $rel."
        fi
        [ -L "$worktree/$rel" ] && [ "$(readlink "$worktree/$rel")" = "$repo/$rel" ] && [ -d "$worktree/$rel" ] || fail "$rel link verification failed."
    else
        echo "launch-session: $rel not available; install it before running the app." >&2
    fi
done

printf 'launch-session: %s\nBase: %s at %s\n' "$worktree" "$base_ref" "$base"
echo "Temporary branch: $branch. Rename it for the work before committing or pushing."
# caffeinate waits on this shell's pid rather than wrapping the CLI: `exec`
# replaces the shell image but keeps the pid, so the assertion ends exactly when
# the agent exits, and the foreground job is the agent, so iTerm reports its name.
if command -v caffeinate >/dev/null; then caffeinate -i -w $$ & fi
exec "$agent"
