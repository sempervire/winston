#!/usr/bin/env node
/**
 * parallelism-check — Stop hook.
 *
 * In a Winston session, asks the model once per turn to run the skill's
 * Parallelism check before it ends the turn, so idle capacity is caught at every
 * event rather than whenever the model remembers.
 *
 * Winston session = this session holds an unreleased `resource:orchestrator`
 * claim in `chattr state` (Winston claims it at setup). No chattr, no claim, a
 * session that never joined: not Winston, the stop goes through.
 *
 * FAIL OPEN. Any error lets the stop through with no output.
 *
 * Channel and loop safety mirror browser-tab-guard: Claude Code gets
 * `additionalContext` (a block reason renders to the human as "Stop hook
 * error:"), Codex gets `decision: 'block'`. Claude Code may not set
 * `stop_hook_active` after an additionalContext continuation, so the guard is
 * the transcript: if this ask already appears since the turn's last prompt, it
 * stands down.
 *
 * Escape hatch: WINSTON_SKIP_PARALLELISM_CHECK=1.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { harness, readInput } from '../lib/harness.mjs'

const MARK = 'Parallelism check (Winston)'
const ASK =
  `${MARK}, before you end this turn: list every remaining item as running, startable now, ` +
  'or blocked by a named dependency, and launch everything startable now in this turn. ' +
  "Another item's unmerged code is not a blocker: stack the lane on its pushed branch, local-only. " +
  'The real limits are one browser verifier at a time, one merge at a time, a repo rule, a resource ' +
  'another lane holds, or a branch not yet pushed. If nothing is startable, end the turn with no ' +
  'message; this check stands down until the next turn.'

/** True when the session holds an unreleased resource:orchestrator claim. */
export function isWinston(sessionId, cwd) {
  if (!sessionId) return false
  const r = spawnSync('chattr', ['state', '--json'], {
    cwd: cwd || undefined,
    env: { ...process.env, CHATTR_SESSION: sessionId },
    encoding: 'utf8',
    timeout: 3000,
  })
  if (r.status !== 0) return false
  const claims = JSON.parse(r.stdout).claims ?? []
  return claims.some((c) => c.resource === 'resource:orchestrator' && c.session_id === sessionId && !c.released_at)
}

/** True when the ask already went out since the turn's last prompt. A prompt is
 *  a user entry that is not a tool result (typed text, a task notification). */
export function askedThisTurn(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (line.includes('"user"')) {
      let e = null
      try {
        e = JSON.parse(line)
      } catch {}
      const c = e?.type === 'user' && !e.isMeta ? e.message?.content : undefined
      // A prompt that quotes the ask is still a prompt: the boundary wins.
      if (typeof c === 'string' || (Array.isArray(c) && !c.some((p) => p?.type === 'tool_result'))) return false
    }
    if (line.includes(MARK)) return true
  }
  return false
}

function main() {
  if (process.env.WINSTON_SKIP_PARALLELISM_CHECK) return
  const input = readInput()
  // A subagent's Stop (Codex has no SubagentStop) carries agent_id and the parent's session_id.
  if (input.stop_hook_active || input.agent_id) return
  if (!isWinston(input.session_id, input.cwd)) return
  const codex = harness(input) === 'codex'
  if (!codex) {
    let lines
    try {
      lines = readFileSync(input.transcript_path, 'utf8').split('\n')
    } catch {
      return
    }
    if (askedThisTurn(lines)) return
  }
  process.stdout.write(
    JSON.stringify(
      codex
        ? { decision: 'block', reason: ASK }
        : { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: ASK } }
    )
  )
}

if (import.meta.main) {
  try {
    main()
  } catch {
  }
}
