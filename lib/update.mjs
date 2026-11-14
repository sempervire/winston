/**
 * Is a newer Winston out? Shared by `winston doctor` and the update-check hook. Both
 * use the cached answer, so GitHub is asked at most once a day.
 *
 * "Latest" is the version in the plugin manifest on the marketplace repository's main
 * branch, which is what `claude plugin update` installs. The answer is cached under
 * ~/.winston/state/update-check/ so a session start does not wait on the network.
 * Nothing here updates anything: an update swaps hooks and skills and needs a restart,
 * so it stays the user's act. This only says one exists, and how to take it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stateDir } from './config.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARKETPLACE = 'winston'
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

const manifest = () => JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))

export const installedVersion = () => manifest().version

const VERSION = /^\d+(\.\d+)*$/

/** True when version `a` is newer than `b`; false when either is not a dotted number. */
export function newer(a, b) {
  if (!VERSION.test(a ?? '') || !VERSION.test(b ?? '')) return false
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

/** Where the latest manifest is read from. WINSTON_UPDATE_URL overrides it (tests, mirrors). */
function manifestUrl() {
  if (process.env.WINSTON_UPDATE_URL) return process.env.WINSTON_UPDATE_URL
  const repo = String(manifest().repository ?? '').match(/github\.com\/([^/]+\/[^/.]+)/)?.[1]
  return repo ? `https://raw.githubusercontent.com/${repo}/main/.claude-plugin/plugin.json` : null
}

/** The latest version, or null when it cannot be read in time. Never throws. */
export async function fetchLatest(timeoutMs = 3000) {
  try {
    const url = manifestUrl()
    if (!url) return null
    const text = url.startsWith('file:')
      ? readFileSync(fileURLToPath(url), 'utf8')
      : await (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).text()
    const version = JSON.parse(text).version
    return VERSION.test(version ?? '') ? version : null
  } catch {
    return null
  }
}

const cachePath = () => join(stateDir('update-check'), 'latest.json')

function readCache() {
  try {
    const c = JSON.parse(readFileSync(cachePath(), 'utf8'))
    return typeof c.checkedAt === 'number' ? c : null
  } catch {
    return null
  }
}

function writeCache(latest) {
  try {
    mkdirSync(dirname(cachePath()), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify({ checkedAt: Date.now(), latest }))
  } catch {
  }
}

/**
 * The latest version. `fresh: true` asks the network now; otherwise a cached answer
 * under a day old is used, and a failed lookup is not retried for an hour.
 */
export async function latestVersion({ fresh = false, timeoutMs } = {}) {
  const c = fresh ? null : readCache()
  if (c && Date.now() - c.checkedAt < (c.latest ? DAY : HOUR)) return c.latest
  const latest = await fetchLatest(timeoutMs)
  writeCache(latest)
  return latest
}

/** 'project' when the running copy is this project's own install, else 'user'. Claude Code only. */
export function installScope(cwd) {
  try {
    const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'installed_plugins.json')
    const entries = JSON.parse(readFileSync(file, 'utf8')).plugins?.[`${manifest().name}@${MARKETPLACE}`] ?? []
    const here = resolve(cwd)
    const mine = (e) => resolve(e.installPath ?? '') === ROOT
    if (entries.some((e) => e.scope === 'project' && mine(e) && (here === resolve(e.projectPath ?? '') || here.startsWith(resolve(e.projectPath ?? '') + '/')))) return 'project'
  } catch {
  }
  return 'user'
}

/** How to update, as one line a person can follow. */
export function updateSteps(harness = 'claude', scope = 'user') {
  const id = `${manifest().name}@${MARKETPLACE}`
  if (harness === 'codex') return `run \`codex plugin marketplace upgrade ${MARKETPLACE}\`, then \`codex plugin add ${id}\`, and start a new Codex session`
  const project = scope === 'project' ? ' --scope project' : ''
  return `run \`claude plugin marketplace update ${MARKETPLACE} && claude plugin update ${id}${project}\`${project ? ' from this project\'s directory' : ''}, then restart Claude Code (inside a session, type it after \`!\`, or use /plugin)`
}

/** The notice, or null when the installed version is current or the latest is unknown. */
export function updateNotice(latest, harness, scope) {
  const have = installedVersion()
  if (!newer(latest, have)) return null
  return `Winston ${latest} is available; ${have} is installed. To update, ${updateSteps(harness, scope)}.`
}

// Run directly: print the latest version as JSON, from the cache when it is under a day
// old (`--fresh` asks the network now). `winston doctor` is synchronous, so it reads the
// answer from this child process.
if (import.meta.main) {
  process.stdout.write(JSON.stringify({ latest: await latestVersion({ fresh: process.argv.includes('--fresh'), timeoutMs: 5000 }) }))
}
