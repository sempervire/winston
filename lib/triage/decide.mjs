/**
 * The one model call per issue: the claude CLI, with no tools, signed in by
 * CLAUDE_CODE_OAUTH_TOKEN (the owner's subscription; never an API key). The policy is the
 * system prompt and the verdict comes back in a JSON schema. Tests replace decide() whole.
 *
 * `--bare` is not used: it ignores the OAuth token.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPrompt, systemPrompt } from './verdict.mjs'

export const DEFAULT_MODEL = 'opus'
// A second attempt only after the first produced no verdict (a crash, a timeout, output
// that is not the schema), so an issue never has two verdicts: at most one is applied.
const ATTEMPTS = 2
// A long thread with thinking can take minutes; past this the run is stuck, not slow.
const TIMEOUT_MS = 15 * 60 * 1000

export const model = () => process.env.TRIAGE_MODEL || DEFAULT_MODEL

/** The arguments of the call, apart from the prompt, which goes on stdin. */
export function claudeArgs({ systemPromptFile, schema, model }) {
  return [
    '-p', '--tools', '', '--safe-mode', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config',
    '--system-prompt-file', systemPromptFile, '--json-schema', JSON.stringify(schema),
    '--output-format', 'json', '--model', model,
  ]
}

/** The verdict object out of the CLI's one JSON result, or why there is none. */
export function readResult(stdout) {
  let out
  try {
    out = JSON.parse(stdout)
  } catch {
    throw new Error(`claude printed no JSON result: ${String(stdout).slice(0, 300)}`)
  }
  if (out?.type !== 'result' || out.is_error || out.subtype !== 'success') {
    throw new Error(`claude returned no verdict (${out?.subtype ?? 'no subtype'}): ${String(out?.result ?? '').slice(0, 300)}`)
  }
  if (out.structured_output && typeof out.structured_output === 'object') return out.structured_output
  try {
    return JSON.parse(out.result)
  } catch {
    throw new Error(`claude's result was not the verdict JSON: ${String(out.result).slice(0, 300)}`)
  }
}

export async function decide({ issue, status, priority, policy, schema, model: m = model() }) {
  const dir = mkdtempSync(join(tmpdir(), 'winston-triage-'))
  try {
    const systemPromptFile = join(dir, 'system.md')
    writeFileSync(systemPromptFile, systemPrompt(policy))
    // The subscription token signs in; a key in the environment would bill the API instead.
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    // The model needs no GitHub access; it never gets the token.
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_PAT']) delete env[k]
    let last
    for (let i = 0; i < ATTEMPTS; i++) {
      const r = spawnSync('claude', claudeArgs({ systemPromptFile, schema, model: m }), {
        input: buildPrompt({ issue, status, priority }), encoding: 'utf8', env, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
      })
      if (r.error?.code === 'ENOENT') throw new Error('the claude CLI is not installed')
      try {
        if (r.status !== 0 && !r.stdout) throw new Error(`claude exited ${r.status ?? r.signal}: ${(r.stderr || r.error?.message || '').slice(0, 300)}`)
        return readResult(r.stdout)
      } catch (e) {
        last = e
      }
    }
    throw last
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
