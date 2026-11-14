#!/usr/bin/env node
/**
 * doctor-nudge — one line at session start when the last `winston doctor` run in this
 * repository left open items: "Winston setup has N open items – run /winston:doctor."
 *
 * It reads two local files and nothing else, and starts no other process: the repo's .winston/config.json (no config,
 * no nudge) and the result doctor left in Winston's state directory. It runs no check of
 * its own and makes no network call, so a session never waits on it. A repo where doctor
 * has not run, or where its last run found nothing open, gets no output at all.
 *
 * SessionStart fires again on resume, clear and compaction, so a marker per session id
 * keeps the line to once per session.
 *
 * Fails open: any error exits 0 with no output. A setup reminder is never worth
 * blocking a session over.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { doctorResultPath, stateDir } from '../lib/config.mjs'
import { readInput } from '../lib/harness.mjs'

/**
 * The checkout's top directory, found by walking up to `.git`: no git process to wait on.
 * From the real path, as git reports it and doctor keys its result, so a session opened
 * through a symlink finds the same result.
 */
function topLevel(cwd) {
  for (let dir = realpathSync(resolve(cwd)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dir === dirname(dir)) return null
  }
}

function hook() {
  const input = readInput()
  const root = topLevel(input.cwd || process.cwd())
  if (!root || !existsSync(join(root, '.winston', 'config.json'))) return
  const open = JSON.parse(readFileSync(doctorResultPath(root), 'utf8')).open
  if (!Number.isInteger(open) || open < 1) return
  const short = String(input.session_id || '').replace(/-/g, '').slice(0, 8)
  if (short) {
    const marker = join(stateDir('doctor-nudge'), short)
    if (existsSync(marker)) return
    mkdirSync(stateDir('doctor-nudge'), { recursive: true })
    writeFileSync(marker, '')
  }
  const line = `Winston setup has ${open} open ${open === 1 ? 'item' : 'items'} – run /winston:doctor.`
  process.stdout.write(JSON.stringify({ systemMessage: line, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line } }))
}

if (import.meta.main) {
  try {
    hook()
  } catch {
    // fail open: no result file, garbage in it, or an unwritable state directory
  }
}
