/**
 * Which CLI called a hook. One hooks.json serves Claude Code and Codex, so a
 * shared hook reads the answer from the payload, never from a flag baked into
 * the registration.
 *
 * Codex stamps every hook payload with `turn_id`, and names its own tools
 * (`apply_patch`, `shell`, `exec_command`); Claude Code does neither.
 */

import { readFileSync } from 'node:fs'

const CODEX_TOOLS = /^(apply_patch|shell|local_shell|exec_command|request_user_input(_async)?)$/

export function harness(input) {
  if (input && ('turn_id' in input || CODEX_TOOLS.test(input.tool_name ?? ''))) return 'codex'
  return 'claude'
}

/** The shell command a tool call runs, as one string, whichever CLI sent it. */
export function shellCommand(toolInput) {
  const c = toolInput?.command ?? toolInput?.cmd ?? ''
  // Codex's `shell` passes argv, e.g. ["bash", "-lc", "gh pr merge 5"]. Requote it
  // so the segment parser sees `bash -lc '...'` and rescans the script.
  if (Array.isArray(c)) return c.map((a) => (/^[\w./=:@%+-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(' ')
  return String(c)
}

/** Read the hook payload from stdin; {} when there is none or it is garbage. */
export function readInput() {
  try {
    const raw = readFileSync(0, 'utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}
