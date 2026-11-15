#!/usr/bin/env node
/**
 * Triage one issue, or sweep the unstamped ones, under the repository's own policy:
 * one tool-less model call per issue, and code that applies the verdict.
 *
 *   node scripts/triage-issue.mjs --issue <n> [--opened] [--dry-run]
 *   node scripts/triage-issue.mjs --sweep [--max <n>] [--dry-run]
 *
 * Run from inside the repository being triaged: it reads `.winston/config.json` (board,
 * triage.policy) and the policy file there. GitHub is reached through `gh` (GH_TOKEN), the
 * model through the claude CLI (CLAUDE_CODE_OAUTH_TOKEN). TRIAGE_MODEL overrides the model.
 *
 * Exit 0: done. Exit 1: at least one issue failed (named on stderr); the rest still ran.
 * Exit 2: the question could not be asked (no config, policy, board, or a bad argument);
 * nothing was written.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { loadConfig, repoRoot } from '../lib/config.mjs'
import { parseArgs } from '../lib/triage/args.mjs'
import { decide, model } from '../lib/triage/decide.mjs'
import { realGh } from '../lib/triage/github.mjs'
import { runTriage } from '../lib/triage/run.mjs'

function die(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 2
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    return die(e.message)
  }
  const root = repoRoot(process.cwd())
  if (!root) return die('not inside a git repository — nothing written')
  let config
  try {
    config = loadConfig(root)
  } catch (e) {
    return die(`${e.message} — nothing written`)
  }
  const policyName = config.triage?.policy ?? 'TRIAGE.md'
  const policyPath = resolve(root, String(policyName))
  if (isAbsolute(String(policyName)) || relative(root, policyPath).startsWith('..')) return die(`triage.policy must be a file inside the repository, got: ${policyName}`)
  let policy
  try {
    // The real path, so a symlink in the checkout cannot point the policy outside it.
    const real = realpathSync(policyPath)
    if (relative(realpathSync(root), real).startsWith('..')) return die(`triage.policy resolves outside the repository: ${policyName}`)
    policy = readFileSync(real, 'utf8')
  } catch {
    return die(`${policyName} not found: triage has no policy to apply — nothing written`)
  }
  let slug = process.env.GITHUB_REPOSITORY
  if (!slug) {
    try {
      slug = realGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim()
    } catch (e) {
      return die(`cannot tell which GitHub repository this is: ${e.message}`)
    }
  }
  // process.exitCode, never process.exit: on a pipe, stdout writes are asynchronous and an
  // exit drops whatever is still queued, and those lines are the whole report.
  process.exitCode = await runTriage(opts, {
    config, policy, policyName, slug, model: model(), runUrl: process.env.RUN_URL, gh: realGh, decide,
  })
}

main().catch((e) => die(e.stack || e.message))
