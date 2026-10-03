#!/usr/bin/env node
/**
 * worktree-setup — give a fresh git worktree the gitignored files it needs.
 *
 * `git worktree add` carries only tracked files, so a new worktree lacks the
 * local env files and installed dependencies the main checkout has. This copies
 * config `worktree.copy` (files, never overwriting one that exists) and
 * symlinks config `worktree.link` (e.g. node_modules: a link, not a copy of
 * hundreds of MB) from the main checkout. With no `worktree` config it copies
 * nothing.
 *
 * A linked dependency directory is shared, so it is correct only while the
 * worktree does not change dependencies; if the lock file changes here,
 * replace the link with a real install in this worktree.
 *
 * Registered twice:
 *   PostToolUse on EnterWorktree  Claude Code; NOT WorktreeCreate, which would
 *                                 hand worktree creation itself to this script.
 *   SessionStart                  a session opened directly in a worktree
 *                                 (Codex, or Claude launched into one).
 * The event comes from the payload. On the main checkout it is a no-op.
 *
 * Also warns when the worktree has a detached HEAD, or when config
 * `worktree.branchPattern` (a regex) is set and the branch does not match it.
 *
 * Fails open: a setup step that cannot run is reported, never blocks.
 * A PostToolUse hook's plain stdout is discarded, so anything that must be read
 * goes out as hook JSON (`systemMessage` for the user, `additionalContext` for
 * the session).
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { loadConfig } from '../lib/config.mjs'
import { readInput } from '../lib/harness.mjs'

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const exists = (p) => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Provision worktree `wt` from its main checkout. Returns the message lines, or
 *  null when `wt` is not a linked worktree. */
export function setup(wt, config) {
  let main
  try {
    wt = realpathSync(git(wt, 'rev-parse', '--show-toplevel'))
    main = realpathSync(dirname(git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')))
  } catch {
    return null
  }
  if (main === wt) return null

  const copied = []
  for (const rel of config.worktree?.copy ?? []) {
    const src = join(main, rel)
    const dst = join(wt, rel)
    try {
      if (!statSync(src).isFile() || exists(dst)) continue
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(src, dst)
      copied.push(rel)
    } catch {}
  }
  const linked = []
  for (const rel of config.worktree?.link ?? []) {
    const src = join(main, rel)
    const dst = join(wt, rel)
    if (!existsSync(src) || exists(dst)) continue
    try {
      mkdirSync(dirname(dst), { recursive: true })
      symlinkSync(src, dst)
      linked.push(`${rel} -> main (symlink)`)
    } catch {}
  }

  const setupLine = copied.length || linked.length ? `worktree-setup: ${basename(wt)}: ${[...copied, ...linked].join(' ')}` : ''
  const warnings = []
  let branch = ''
  try {
    branch = git(wt, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  } catch {}
  const pattern = config.worktree?.branchPattern
  if (!branch) {
    warnings.push(
      'worktree-setup: this worktree has a detached HEAD.',
      'worktree-setup: create a branch before committing or pushing -- git switch -c <branch>.'
    )
  } else if (pattern) {
    let ok = true
    try {
      ok = new RegExp(pattern).test(branch)
    } catch {
      warnings.push(`worktree-setup: worktree.branchPattern is not a valid regex: ${pattern}`)
    }
    if (!ok) {
      warnings.push(
        `worktree-setup: branch "${branch}" does not match this repo's branch pattern ${pattern}.`,
        'worktree-setup: rename it before pushing -- git branch -m <branch>.'
      )
    }
  }
  return { setupLine, warnings }
}

function main() {
  const input = readInput()
  const event = input.hook_event_name === 'SessionStart' ? 'SessionStart' : 'PostToolUse'
  // The session has already switched into the worktree by PostToolUse time.
  const r = input.tool_response ?? {}
  const wt = process.argv[2] || r.worktreePath || r.path || input.cwd || process.cwd()

  let config = {}
  try {
    config = loadConfig(wt)
  } catch (e) {
    process.stdout.write(JSON.stringify({ systemMessage: `worktree-setup: ${e.message}` }))
    return
  }
  const result = setup(wt, config)
  if (!result) return
  const { setupLine, warnings } = result

  if (warnings.length || (event === 'SessionStart' && setupLine)) {
    const msg = [setupLine, ...warnings].filter(Boolean).join('\n')
    process.stdout.write(JSON.stringify({ systemMessage: msg, hookSpecificOutput: { hookEventName: event, additionalContext: msg } }))
  } else if (setupLine) {
    process.stdout.write(setupLine + '\n')
  }
}

if (import.meta.main) {
  try {
    main()
  } catch {
  }
}
