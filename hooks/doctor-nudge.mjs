#!/usr/bin/env node
/**
 * doctor-nudge — one line at session start when the last `winston doctor` run in this
 * repository left open items: "Winston setup has N things left, starting with "<item>".
 * Type /winston:doctor to see them."
 *
 * A repo with no .winston/config.json gets a different line, once per repo ever: Winston
 * is installed and not set up here, and /winston:init is the first step. The user layer's
 * `setupNudge: false` turns that line off.
 *
 * It reads local files and nothing else, and starts no other process: the repo's
 * .winston/config.json, the result doctor left in Winston's state directory, and the
 * user layer. It runs no check of its own and makes no network call, so a session never
 * waits on it. A configured repo where doctor has not run, or where its last run found
 * nothing open, gets no output at all.
 *
 * SessionStart fires again on resume, clear and compaction, so a marker per session id
 * keeps the line to once per session.
 *
 * Fails open: any error exits 0 with no output. A setup reminder is never worth
 * blocking a session over.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { doctorResultPath, stateDir, winstonHome } from '../lib/config.mjs'
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

const say = (line) => process.stdout.write(JSON.stringify({ systemMessage: line, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line } }))

/** The user layer's `setupNudge`, read as a file: false turns the not-set-up line off. */
function setupNudgeOff() {
  try {
    return JSON.parse(readFileSync(join(winstonHome(), 'config.json'), 'utf8')).setupNudge === false
  } catch {
    return false
  }
}

/**
 * A repo with no Winston config: one line, once per repo ever (a marker per checkout in
 * the state directory), so someone who just installed Winston learns the first step
 * without finding it in the README.
 */
function setupNudge(root) {
  if (setupNudgeOff()) return
  const dir = stateDir('setup-nudge')
  const marker = join(dir, createHash('sha256').update(root).digest('hex').slice(0, 16))
  if (existsSync(marker)) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(marker, root)
  say('Winston is installed but not set up in this project. Type /winston:init to set it up (nothing changes until you say yes). This reminder shows once per project.')
}

function hook() {
  const input = readInput()
  const root = topLevel(input.cwd || process.cwd())
  if (!root) return
  if (!existsSync(join(root, '.winston', 'config.json'))) return setupNudge(root)
  const result = JSON.parse(readFileSync(doctorResultPath(root), 'utf8'))
  const { open } = result
  if (!Number.isInteger(open) || open < 1) return
  const short = String(input.session_id || '').replace(/-/g, '').slice(0, 8)
  if (short) {
    const marker = join(stateDir('doctor-nudge'), short)
    if (existsSync(marker)) return
    mkdirSync(stateDir('doctor-nudge'), { recursive: true })
    writeFileSync(marker, '')
  }
  const first = typeof result.first === 'string' && result.first ? `, starting with "${result.first}"` : ''
  say(`Winston setup has ${open} ${open === 1 ? 'thing' : 'things'} left${first}. Type /winston:doctor to see ${open === 1 ? 'it' : 'them'}.`)
}

if (import.meta.main) {
  try {
    hook()
  } catch {
    // fail open: no result file, garbage in it, or an unwritable state directory
  }
}
