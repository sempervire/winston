#!/usr/bin/env node
/**
 * browser-tab-guard — Stop hook.
 *
 * Asks the model to close Claude-in-Chrome tabs this session opened and never
 * closed, so browser tabs don't pile up for the user to clean up.
 *
 * Design rule: FAIL OPEN. A hook that errors and blocks would wedge the session
 * with no way out; a leftover tab costs one click. Any doubt — unreadable
 * transcript, unparseable line, missing path — lets the stop through.
 *
 * CHANNEL. Under Claude Code the ask goes out as
 * `hookSpecificOutput.additionalContext` rather than `decision: 'block'`: a
 * block reason is rendered to the human as "Stop hook error:", and this nudge
 * is written for the model, so it goes to the model. Codex's Stop output has no
 * hookSpecificOutput; there a continuation is `decision: 'block'` with the text
 * as `reason`, and Codex re-prompts with it.
 *
 * Nudging is not a verdict. If the model decides a tab should stay open (an
 * error the user should see, a page awaiting confirmation), it says so and
 * stops again — the sidecar below records that the ask was already made for
 * this same open, so the hook stands down rather than looping.
 *
 * Loop safety: `stop_hook_active` is documented as set on the Stop that
 * follows a *block*, and whether it is set after an `additionalContext`
 * continuation is unknown. So the guard that has to hold is our own: a marker
 * keyed by session, holding the transcript index of the open the ask was made
 * about. Same open -> already asked -> stand down. A LATER open is a new tab and
 * earns a fresh ask.
 *
 * Escape hatch: set CLAUDE_SKIP_TAB_GUARD=1 to disable for a session.
 * State lives in ~/.winston/state/browser-tab-guard (WINSTON_HOME moves it).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, stateDir } from '../lib/config.mjs'
import { harness, readInput } from '../lib/harness.mjs'

// Claude Code names MCP tools mcp__<server>__<tool>; matched on the tool part
// after the server so a renamed or Codex-side server prefix still counts.
const SERVER = /claude-in-chrome/
const OPEN = /__(tabs_create_mcp|tabs_context_mcp)$/
const CLOSE = /__tabs_close_mcp$/

/** The tool calls on one transcript line, as [{ name, input }]: Claude Code
 *  `message.content[].tool_use`, or a Codex rollout `function_call`. */
function toolCalls(entry) {
  const content = entry?.message?.content
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'tool_use')
  const p = entry?.payload
  if (p?.type === 'function_call' && typeof p.name === 'string') {
    let input = {}
    try {
      input = JSON.parse(p.arguments || '{}')
    } catch {}
    return [{ name: p.namespace ? `${p.namespace}__${p.name}` : p.name, input }]
  }
  return []
}

/** Transcript indexes of the last tab open and the last tab close; -1 for none.
 *  Order beats counting: one close can close several tabs at once, so
 *  "closes < opens" would false-positive on every multi-tab cleanup. */
export function lastOpenAndClose(lines) {
  let lastOpen = -1
  let lastClose = -1
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue
    let entry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    for (const call of toolCalls(entry)) {
      const name = String(call.name || '')
      if (!SERVER.test(name)) continue
      if (CLOSE.test(name)) lastClose = i
      // tabs_context_mcp only opens a tab when asked to
      else if (OPEN.test(name) && (!/tabs_context_mcp$/.test(name) || call.input?.createIfEmpty === true)) lastOpen = i
    }
  }
  return { lastOpen, lastClose }
}

function statePath(sessionId) {
  const short = String(sessionId || '').replace(/-/g, '').slice(0, 8)
  return short ? join(stateDir('browser-tab-guard'), `${short}.json`) : null
}

function readState(sessionId) {
  const p = statePath(sessionId)
  if (!p) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function writeState(sessionId, state) {
  const p = statePath(sessionId)
  if (!p) return
  try {
    mkdirSync(stateDir('browser-tab-guard'), { recursive: true })
    writeFileSync(p, JSON.stringify(state))
  } catch {
  }
}

function main() {
  if (process.env.CLAUDE_SKIP_TAB_GUARD) return
  const input = readInput()

  let lines = []
  try {
    lines = readFileSync(input.transcript_path, 'utf8').split('\n')
  } catch {
    return
  }
  const { lastOpen, lastClose } = lastOpenAndClose(lines)
  const sessionId = input.session_id || process.env.CLAUDE_SESSION_ID || ''

  if (lastOpen === -1 || lastClose > lastOpen) {
    // Nothing outstanding. Clear the marker so a tab opened later gets a fresh
    // ask rather than being silenced by a stale one.
    if (readState(sessionId)) writeState(sessionId, { nagged: null })
    return
  }

  if (readState(sessionId)?.nagged === lastOpen || input.stop_hook_active) return

  writeState(sessionId, { nagged: lastOpen })

  let owner = 'the user'
  try {
    owner = loadConfig(input.cwd).owner || owner
  } catch {}
  const ask =
    'You opened a Claude-in-Chrome tab this session and never closed it. ' +
    'Close it now with the tabs_close_mcp tool before finishing — ' +
    `don't leave tabs for ${owner} to clean up.\n\n` +
    'If a tab should stay open — an error they should see, a page you want them to ' +
    'confirm — leave it and say in one line which URL and why. Either way this ' +
    'check stands down after this turn, so answer it once and move on.'

  process.stdout.write(
    JSON.stringify(
      harness(input) === 'codex'
        ? { decision: 'block', reason: ask }
        : { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: ask } }
    )
  )
}

if (import.meta.main) {
  try {
    main()
  } catch {
  }
}

// No process.exit(0): let stdout drain naturally.
