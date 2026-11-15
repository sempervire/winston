/**
 * Doctor's rows for chattr, which is part of Winston (chattr/, bin/chattr).
 *
 * The rows find what makes chattr's hooks run twice or not at all, and give the exact removal step:
 *   - the separate chattr plugin still enabled in Claude Code or Codex
 *   - the old chattr install.sh hooks in ~/.claude/settings.json or ~/.codex/hooks.json
 *   - a ~/.local/bin/chattr link to a separate chattr copy
 *   - Codex's sandbox unable to write the message store (writable_roots)
 * plus the shared-checkout guard's on/off state and the Node version every hook runs on.
 * Winston's bundled hooks stand down while either of the first two is present
 * (chattr/hook/standdown.mjs), so until they are removed the separate copy is what runs.
 *
 * Read-only. Paths follow HOME, CLAUDE_CONFIG_DIR and CODEX_HOME.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { configPaths, separatePlugins } from '../chattr/hook/standdown.mjs'
import { legacyCommands } from '../chattr/hook/install.mjs'

export const MIN_NODE = 24

const home = () => process.env.HOME || homedir()
const tilde = (p) => (p.startsWith(home() + '/') ? `~${p.slice(home().length)}` : p)

function read(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function json(file) {
  const text = read(file)
  if (text == null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The paths in [sandbox_workspace_write] writable_roots of config.toml text; the array may span lines. */
export function writableRoots(toml) {
  let inTable = false
  let collecting = null
  for (const raw of String(toml ?? '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (collecting !== null) {
      collecting += ` ${line}`
      if (line.includes(']')) break
      continue
    }
    const header = line.match(/^\[([^\]]+)\]$/)
    if (header) {
      inTable = header[1].trim() === 'sandbox_workspace_write'
      continue
    }
    const m = inTable && line.match(/^writable_roots\s*=\s*\[(.*)$/)
    if (m) {
      collecting = m[1]
      if (m[1].includes(']')) break
    }
  }
  if (collecting === null) return []
  return [...collecting.split(']')[0].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2])
}

/** Major version of the `node` every hook command runs (the one on PATH), or null. */
export function nodeMajor(run = () => spawnSync('node', ['--version'], { encoding: 'utf8' })) {
  const r = run()
  const m = r.status === 0 && String(r.stdout).trim().match(/^v(\d+)\./)
  return m ? { major: Number(m[1]), version: String(r.stdout).trim() } : null
}

/**
 * Doctor check objects (see `checks` in bin/winston for the shape).
 * `root` is this Winston install; `layers` is loadLayers(cwd), for the guard's switch.
 */
export function chattrChecks({ root, layers, node = nodeMajor() }) {
  const out = []
  const add = (c) => out.push({ required: false, scope: 'you', detail: '', ...c })
  const paths = configPaths(process.env)
  const restart = 'Then restart every Claude Code and Codex session, so each loads only Winston\'s copy of the hooks.'

  // 1. Node: every hook, chattr's store (node:sqlite) included, runs on the `node` on PATH.
  add({
    name: 'Node.js version',
    required: true,
    state: node && node.major >= MIN_NODE ? 'ok' : 'missing',
    detail: node ? `${node.version}${node.major >= MIN_NODE ? '' : `; Winston needs ${MIN_NODE} or later`}` : 'node is not on PATH',
    hand: `install Node.js ${MIN_NODE} or later (https://nodejs.org, or: brew install node), then open a new terminal`,
  })

  // 2. The separate chattr plugin, in each app.
  // Only one whose files are still on disk counts: that is what stands Winston's copy down.
  const claudeSettings = json(paths.claudeSettings)
  const claudeOn = separatePlugins('claude', process.env)
  const codexOn = separatePlugins('codex', process.env)
  const plugin = [
    ...claudeOn.map((n) => ({ app: 'Claude Code', cmd: `claude plugin uninstall ${n}` })),
    ...codexOn.map((n) => ({ app: 'Codex', cmd: `codex plugin remove ${n}` })),
  ]
  add({
    name: 'separate chattr plugin',
    state: plugin.length ? 'off' : 'ok',
    detail: plugin.length ? `still installed in ${[...new Set(plugin.map((p) => p.app))].join(' and ')}; chattr is part of Winston now` : 'not installed; chattr comes with Winston',
    problem: plugin.length > 0 && 'remove the separate chattr plugin',
    command: plugin.length ? plugin.map((p) => p.cmd).join(' && ') : undefined,
    fixLines: plugin.length > 0 && [
      'chattr is part of Winston now. While the separate plugin is installed, Winston\'s own copy of its hooks stays off and the old copy runs instead. Remove it:',
      ...plugin.map((p) => `  ${p.app}: ${p.cmd}`),
      restart,
    ],
  })

  // 3. The old install.sh registrations.
  const legacy = [
    { file: paths.claudeSettings, config: claudeSettings },
    { file: paths.codexHooks, config: json(paths.codexHooks) },
  ].filter((f) => legacyCommands(f.config).length)
  const uninstall = `node "${join(root, 'chattr', 'chattr.mjs')}" uninstall-hooks`
  const backup = '~/chattr-hooks-backup'
  add({
    name: 'old chattr install.sh hooks',
    state: legacy.length ? 'off' : 'ok',
    detail: legacy.length ? `registered in ${legacy.map((f) => tilde(f.file)).join(' and ')}` : 'none',
    problem: legacy.length > 0 && 'remove the old chattr hooks',
    command: legacy.length ? `${uninstall} --snapshot ${backup}` : undefined,
    fixLines: legacy.length > 0 && [
      'An earlier chattr install wrote its hooks straight into these files. While they are there, Winston\'s own copy stays off. Remove only those entries (every other hook stays):',
      `  First look: ${uninstall} --dry-run   (prints the exact change, writes nothing)`,
      `  Then: ${uninstall} --snapshot ${backup}   (keeps a copy of each file it changes)`,
      restart,
    ],
  })

  // 4. A ~/.local/bin/chattr link to a copy other than this Winston's.
  const link = join(home(), '.local', 'bin', 'chattr')
  let target = null
  try {
    if (lstatSync(link)) target = lstatSync(link).isSymbolicLink() ? resolve(join(link, '..'), readlinkSync(link)) : link
  } catch {}
  const own = target && [join(root, 'bin', 'chattr'), join(root, 'chattr', 'chattr.mjs')].includes(target)
  add({
    name: 'stray chattr command',
    state: target && !own ? 'off' : 'ok',
    detail: !target ? 'none' : own ? `${tilde(link)} is this Winston's` : `${tilde(link)} runs ${tilde(target)}, a separate copy`,
    problem: target && !own && `remove ${tilde(link)}`,
    command: target && !own ? `rm ${tilde(link)}` : undefined,
    fixLines: target && !own && [
      `${tilde(link)} runs a separate copy of chattr (${tilde(target)}), which will drift from the one in Winston. Remove it:`,
      `  rm ${tilde(link)}`,
      `Sessions are told the path of Winston's chattr when they start; in Claude Code it is also on PATH as chattr.`,
    ],
  })

  // 5. Codex's sandbox must be allowed to write the message store, or claims and messages fail inside it.
  const codexDir = join(paths.codexConfig, '..')
  if (existsSync(codexDir)) {
    const store = join(home(), '.agent-bridge')
    const roots = writableRoots(read(paths.codexConfig))
    const ok = roots.some((r) => resolve(r.replace(/^~(?=\/|$)/, home())) === store)
    add({
      name: 'Codex can write the chattr store',
      state: ok ? 'ok' : 'off',
      detail: ok ? `${tilde(store)} is in writable_roots` : `${tilde(store)} is not in writable_roots in ${tilde(paths.codexConfig)}`,
      problem: !ok && `let Codex write ${tilde(store)}`,
      fixLines: !ok && [
        `Inside its sandbox Codex cannot write ${tilde(store)}, so chattr claims and messages fail there. Add it to ${tilde(paths.codexConfig)}:`,
        '  [sandbox_workspace_write]',
        `  writable_roots = [${JSON.stringify(store)}]`,
        'If that table already has a writable_roots line, add the path to the list instead. Then restart Codex sessions.',
      ],
    })
  }

  // 6. The shared-checkout guard: on unless the owner turned it off.
  const where = [layers?.repo, layers?.user].find((l) => l?.loaded && 'sharedCheckoutGuard' in l.data)
  const off = where?.data.sharedCheckoutGuard === false
  add({
    name: 'shared-checkout guard',
    state: off ? 'off' : 'on',
    detail: off
      ? `turned off in ${tilde(where.path)}: two sessions can edit the same folder`
      : 'blocks an edit while another session works in the same folder; to turn it off, set "sharedCheckoutGuard": false in .winston/config.json',
  })
  return out
}
