#!/usr/bin/env node
/**
 * update-check — tell a new session when a newer Winston is out, and how to get it.
 *
 * SessionStart, new sessions only. It asks the network at most once a day (lib/update.mjs
 * caches the answer) and gives up after three seconds, so a slow or absent network costs a
 * session nothing more than that, once. When the installed version is current, or the
 * latest cannot be read, it says nothing.
 *
 * It never updates: that swaps hooks and skills under running sessions and needs a
 * restart. The notice goes to the user (systemMessage) and to the session
 * (additionalContext), which is asked to pass on the update steps.
 *
 * Off in CI, and with config `updateCheck: false` (either layer).
 */

import { loadConfig } from '../lib/config.mjs'
import { harness, readInput } from '../lib/harness.mjs'
import { installScope, latestVersion, updateNotice } from '../lib/update.mjs'

async function main() {
  if (process.env.CI || process.env.GITHUB_ACTIONS) return
  const input = readInput()
  if (input.source && input.source !== 'startup') return
  const cwd = input.cwd || process.cwd()
  try {
    if (loadConfig(cwd).updateCheck === false) return
  } catch {
  }
  const who = harness(input)
  const notice = updateNotice(await latestVersion({ timeoutMs: 3000 }), who, who === 'claude' ? installScope(cwd) : 'user')
  if (!notice) return
  process.stdout.write(JSON.stringify({
    systemMessage: notice,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${notice} Tell the user this, with the exact update steps, in your first reply; then carry on with what they asked.` },
  }))
}

try {
  await main()
} catch {
}
