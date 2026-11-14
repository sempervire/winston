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
 * Fails open: whatever it cannot do, it says, and the session starts anyway.
 */

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadLayers } from '../lib/config.mjs'
import { readInput } from '../lib/harness.mjs'

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim()
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args)
  } catch {
    return null
  }
}

/** Returns the line to report, or null when there is nothing to do or say. */
export function startBranch(cwd) {
  const layers = loadLayers(cwd)
  if (!layers.root || !layers.repo.loaded) return null
  const config = { ...layers.user.data, ...layers.repo.data }
  const { integration, production } = config.branches ?? {}
  if (config.startBranch === false || !integration || integration === production) return null
  const root = realpathSync(layers.root)
  if (realpathSync(dirname(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'))) !== root) return null

  const branch = tryGit(root, 'symbolic-ref', '--short', '-q', 'HEAD')
  if (branch !== integration && branch !== production) return null
  const dirty = git(root, 'status', '--porcelain', '--untracked-files=no')
  const fetched = tryGit(root, 'fetch', '-q', 'origin', integration) !== null
  const remote = tryGit(root, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${integration}`)

  if (branch === production) {
    if (dirty) return `start-branch: this checkout is on ${production} with uncommitted changes, so it was left there. Work starts from ${integration}: commit or set the changes aside, then git switch ${integration}.`
    if (tryGit(root, 'switch', '-q', integration) === null) return `start-branch: this checkout is on ${production} and could not be switched to ${integration}. Run: git switch ${integration}`
  }
  const head = git(root, 'rev-parse', 'HEAD')
  let state = 'up to date'
  if (!fetched) state = 'origin could not be reached, so it may be behind'
  else if (remote && remote !== head) {
    if (dirty) state = 'behind origin, left as is because of uncommitted changes'
    else if (tryGit(root, 'merge', '-q', '--ff-only', remote) === null) state = `diverged from origin/${integration}, left as is`
    else state = `fast-forwarded to ${remote.slice(0, 7)}`
  }
  if (branch === production) return `start-branch: switched this checkout from ${production} to ${integration} (${state}). If a project skill or command from ${integration} is missing in this session, restart it.`
  return state === 'up to date' ? null : `start-branch: ${integration} ${state}.`
}

function main() {
  if (process.env.CI || process.env.GITHUB_ACTIONS) return
  const input = readInput()
  let msg
  try {
    msg = startBranch(input.cwd || process.cwd())
  } catch (e) {
    msg = `start-branch: ${e.message}`
  }
  if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } }))
}

if (import.meta.main) {
  try {
    main()
  } catch {
  }
}
