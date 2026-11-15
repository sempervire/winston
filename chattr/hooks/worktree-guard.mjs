#!/usr/bin/env node
/**
 * worktree-guard — PreToolUse guard for Edit|Write|NotebookEdit.
 *
 * Blocks a file edit when another live session — Claude or Codex — is working
 * in the same directory, so two sessions never share one git index / working
 * tree.
 *
 * Design rule: FAIL CLOSED. Any doubt — unreadable hook payload, an
 * unresolvable path, an `chattr` lookup that errors — blocks and sends the
 * session to a worktree. A needless worktree is cheap; two sessions in one
 * checkout is not.
 *
 * Escape hatches: set CLAUDE_ALLOW_SHARED_CWD=1 for a session that should be
 * allowed to share a checkout deliberately; set "sharedCheckoutGuard": false in
 * the repository's (or the user's) .winston/config.json to turn the guard off.
 * A config file that does not parse leaves the guard on.
 *
 * Winston's hooks.json passes --bundled: that registration stands down while a
 * separate chattr plugin or the old install.sh hooks run this guard already
 * (../hook/standdown.mjs).
 *
 * Peer discovery is `chattr who --repo --coverage` (
 * `chattr/SPEC.md`), not a session registry — see
 * `lib/peers.mjs`. This file owns the policy: deny, and what the message
 * says.
 *
 * Coverage (SPEC.md section 9's `coverage.complete`):
 * `who` cannot see a session that never enrolled, so an empty or short-of-
 * every-live-process result is denied exactly like an `chattr` failure —
 * "no rival reported" is not "no rival exists" unless coverage says it looked
 * everywhere. Only a rival-free result WITH complete coverage allows.
 *
 * The wrap-in-try/catch around path resolution below was protection an
 * installed `~/.codex/hooks` copy carried that the old tracked source did
 * not — ported forward here rather than lost.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { guardOff, kindOf, standDownReason } from '../hook/standdown.mjs'
import { canonical, coverageComplete, describePeers, findRepoRivals, isInside, listRepoSessions, unenrolledCount, worktreeOf } from './lib/peers.mjs'

function allow() {
  process.exit(0)
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  )
  process.exit(0)
}

// How to get past this guard, in plain words, appended to every block.
const WAYS_OUT =
  'To let this one session share the folder, start it with CLAUDE_ALLOW_SHARED_CWD=1. ' +
  'To turn this check off for the repository, set "sharedCheckoutGuard": false in .winston/config.json.'

let input = {}
try {
  const raw = readFileSync(0, 'utf8')
  if (raw.trim()) input = JSON.parse(raw)
} catch {
  deny(
    'Blocked: Winston could not read what this edit is, so it cannot check that no other ' +
      'Claude or Codex session is working in this folder. It blocks rather than guess. ' +
      `Work in a worktree (the EnterWorktree tool).\n\n${WAYS_OUT}`
  )
}

if (process.argv.includes('--bundled') && standDownReason(kindOf(input))) allow()
if (process.env.CLAUDE_ALLOW_SHARED_CWD) allow()

// The directory judged: the session's cwd, unless the edit lands in a different git worktree than
// the session's own (a subagent started in the main checkout editing a lane worktree), when it is
// that worktree's root (sempervire/dev-tools#56). An edit outside both is not this guard's concern.
let myCwd
try {
  myCwd = canonical(input.cwd || process.cwd())
  const filePath = input?.tool_input?.file_path
  if (typeof filePath === 'string' && filePath.length > 0) {
    const target = canonical(resolve(myCwd, filePath))
    const tree = worktreeOf(target)
    if (tree && tree !== worktreeOf(myCwd)) myCwd = tree
    else if (!isInside(target, myCwd)) allow()
  }
} catch {
  deny(`Blocked: Winston could not work out which folder this edit lands in, so it blocks rather than guess.\n\n${WAYS_OUT}`)
}

if (guardOff(myCwd)) allow()

let sessions, coverage
try {
  ;({ sessions, coverage } = listRepoSessions({ cwd: myCwd }))
} catch (err) {
  deny(
    `Blocked: Winston could not list the other live sessions (chattr: ${err.message}), so it cannot ` +
      'rule out another session working in this folder. It blocks rather than guess.\n\n' +
      WAYS_OUT
  )
}

if (!coverageComplete(coverage)) {
  const n = unenrolledCount(coverage)
  deny(
    `Blocked: Winston cannot confirm this folder is yours alone. chattr reports incomplete peer coverage` +
      (n === null ? '' : ` (${n} live claude/codex process${n === 1 ? '' : 'es'} not enrolled)`) +
      `: a session that started before Winston was installed, or one without Winston's hooks, ` +
      `may be working here. Restarting those sessions lets them check in.\n\n` +
      `Work in a worktree (the EnterWorktree tool) to be safe.\n\n${WAYS_OUT}`
  )
}

const rivals = findRepoRivals({ cwd: myCwd, sessionId: input.session_id, sessions })

if (rivals.length === 0) allow()

deny(
  `Blocked: another session is live in the folder this edit lands in.\n\n` +
    `${myCwd}\n${describePeers(rivals)}\n\n` +
    `Two sessions editing one folder can overwrite each other's unsaved changes and commits.\n\n` +
    `Move this session into its own worktree before editing: use the EnterWorktree ` +
    `tool (preferred), or:\n` +
    `  git worktree add .claude/worktrees/<slug> -b <branch>\n\n` +
    `A worktree separates files only. The branch, the remote, shared databases, ` +
    `GitHub issues and PRs, and deploys are still shared with every other session.\n\n` +
    WAYS_OUT
)
