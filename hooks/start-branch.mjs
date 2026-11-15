#!/usr/bin/env node
/**
 * start-branch — a session opened in a repo's main checkout starts on the
 * integration branch, up to date.
 *
 * A clone sits on the default branch, which is production. Work, and the
 * project skills and commands that land with it, reach the integration branch
 * first, so a session opened on production is missing whatever has not been
 * released yet. And since sessions do their work in worktrees, nothing ever
 * moves the main checkout forward.
 *
 * SessionStart, in the main checkout of a repo with a Winston repo config:
 *   on `branches.production`    switch to `branches.integration`, then fast-forward
 *   on `branches.integration`   fast-forward to origin
 *   on any other branch         leave it; someone chose that branch
 * It never touches a checkout with uncommitted changes to tracked files, never
 * merges or rebases (fast-forward only), and never runs in a linked worktree.
 * Config `startBranch: false` turns it off. It is off in CI (`CI` or `GITHUB_ACTIONS`
 * set): a workflow checked out the ref it means to run on.
 *
 * Only at a session's start (`source: startup`), never on resume, /clear or compaction.
 *
 * Fails open: whatever it cannot do, it says, and the session starts anyway.
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadLayers } from '../lib/config.mjs'
import { readInput } from '../lib/harness.mjs'

// Never wait on a credential prompt: an unreachable origin is reported, not hung on.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes' }
// The registration allows 30 seconds in all; the fetch is the only slow step.
const run = (cwd, args, timeout = 5000) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, env: ENV })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim().split('\n').pop() }
}

/** A branch name from config reaches git's command line, so it must be a plain branch name. */
const plainBranch = (cwd, name) => typeof name === 'string' && !name.startsWith('-') && run(cwd, ['check-ref-format', '--branch', name]).ok

/** Returns the line to report, or null when there is nothing to do or say. */
export function startBranch(cwd) {
  let layers
  try {
    layers = loadLayers(cwd)
  } catch {
    return null // a broken config is other hooks' and doctor's to report
  }
  if (!layers.root || !layers.repo.loaded) return null
  const config = { ...layers.user.data, ...layers.repo.data }
  const { integration, production } = config.branches ?? {}
  if (config.startBranch === false || !integration || integration === production) return null
  const root = realpathSync(layers.root)
  if (!plainBranch(root, integration)) return `Winston: branches.integration in .winston/config.json is not a plain branch name, so nothing was done. Set it to a branch name such as staging (it is ${JSON.stringify(integration)})`
  const common = run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok || realpathSync(dirname(common.out)) !== root) return null

  const branch = run(root, ['symbolic-ref', '--short', '-q', 'HEAD']).out
  if (branch !== integration && branch !== production) return null
  const dirty = run(root, ['status', '--porcelain', '--untracked-files=no']).out
  // FETCH_HEAD, not origin/<branch>: a narrowed refspec would leave the tracking ref stale.
  const fetched = run(root, ['fetch', '-q', 'origin', '--', `refs/heads/${integration}`], 12000).ok
  const remote = fetched ? run(root, ['rev-parse', '--verify', '-q', 'FETCH_HEAD^{commit}']).out : ''

  if (branch === production) {
    if (dirty) return `Winston: this project folder is on ${production}, the release branch, with uncommitted changes, so it was left there. Work starts from ${integration}: ask Claude to save or set aside those changes and switch to ${integration}.`
    const sw = run(root, ['switch', '-q', integration])
    if (!sw.ok) return `Winston: this project folder is on ${production}, the release branch, and could not be switched to ${integration} (${sw.err}). Ask Claude to switch it to ${integration}.`
  }
  const head = run(root, ['rev-parse', 'HEAD']).out
  const within = (a, b) => run(root, ['merge-base', '--is-ancestor', a, b]).ok
  let state = 'up to date'
  if (!remote) state = 'GitHub (origin) could not be reached, so it may be behind: check your internet connection and GitHub sign-in'
  else if (remote === head) state = 'up to date'
  else if (within(remote, head)) state = 'ahead of origin, with commits not pushed yet: Claude pushes them when the work is ready'
  else if (!within(head, remote)) state = `diverged from origin/${integration}, left as is: ask Claude to bring ${integration} up to date`
  else if (dirty) state = 'behind origin, left as is because of uncommitted changes: ask Claude to save them and bring it up to date'
  else {
    const ff = run(root, ['merge', '-q', '--ff-only', remote])
    state = ff.ok ? `fast-forwarded to ${remote.slice(0, 7)}` : `behind origin and could not be fast-forwarded (${ff.err}): ask Claude to bring it up to date`
  }
  if (branch === production) return `Winston: switched this project folder from ${production} to ${integration}, where work starts (${state}). If a project skill or command from ${integration} is missing in this session, restart it.`
  return state === 'up to date' ? null : `Winston: ${integration} ${state}.`
}

function main() {
  if (process.env.CI || process.env.GITHUB_ACTIONS) return
  const input = readInput()
  // Only a new session. A resume, /clear or compaction is the same session going on, and it
  // may have moved this checkout to production on purpose (a release).
  if (input.source && input.source !== 'startup') return
  let msg
  try {
    msg = startBranch(input.cwd || process.cwd())
  } catch (e) {
    msg = `Winston could not check the starting branch: ${e.message}`
  }
  if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } }))
}

if (import.meta.main) {
  try {
    main()
  } catch {
  }
}
