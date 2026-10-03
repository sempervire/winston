#!/usr/bin/env node
/**
 * Session title: name a Claude Code session after the work it is doing.
 *
 * Claude cannot rename a session directly - there is no rename tool, and a
 * skill's markdown is only a prompt. The single supported path is a hook
 * returning `sessionTitle`, and only on UserPromptSubmit or SessionStart
 * (Stop, SubagentStop and PostToolUse accept additionalContext alone). So the
 * rename cannot fire mid-turn: Claude records the title it wants, and the next
 * prompt publishes it - whichever prompt that turns out to be.
 *
 * There is no file poke that renames a live session: the files that hold a
 * title (~/.claude/sessions/<pid>.json, the transcript's `custom-title`
 * record) are outputs the CLI writes, never inputs it reads.
 *
 * Two modes, one file, because the writer and the hook share exactly one fact -
 * where the state lives.
 *
 *   writer   winston title "1042 Fix display error"
 *            (or: node session-title.mjs "1042 Fix display error")
 *   hook     <UserPromptSubmit or SessionStart JSON on stdin>
 *
 * Codex names its own threads, so under Codex the hook does nothing.
 *
 * Fails open. A session title is never worth blocking a prompt over: any error
 * exits 0 with no output.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../lib/config.mjs'
import { harness, readInput } from '../lib/harness.mjs'

/** The CLI's own cap: control characters stripped, then 200 chars. */
const MAX_TITLE = 200

/** The session id with its dashes removed, first 8 characters. */
function statePath(sessionId) {
  const short = String(sessionId || '').replace(/-/g, '').slice(0, 8)
  return short ? join(stateDir('session-title'), `${short}.json`) : null
}

function readState(sessionId) {
  const p = statePath(sessionId)
  if (!p) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null // no file yet, or garbage -> no title
  }
}

function writeState(sessionId, state) {
  const p = statePath(sessionId)
  if (!p) return
  try {
    mkdirSync(stateDir('session-title'), { recursive: true })
    writeFileSync(p, JSON.stringify(state))
  } catch {
    // best effort; a lost sidecar costs at most one repeated rename
  }
}

/**
 * Strip what the CLI would strip anyway, and cap at its hard limit.
 *
 * Whitespace collapses FIRST, before control characters are stripped: a tab or
 * newline is a control character, so stripping first deletes it outright and
 * welds the words on either side together ("Fix\tthis" -> "Fixthis").
 */
export function normalize(s) {
  const clean = String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .trim()
  return [...clean].slice(0, MAX_TITLE).join('')
}

/** Writer. The Bash tool's environment carries this session's id, so nothing
 *  has to be threaded through from the prompt. Returns the title recorded, or null. */
export function recordTitle(words, env = process.env) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || ''
  const title = normalize(words.join(' '))
  if (!sessionId || !title) return null
  const prev = readState(sessionId)
  writeState(sessionId, {
    title,
    // Preserved, not cleared: it is what stops the hook re-emitting a title
    // that is already applied.
    lastEmitted: prev?.lastEmitted,
    updated: new Date().toISOString(),
  })
  return title
}

function hook() {
  const input = readInput()
  if (harness(input) === 'codex') return
  const sessionId = input.session_id || ''
  const state = readState(sessionId)

  // Emit each distinct title exactly once. Re-emitting on every prompt would
  // mean a manual /rename could never survive: it would be stomped by the
  // stored title on the very next message. This way only a genuinely new
  // title overrides a hand-picked one.
  if (state?.title && state.title !== state.lastEmitted) {
    writeState(sessionId, { ...state, lastEmitted: state.title })
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: input.hook_event_name === 'SessionStart' ? 'SessionStart' : 'UserPromptSubmit',
          sessionTitle: state.title,
        },
      })
    )
  }
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2)
    if (argv.length > 0) recordTitle(argv)
    else hook()
  } catch {
    // fail open
  }
}

// Deliberately NO process.exit(0). stdout is an asynchronous pipe when a hook
// receives it, and process.exit() does not wait for it to drain - the payload
// gets truncated at the pipe buffer. Letting the event loop drain exits 0.
