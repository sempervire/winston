/**
 * The one config loader every hook and the CLI share.
 *
 *   user layer  ~/.winston/config.json            (WINSTON_HOME overrides ~/.winston)
 *   repo layer  <git toplevel of cwd>/.winston/config.json
 *
 * Shallow merge per top-level key, repo wins: a repo's `worktree` replaces the
 * user's `worktree` whole, it is not merged into it.
 *
 * A missing file is {}. A file that exists but does not parse THROWS, naming the
 * path: whether a broken config fails open or closed is the caller's decision,
 * and a deploy gate must not mistake "unreadable" for "not configured".
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function winstonHome() {
  return process.env.WINSTON_HOME || join(homedir(), '.winston')
}

/** Where per-session hook state lives: markers, grants, sidecars. */
export function stateDir(name) {
  return join(winstonHome(), 'state', name)
}

export function repoRoot(cwd) {
  try {
    return execFileSync('git', ['-C', cwd || '.', 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null
  } catch {
    return null
  }
}

function readLayer(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { path, loaded: false, data: {} }
    throw new Error(`winston config: cannot read ${path}: ${e.message}`)
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    throw new Error(`winston config: ${path} is not valid JSON: ${e.message}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`winston config: ${path} must hold a JSON object`)
  }
  return { path, loaded: true, data }
}

/** Both layers, unmerged, for callers that care which layer said what. */
export function loadLayers(cwd = process.cwd()) {
  const root = repoRoot(cwd)
  return {
    root,
    user: readLayer(join(winstonHome(), 'config.json')),
    repo: root ? readLayer(join(root, '.winston', 'config.json')) : { path: null, loaded: false, data: {} },
  }
}

/** The merged config for cwd. */
export function loadConfig(cwd = process.cwd()) {
  const { user, repo } = loadLayers(cwd)
  return { ...user.data, ...repo.data }
}
