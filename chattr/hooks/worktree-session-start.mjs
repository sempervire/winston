#!/usr/bin/env node
/**
 * worktree-session-start — SessionStart notice for a shared checkout.
 *
 * Two sessions in one directory share one git index and one working tree.
 * `worktree-guard.mjs` catches that at the moment of an `Edit`/`Write`, which
 * is most of the writing but not all of it: in auto mode file work goes
 * through `Bash`, and `git pull` / `git checkout` / `sed -i` never touch an
 * edit tool. On 2026-08-11 a `git pull` in a shared checkout rebased a peer
 * session's three unpushed commits; nothing was lost, and nothing prevented it
 * either.
 *
 * Sharing a checkout is a property of the SESSION, not of any one command. It
 * is knowable the moment the second session opens, which is also the moment
 * it is cheapest to act on — before any work exists to disturb. So this runs
 * ONCE per session instead of on every tool call, and it warns rather than
 * blocks, because `SessionStart` has nothing to block.
 *
 * A `Bash` matcher on the guard is the alternative that looks obvious. The
 * README entry this pointed to never existed in the chattr repo, so the
 * reasoning is not recorded; weigh it afresh before adding one.
 *
 * Deliberately advisory: it prints a notice and exits 0 on every path. It adds
 * protection where there is none today and removes none, so an error here
 * must never wedge a session. Where it CANNOT complete its check it says so
 * and still recommends the worktree — the fail-closed instinct of the guard,
 * expressed in the only currency this event has: an "unknown" that is never
 * reported as "no peers".
 *
 * Escape hatches: CLAUDE_ALLOW_SHARED_CWD=1 and "sharedCheckoutGuard": false in
 * .winston/config.json, the same ones the guard honours. Both silence only the
 * shared-checkout warning; peers in other worktrees are still listed.
 *
 * Winston's hooks.json passes --bundled: that registration stands down while a
 * separate chattr plugin or the old install.sh hooks run this hook already.
 *
 * Peer discovery is `chattr who --repo --coverage` (
 * `chattr/SPEC.md`), not a session registry — see
 * `lib/peers.mjs`. Incomplete coverage (SPEC.md, "Coverage") prints
 * "peers: unknown (N unenrolled)" rather than trusting whatever `who` did
 * return as the whole picture.
 */

import { readFileSync } from 'node:fs'

import { guardOff, kindOf, standDownReason } from '../hook/standdown.mjs'
import {
  canonical,
  coverageComplete,
  describePeers,
  findRepoPeers,
  findRepoRivals,
  listRepoSessions,
  unenrolledCount,
} from './lib/peers.mjs'

function say(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    })
  )
  process.exit(0)
}

function silent() {
  process.exit(0)
}

let input = {}
try {
  const raw = readFileSync(0, 'utf8')
  if (raw.trim()) input = JSON.parse(raw)
} catch {
  // No payload to read. process.cwd() is still the session's directory, and
  // the sessionId filter below still degrades gracefully without one — carry
  // on rather than going quiet.
}

if (process.argv.includes('--bundled') && standDownReason(kindOf(input), process.env, input.cwd || process.cwd())) silent()

const myCwd = canonical(input.cwd || process.cwd())

let sessions, coverage
try {
  ;({ sessions, coverage } = listRepoSessions({ cwd: myCwd }))
} catch (err) {
  say(
    `Could not enumerate live sessions via chattr (${err.message}), so it is unknown whether ` +
      `another session is live in ${myCwd} or elsewhere in this repository.\n\n` +
      `Treat this checkout as shared: use the EnterWorktree tool before editing anything, or ` +
      `set CLAUDE_ALLOW_SHARED_CWD=1 if you know this checkout is yours alone. Peer discovery ` +
      `for announcements (Winston's chattr/docs/AGENT-RULES.md) is a coordination failure to report, ` +
      `not an empty peer list.`
  )
}

// The escape hatch covers the shared-checkout warning only: a session that
// shares a checkout on purpose still has peers to announce to.
const rivals = process.env.CLAUDE_ALLOW_SHARED_CWD || guardOff(myCwd)
  ? []
  : findRepoRivals({ cwd: myCwd, sessionId: input.session_id, sessions })
const peers = findRepoPeers({ sessionId: input.session_id, sessions }).filter((p) => !rivals.includes(p))

const parts = []
if (!coverageComplete(coverage)) {
  const n = unenrolledCount(coverage)
  parts.push(
    `peers: unknown (${n === null ? '?' : n} unenrolled)\n\n` +
      `chattr cannot vouch that every live claude/codex process on this machine has joined, ` +
      `so treat any peer list below as a lower bound, not the whole picture.`
  )
}

if (rivals.length === 0 && peers.length === 0 && parts.length === 0) silent()

if (rivals.length > 0) {
  parts.push(
    `WARNING: another session is already live in this working directory.\n\n` +
      `${myCwd}\n${describePeers(rivals)}\n\n` +
      `Two sessions working in one folder can overwrite each other's unsaved changes and ` +
      `commits, and git commands run through Bash are not stopped by any hook.\n\n` +
      `Move into your own worktree BEFORE doing any work: use the EnterWorktree tool ` +
      `(preferred), or:\n` +
      `  git worktree add .claude/worktrees/<slug> -b <branch>\n\n` +
      `A worktree separates files only. The branch, the remote, shared databases, GitHub ` +
      `issues and PRs, and deploys stay shared with every other session.\n\n` +
      `To let this one session share the folder, start it with CLAUDE_ALLOW_SHARED_CWD=1. ` +
      `To turn this check off for the repository, set "sharedCheckoutGuard": false in .winston/config.json.`
  )
}
if (peers.length > 0) {
  parts.push(
    `Other live sessions in this repository (other worktrees):\n${describePeers(peers)}\n\n` +
      `Claim what you take before starting real work: ` +
      `\`chattr claim issue:<N> "<task>, worktree <path>, branch <name>"\`; ` +
      `\`chattr state\` lists what is already claimed. ` +
      `Otherwise message a peer only with something useful to it, and absorb incoming ` +
      `broadcasts silently (Winston's chattr/docs/AGENT-RULES.md).`
  )
}

say(parts.join('\n\n'))
