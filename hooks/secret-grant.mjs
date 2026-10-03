#!/usr/bin/env node
/**
 * secret-grant — session-scoped authorization for credential-console pages.
 *
 * The problem: auto mode's permission classifier refuses to open any page that
 * lists credentials — R2 API tokens, AWS IAM, Stripe API keys, and so on. That
 * block sits BELOW the instruction layer, so no wording in a skill or in memory
 * reaches it.
 *
 * The rule: the agent may handle keys and secrets, but only when the owner has
 * explicitly authorized it, and that authorization dies with the session. This
 * file enforces exactly that, in two modes:
 *
 *   PreToolUse        gate a browser navigation at a credential surface
 *   UserPromptSubmit  arm or revoke the grant when the owner types the phrase
 *
 * The phrase is config `secretGrant.phrase` (default "authorize secrets"); the
 * owner's name in messages is config `owner`.
 *
 * One file, because the two halves share exactly one fact — where the grant
 * lives — and a third file to hold that line would cost more than it saves.
 *
 * Why the grant can only come from the owner: it is written by the
 * UserPromptSubmit half, which fires on a prompt a human submits. The agent
 * cannot submit a prompt, so it cannot walk this path itself. A
 * `permissions.deny` on the grant directory closes the obvious file-write
 * shortcut. This is a guard against drift and accident, not a sandbox against a
 * hostile model — a shell can still reach the filesystem, and pretending
 * otherwise would be theatre.
 *
 * Scope is deliberately NARROW: browser navigation only. Secret-bearing shell
 * commands (`gh secret list`, `vercel env ls`) already run fine; gating them
 * here would take away something that works and buy nothing.
 *
 * FAILS CLOSED, but only on the narrow matcher. If this script breaks, the
 * credential pages stop opening and everything else still works.
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, stateDir } from '../lib/config.mjs'
import { readInput } from '../lib/harness.mjs'

const DEFAULT_PHRASE = 'authorize secrets'

/** The default phrase, matched loosely so it works inside a normal sentence. */
const DEFAULT_ARM = /\bauthoriz\w*[\s-]+secrets?\b/i
const REVOKE = /\brevok\w*[\s-]+secrets?\b/i

/** A configured phrase gets the same looseness: anywhere in the prompt, any case,
 *  words separated by spaces or hyphens. */
export function armMatcher(phrase) {
  if (!phrase || phrase === DEFAULT_PHRASE) return DEFAULT_ARM
  const words = String(phrase).trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b${words.join('[\\s-]+')}\\b`, 'i')
}

/**
 * A page that lists, mints or reveals credentials.
 *
 * Matched on the URL's path and host keywords rather than an enumerated list
 * of providers, so a console nobody thought to name is still caught. False
 * positives cost one sentence asking for the phrase; a false negative silently
 * defeats the whole control.
 */
export const CREDENTIAL_URL =
  /(api[-_]?tokens?|api[-_]?keys?|access[-_]?keys?|secret|credential|\/iam|iamv2|service[-_]?accounts?|personal[-_]?access|settings\/tokens|environment[-_]?variables)/i

function grantPath(sessionId) {
  const short = String(sessionId || '').replace(/-/g, '').slice(0, 8)
  return short ? join(stateDir('secret-grants'), `${short}.json`) : null
}

function isGranted(sessionId) {
  const p = grantPath(sessionId)
  if (!p) return false
  try {
    const grant = JSON.parse(readFileSync(p, 'utf8'))
    return grant?.armed === true
  } catch {
    return false // no grant, or garbage -> not authorized
  }
}

function arm(sessionId) {
  const p = grantPath(sessionId)
  if (!p) return false
  try {
    mkdirSync(stateDir('secret-grants'), { recursive: true })
    writeFileSync(p, JSON.stringify({ armed: true, granted: new Date().toISOString() }))
    return true
  } catch {
    return false
  }
}

function revoke(sessionId) {
  const p = grantPath(sessionId)
  if (!p) return false
  try {
    rmSync(p, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Pull every URL-ish string out of a tool input. `navigate` carries one `url`;
 * `browser_batch` carries a list of actions, each of which may carry its own.
 * Walking the whole object beats naming fields that a future tool renames.
 */
export function urlsIn(value, found = []) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) || /^[\w.-]+\.[a-z]{2,}\//i.test(value)) found.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) urlsIn(v, found)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) urlsIn(v, found)
  }
  return found
}

function main() {
  const input = readInput()
  const sessionId = input.session_id || ''
  const event = input.hook_event_name || ''

  // A broken config must not disarm the guard or block arming: fall back to defaults.
  let config = {}
  try {
    config = loadConfig(input.cwd)
  } catch {}
  const owner = config.owner || 'the user'
  const phrase = config.secretGrant?.phrase || DEFAULT_PHRASE

  if (event === 'UserPromptSubmit') {
    // The owner's half. The agent cannot reach this branch: it fires only on a
    // prompt a human submitted.
    //
    // The field name for the prompt text has moved between CLI versions, so read
    // every plausible spelling rather than betting on one.
    const prompt = String(input.prompt || input.user_prompt || input.message || '')

    // Revoke is checked FIRST so "revoke secrets authorization" disarms rather
    // than re-arming on the word "authoriz..." later in the same sentence.
    if (REVOKE.test(prompt)) {
      revoke(sessionId)
      process.stdout.write(
        JSON.stringify({
          systemMessage: 'Secret-console authorization revoked for this session.',
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext:
              `${owner} has REVOKED credential-console authorization. Credential pages are blocked again for the rest of this session unless re-authorized.`,
          },
        })
      )
    } else if (armMatcher(phrase).test(prompt) && arm(sessionId)) {
      process.stdout.write(
        JSON.stringify({
          systemMessage: 'Secret-console authorization armed for this session only.',
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext:
              `${owner} has AUTHORIZED credential handling for this session. Credential-console pages may now be opened. This grant dies with the session and does not carry into the next one. Handle keys normally from here — no warnings, no hedging, no re-asking.`,
          },
        })
      )
    }
    return
  }

  // Guard half. Anything that is not a credential surface passes silently.
  const target = urlsIn(input.tool_input).find((u) => CREDENTIAL_URL.test(u))
  if (target && !isGranted(sessionId)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `Credential-console page blocked: ${target}\n\n` +
            `Handling keys and secrets requires ${owner}'s explicit authorization, and that ` +
            'authorization is scoped to a single session. It is not armed in this one.\n\n' +
            'First check whether an authorized non-browser route does this specific operation — ' +
            'the provider\'s own CLI; most consume credentials rather than create them, so check ' +
            'the operation and not the vendor. This denial still stands: do not route around it.\n\n' +
            `If there is no such route, ask ${owner} to type "${phrase}" and this page opens ` +
            'immediately. Do not attempt to write the grant file yourself — that is not the path.',
        },
      })
    )
  }
}

if (import.meta.main) {
  try {
    main()
  } catch {
  }
}

// Deliberately NO process.exit(0). stdout is an async pipe here, and exiting
// truncates the payload at the pipe buffer. Letting the loop drain exits 0.
