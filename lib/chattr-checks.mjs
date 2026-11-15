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
import { claudeEnabled, claudeInstalls, codexPluginsEnabled, configPaths, projectDir, separatePlugins } from '../chattr/hook/standdown.mjs'
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

/** Every plugin name with an installed_plugins.json record. */
function installedNames() {
  return Object.keys(json(configPaths(process.env).claudeInstalled)?.plugins ?? {})
}

/** The main checkout a worktree path belongs to: the part before /.claude/worktrees/ or /.worktrees/. */
export function mainCheckout(p) {
  const m = p.match(/^(.*?)\/\.(?:claude\/)?worktrees\//)
  return m ? m[1] : p
}

/**
 * Project- and local-scope installs of a chattr plugin outside `here`, grouped by main checkout:
 * [{ name, scope, main, entries, worktrees, enabledIn }], enabledIn being the main checkout's
 * settings files that turn it on.
 */
export function projectInstalls(here) {
  const record = json(configPaths(process.env).claudeInstalled)?.plugins ?? {}
  const groups = new Map()
  for (const [name, entries] of Object.entries(record)) {
    if (!name.startsWith('chattr@') || !Array.isArray(entries)) continue
    for (const e of entries) {
      if (!e?.projectPath || (e.scope !== 'project' && e.scope !== 'local')) continue
      if (typeof e.installPath !== 'string' || !existsSync(e.installPath)) continue
      const main = mainCheckout(e.projectPath)
      if (here && resolve(e.projectPath) === here) continue
      const key = `${name}\0${e.scope}\0${main}`
      if (!groups.has(key)) groups.set(key, { name, scope: e.scope, main, entries: [], worktrees: [], enabledIn: [] })
      const g = groups.get(key)
      g.entries.push(e)
      if (e.projectPath !== main) g.worktrees.push({ path: e.projectPath })
    }
  }
  for (const g of groups.values()) {
    for (const f of ['settings.json', 'settings.local.json'].map((x) => join(g.main, '.claude', x))) {
      if (json(f)?.enabledPlugins?.[g.name] === true) g.enabledIn.push(f)
    }
  }
  return [...groups.values()].sort((a, b) => a.main.localeCompare(b.main))
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

  // 2. The separate chattr plugin, for this repository (user settings plus this project's own).
  // Only one whose files are still on disk counts: that is what stands Winston's copy down.
  const cwd = layers?.root ?? process.cwd()
  const here = projectDir(cwd)
  const claudeSettings = json(paths.claudeSettings)
  // The uninstall scope comes from the install records, not from the settings layer that enables
  // it: a project install turned on in user settings still needs -s project, run in the project.
  const uninstallFor = (e) => {
    const installs = (claudeInstalls(e.name, process.env) ?? []).filter((i) => existsSync(i.installPath))
    const cmds = [...new Set(installs.flatMap((i) => {
      if (i.scope === 'user' || !i.scope) return [`claude plugin uninstall ${e.name}`]
      return i.projectPath && resolve(i.projectPath) === here ? [`cd ${tilde(here)} && claude plugin uninstall ${e.name} -s ${i.scope}`] : []
    }))]
    return cmds.length ? cmds.join(' && ') : `claude plugin uninstall ${e.name}`
  }
  const byHandFor = (e) => `delete the line "${e.name}": true under enabledPlugins in ${tilde(e.file)}${e.scope === 'project' ? ' (a committed file: commit that change in the repository, or ask its owner to)' : ''}`
  const codexByHand = (n) => `delete the "${n}" entry from ${tilde(paths.codexConfig)}: its [plugins."${n}"] table, or the line that names it`
  const claudeOn = separatePlugins('claude', process.env, cwd)
  const projectNote = claudeOn.some((e) => uninstallFor(e).includes(' -s project'))
    ? [`"-s project" also deletes the line from ${tilde(join(here, '.claude', 'settings.json'))}, a committed file: commit that change${mainCheckout(here) !== here ? ` (this is a worktree; make the change in ${tilde(mainCheckout(here))} instead, and this worktree picks it up when it merges)` : ''}.`]
    : []
  const codexOn = separatePlugins('codex', process.env, cwd)
  const plugin = [
    ...claudeOn.map((e) => ({ app: 'Claude Code', cmd: uninstallFor(e), byHand: byHandFor(e) })),
    ...codexOn.map((e) => ({ app: 'Codex', cmd: `codex plugin remove ${e.name}`, byHand: codexByHand(e.name) })),
  ]
  add({
    name: 'separate chattr plugin',
    state: plugin.length ? 'off' : 'ok',
    detail: plugin.length ? `still installed in ${[...new Set(plugin.map((p) => p.app))].join(' and ')}; chattr is part of Winston now` : 'not installed; chattr comes with Winston',
    problem: plugin.length > 0 && 'remove the separate chattr plugin',
    command: plugin.length ? plugin.map((p) => p.cmd).join(' && ') : undefined,
    fixLines: plugin.length > 0 && [
      'chattr is part of Winston now. While the separate plugin is installed, Winston\'s own copy of its hooks stays off and the old copy runs instead. Remove it:',
      ...plugin.map((p) => `  ${p.app}: ${p.cmd}   (if that fails, ${p.byHand})`),
      ...projectNote,
      restart,
    ],
  })

  // 2b. Enabled, but its files are gone (the marketplace no longer lists chattr). Winston's copy
  // runs; the leftover entry would silence it again if the files came back.
  const leftover = [
    ...claudeEnabled(process.env, cwd).filter((e) => !claudeOn.some((o) => o.name === e.name)).map((e) => ({ app: 'Claude Code', name: e.name, cmd: uninstallFor(e), byHand: byHandFor(e) })),
    ...codexPluginsEnabled(read(paths.codexConfig)).filter((n) => !codexOn.some((o) => o.name === n)).map((n) => ({ app: 'Codex', name: n, cmd: `codex plugin remove ${n}`, byHand: codexByHand(n) })),
  ]
  if (leftover.length) {
    add({
      name: 'chattr plugin left enabled',
      state: 'off',
      detail: `${[...new Set(leftover.map((p) => p.app))].join(' and ')} still list${leftover.length === 1 ? 's' : ''} ${leftover.map((p) => p.name).join(', ')} as enabled, but its files are gone`,
      problem: 'remove the leftover chattr plugin entry',
      command: leftover.map((p) => p.cmd).join(' && '),
      fixLines: [
        'The separate chattr plugin is gone, but the app still lists it as enabled. Winston\'s copy of chattr runs now; remove the entry so nothing can switch it off again:',
        ...leftover.map((p) => `  ${p.app}: ${p.cmd}   (if that reports the plugin missing, ${p.byHand})`),
        restart,
      ],
    })
  }

  // 2c. Installed with its files on disk, but enabled nowhere that applies here: Claude does not
  // load it. Harmless today; enabling it again would switch Winston's copy off.
  const userInstalls = (name) => (claudeInstalls(name, process.env) ?? []).filter((e) => (e.scope === 'user' || !e.scope) && existsSync(e.installPath))
  const names = new Set([...Object.keys(claudeSettings?.enabledPlugins ?? {}), ...installedNames()].filter((n) => n.startsWith('chattr@')))
  const dormant = [...names].filter((n) => userInstalls(n).length && !claudeEnabled(process.env, cwd).some((e) => e.name === n))
  if (dormant.length) {
    add({
      name: 'chattr plugin installed but off',
      state: 'off',
      detail: `${dormant.join(', ')} is installed for your user but not turned on, so Claude Code does not load it`,
      problem: 'uninstall the unused chattr plugin',
      command: dormant.map((n) => `claude plugin uninstall ${n}`).join(' && '),
      fixLines: [
        'The separate chattr plugin is still installed, though turned off. Turning it back on would switch Winston\'s copy of chattr off, so remove it:',
        ...dormant.map((n) => `  claude plugin uninstall ${n}`),
      ],
    })
  }

  // 2d. Project-scope installs, grouped by main checkout (this repository's worktrees included;
  // this checkout itself is row 2). `claude plugin uninstall -s project` also rewrites the
  // committed .claude/settings.json, so the guidance never fans out across worktrees: one change
  // in the main checkout, which each worktree picks up when it next merges or pulls.
  const groups = projectInstalls(here)
  const active = groups.filter((g) => g.enabledIn.length)
  if (groups.length) {
    const lines = []
    if (active.length) lines.push('These repositories turn the separate chattr plugin on in their own settings. In a session there, Winston\'s copy of chattr stays off and the old copy runs.')
    for (const g of groups) {
      const alive = g.worktrees.filter((w) => existsSync(w.path)).length
      lines.push('', `  ${tilde(g.main)}${g.worktrees.length ? `  (install records for ${g.worktrees.length} of its worktrees, ${alive} still on disk)` : ''}`)
      for (const f of g.enabledIn) {
        if (f.endsWith('/settings.json')) {
          lines.push(
            `    One change, by whoever owns that repository: in ${tilde(f)}, delete the line "${g.name}": true under enabledPlugins, and commit it.`,
            `    (Running "cd ${tilde(g.main)} && claude plugin uninstall ${g.name} -s ${g.scope}" once does the same edit to that committed file and clears the main checkout's record; the change still needs committing.)`,
          )
        } else {
          lines.push(`    ${tilde(f)} (not committed) turns it on: delete the line "${g.name}": true under enabledPlugins there.`)
        }
      }
      if (g.worktrees.length) {
        lines.push(g.enabledIn.length
          ? `    Change nothing in the worktrees. Each picks the change up when it next merges or pulls the branch that has it; until then a session there still runs the old copy.`
          : `    The setting is gone, so these records do nothing.`)
        lines.push(`    A leftover record is harmless once no settings turn the plugin on, your user settings included. To clear one, run "claude plugin uninstall ${g.name} -s ${g.scope}" in that worktree only after it has the change: then it removes the record and leaves tracked files alone.`)
      }
    }
    if (active.length) lines.push('', 'Then restart the Claude Code sessions in those repositories.')
    add({
      name: 'chattr plugin installed in repositories',
      state: 'off',
      detail: active.length
        ? `turned on in ${active.map((g) => tilde(g.main)).join(', ')}`
        : `${groups.reduce((n, g) => n + g.entries.length, 0)} leftover install records, harmless: no settings turn it on`,
      problem: active.length > 0 && 'turn the separate chattr plugin off in those repositories',
      fixLines: active.length > 0 && lines,
    })
  }

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
