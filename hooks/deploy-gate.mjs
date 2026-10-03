#!/usr/bin/env node
/**
 * deploy-gate — only a session the owner approved deploys production.
 *
 *   UserPromptSubmit  the owner's whole prompt is the configured phrase -> write a
 *                     marker keyed by session_id.
 *   PreToolUse        deny a guarded action unless that marker exists:
 *     pr-merge        `gh pr merge` of a PR whose base is the configured branch
 *     workflow-run    `gh workflow run <w>` or a `gh api .../workflows/<w>/dispatches`
 *                     call, where <w> matches the configured regex (file, path,
 *                     display name or numeric ID — gh accepts all of them)
 *
 * Configured by the repo layer's `deployGate` (.winston/config.json):
 *
 *   { "phrase": "approve production deploy",
 *     "repo": "owner/name",                      // optional, see Scope
 *     "guarded": [ { "kind": "pr-merge", "base": "main" },
 *                  { "kind": "workflow-run", "workflow": "deploy(\\.ya?ml)?" } ] }
 *
 * One file: both halves share one fact, where the marker lives.
 *
 * A guard against accidental or unapproved deploys, NOT access control: every
 * session holds the same credential, which reaches GitHub directly (`gh api`,
 * curl), and a shell can write the marker. Claude cannot submit a prompt, so the
 * honest path to a marker is the owner typing the phrase.
 *
 * Scope: a gated command is judged when the repo it runs in has a deployGate —
 * the cwd's repo, and the directory of any `cd` inside the command. When the gate
 * names `repo`, a command aimed elsewhere with -R/--repo or GH_REPO passes.
 * With no deployGate anywhere the hook is inert.
 *
 * FAILS CLOSED on a gated command: an unreadable PR base, or an unreadable repo
 * config, is a denial. Anything that is not a gated command passes, so a broken
 * hook stops deploys only.
 *
 * Markers live in ~/.winston/state/deploy-approvals (WINSTON_HOME moves it).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { loadConfig, loadLayers, stateDir } from '../lib/config.mjs'
import { readInput, shellCommand } from '../lib/harness.mjs'

const DEFAULT_PHRASE = 'approve production deploy'

function markerPath(sessionId) {
  const id = String(sessionId || '').replace(/[^\w-]/g, '')
  return id ? join(stateDir('deploy-approvals'), id) : null
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The WHOLE prompt, not a substring: the denial message quotes the phrase, so a
 *  pasted transcript must not approve. Optional quotes and one trailing . or !. */
export function phraseMatcher(phrase = DEFAULT_PHRASE) {
  const words = String(phrase).trim().toLowerCase().split(/\s+/).map(escapeRe).join(' ')
  return new RegExp(`^["'“”‘’]?${words}[.!]?["'“”‘’]?$`)
}

/** The configured workflow regex, anchored to a whole name or a path's last part. */
function workflowMatcher(source) {
  return new RegExp(`^(?:.*/)?(?:${source})$`, 'i')
}

/** Shell-ish split into command segments of tokens. Quotes are honoured; a quoted
 *  string handed to a shell (bash -c "...", eval "...") is scanned again by
 *  gatedCommands, so wrapping does not hide it. Other quoted text (a grep pattern,
 *  a --body) is data and is not scanned. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
// A heredoc body is data unless the heredoc feeds a shell (bash <<EOF), so drop it.
const HEREDOC = /<<-?[ \t]*(['"]?)([\w.-]+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g

function dropDataHeredocs(command) {
  return command.replace(HEREDOC, (m, _q, tag, offset) => {
    const line = command.slice(command.lastIndexOf('\n', offset) + 1, offset)
    const head = line.split(/[;&|(]/).pop().trim().split(/\s+/)[0] || ''
    return SHELLS.has(basename(head)) ? m : `<<${tag}`
  })
}

export function segments(command) {
  const out = [[]]
  let tok = null
  let quote = null
  const push = () => {
    if (tok !== null) out[out.length - 1].push(tok)
    tok = null
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) tok += command[++i]
      else tok += c
    } else if (c === '"' || c === "'") {
      quote = c
      tok ??= ''
    } else if (c === '\\' && i + 1 < command.length) {
      tok = (tok ?? '') + command[++i]
    } else if (/\s/.test(c) && c !== '\n') {
      push()
    } else if (/[;&|\n()`]/.test(c) || (c === '$' && command[i + 1] === '(')) {
      push()
      out.push([])
    } else {
      tok = (tok ?? '') + c
    }
  }
  push()
  return out.filter((s) => s.length)
}

const MERGE_VALUE_FLAGS = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '--match-head-commit', '-A', '--author-email'])

/** Every gated gh call in a command, against one gate's guarded list:
 *  { kind: 'workflow-run', workflow } or { kind: 'pr-merge', selector, repo }. */
export function gatedCommands(command, guarded = [], found = []) {
  const workflows = guarded.filter((g) => g.kind === 'workflow-run' && g.workflow).map((g) => workflowMatcher(g.workflow))
  const merges = guarded.some((g) => g.kind === 'pr-merge')
  for (const seg of segments(dropDataHeredocs(String(command || '')))) {
    // Any position, so `sudo bash -c` and `env X=1 eval` count too.
    const shellAt = seg.findIndex((t) => SHELLS.has(basename(t)))
    const evalAt = seg.indexOf('eval')
    seg.forEach((t, i) => {
      const toShell = (evalAt !== -1 && i > evalAt) || (shellAt !== -1 && i > shellAt && /^-\w*c$/.test(seg[i - 1]))
      if (toShell && /[\s;&|]/.test(t)) gatedCommands(t, guarded, found)
    })
    const at = seg.findIndex((t) => basename(t) === 'gh')
    if (at === -1) continue
    const args = seg.slice(at + 1)
    let repo = null
    const words = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      const eq = a.match(/^(--[\w-]+)=(.*)$/)
      const flag = eq ? eq[1] : a
      if (flag === '-R' || flag === '--repo') {
        repo = eq ? eq[2] : args[++i]
      } else if (a.startsWith('-R') && a.length > 2) {
        repo = a.slice(2)
      } else if (!eq && MERGE_VALUE_FLAGS.has(a)) {
        i++
      } else if (!a.startsWith('-')) {
        words.push(a) // includes values of flags not listed above; harmless
      }
    }
    const [w0, w1, ...rest] = words
    const dispatched = (w) => {
      const m = w.match(/\/actions\/workflows\/([^/]+)\/dispatches/i)
      if (!m) return null
      try {
        return decodeURIComponent(m[1])
      } catch {
        return m[1]
      }
    }
    const isGuarded = (name) => workflows.some((re) => re.test(name))
    if (w0 === 'workflow' && w1 === 'run') {
      const w = rest.find(isGuarded)
      if (w) found.push({ kind: 'workflow-run', workflow: w, repo })
    } else if (w0 === 'api' && words.some((w) => isGuarded(dispatched(w) ?? ''))) {
      found.push({ kind: 'workflow-run', workflow: words.map(dispatched).find((w) => w && isGuarded(w)), repo })
    } else if (merges && w0 === 'pr' && w1 === 'merge') {
      found.push({ kind: 'pr-merge', selector: rest[0] ?? null, repo })
    }
  }
  return found
}

/** Directories a command `cd`s into, resolved against the hook's cwd. */
export function cdTargets(command, cwd) {
  const out = []
  for (const seg of segments(String(command || ''))) {
    const at = seg.indexOf('cd')
    const dir = at !== -1 ? seg[at + 1] : null
    if (dir && dir !== '-') out.push(resolve(cwd || '.', dir.replace(/^~(?=$|\/)/, homedir())))
  }
  return out
}

/** Read-only. Returns the base branch name, or null if it cannot be determined. */
function prBase({ selector, repo }, cwd) {
  const args = ['pr', 'view', ...(selector ? [selector] : []), '--json', 'baseRefName', '-q', '.baseRefName']
  if (repo) args.push('-R', repo)
  try {
    return execFileSync('gh', args, { cwd: cwd || undefined, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

function deny(reason, owner, phrase) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `${reason}\n\nProduction deploys need ${owner}'s approval in THIS session. Ask ${owner} to type ` +
          `"${phrase}" and retry. Do not write the marker yourself or route ` +
          'around this with `gh api` or another client: that is not the path.',
      },
    })
  )
}

/** The repo-layer gate for a directory: { gate, dir }, null when it has none,
 *  or { error } when its config cannot be read. */
function gateFor(dir) {
  try {
    const gate = loadLayers(dir).repo.data.deployGate
    return gate ? { gate, dir } : null
  } catch (e) {
    return { error: e.message, dir }
  }
}

function main() {
  const input = readInput()
  const marker = markerPath(input.session_id)

  if ((input.hook_event_name || '') === 'UserPromptSubmit') {
    if (!marker) return
    const found = gateFor(input.cwd)
    if (!found?.gate) return
    const prompt = String(input.prompt || input.user_prompt || input.message || '')
    if (!phraseMatcher(found.gate.phrase).test(prompt.trim().toLowerCase())) return
    mkdirSync(stateDir('deploy-approvals'), { recursive: true })
    writeFileSync(marker, JSON.stringify({ approved: new Date().toISOString() }))
    let owner = 'The owner'
    try {
      owner = loadConfig(input.cwd).owner || owner
    } catch {}
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `${owner} approved production deploys for this session: the guarded merges and workflow dispatches may run.`,
        },
      })
    )
    return
  }

  const command = shellCommand(input.tool_input)
  if (!/\bgh\b/.test(command) || (marker && existsSync(marker))) return

  // Every repo this command may act in: the cwd, then each `cd` target.
  const gates = [input.cwd, ...cdTargets(command, input.cwd)].map(gateFor).filter(Boolean)
  if (!gates.length) return

  // An unreadable repo config cannot say what is guarded, so treat every merge
  // and every dispatch as guarded (fails closed).
  const broken = gates.find((g) => g.error)
  if (broken) {
    const any = gatedCommands(command, [{ kind: 'pr-merge' }, { kind: 'workflow-run', workflow: '.+' }])
    if (any.length) deny(`Blocked: the deploy gate cannot read its config (fails closed). ${broken.error}`, 'the owner', DEFAULT_PHRASE)
    return
  }

  // Which repo `gh` really targets: -R, else GH_REPO, else the directory it runs in.
  const envRepo = command.match(/GH_REPO=["']?([^\s"';&|]+)/)?.[1]
  let owner = 'the owner'
  try {
    owner = loadConfig(input.cwd).owner || owner
  } catch {}

  for (const { gate, dir } of gates) {
    const phrase = gate.phrase || DEFAULT_PHRASE
    const guarded = Array.isArray(gate.guarded) ? gate.guarded : []
    try {
      for (const g of gatedCommands(command, guarded)) {
        const repo = g.repo ?? envRepo ?? null
        if (gate.repo && repo && repo.toLowerCase() !== String(gate.repo).toLowerCase()) continue
        if (g.kind === 'workflow-run') {
          return deny(`Blocked: dispatching ${g.workflow} is a guarded production action.`, owner, phrase)
        }
        const pr = g.selector ?? '(current branch)'
        const base = prBase({ ...g, repo: repo ?? gate.repo ?? null }, dir)
        if (!base) return deny(`Blocked: could not read the base branch of PR ${pr}, so a guarded merge cannot be ruled out (fails closed).`, owner, phrase)
        const bases = guarded.filter((x) => x.kind === 'pr-merge').map((x) => x.base)
        if (bases.some((b) => !b || b === base)) return deny(`Blocked: PR ${pr} merges into ${base}, a production deploy.`, owner, phrase)
      }
    } catch {
      return deny('Blocked: the deploy gate failed while checking this command (fails closed).', owner, phrase)
    }
  }
}

if (import.meta.main) {
  try {
    main()
  } catch {
  }
}
// No process.exit(0): let stdout drain naturally.
