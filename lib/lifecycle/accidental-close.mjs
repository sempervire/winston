/** Pure decision and executor for an issue closed outside production. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolveIssueReferences } from './resolvers.mjs'

export function productionEvidence({ mergedProduction = false, inProductionRange = false } = {}) {
  return Boolean(mergedProduction || inProductionRange)
}

export function isExempt({ labels = [], closeReason = '' } = {}) {
  const exempt = new Set(['duplicate', 'invalid', 'wontfix'])
  return String(closeReason).toUpperCase() === 'NOT_PLANNED' || labels.some((label) => exempt.has(String(label).toLowerCase()))
}

export function accidentalCloseMarker(number) {
  return `accidental-close:issue-${Number(number)}`
}

export function planAccidentalClose({ issue, labels = [], closeReason = '', mergedProduction = false, inProductionRange = false, comments = [] } = {}) {
  if (!issue?.number) return { action: 'fail', error: 'issue number is missing' }
  if (issue.open) return { action: 'noop', reason: 'issue is already open' }
  if (isExempt({ labels, closeReason })) return { action: 'noop', reason: 'issue is exempt' }
  if (productionEvidence({ mergedProduction, inProductionRange })) return { action: 'noop', reason: 'production evidence exists' }
  const marker = accidentalCloseMarker(issue.number)
  const alreadyCommented = comments.some((comment) => String(comment).includes(marker))
  return { action: alreadyCommented ? 'reopen' : 'comment-and-reopen', marker, comment: alreadyCommented ? null : `${marker}\nThis issue was closed, but Winston could not find evidence that it reached the configured production branch. It was reopened so the work is not silently lost.` }
}

export async function applyAccidentalClosePlan(plan, { comment, reopen }) {
  if (!plan || plan.action === 'fail') throw new Error(plan?.error || 'invalid accidental-close plan')
  if (plan.action === 'noop') return { ok: true, action: plan.action }
  if (plan.action === 'comment-and-reopen') {
    try {
      await comment(plan.comment)
    } finally {
      await reopen()
    }
  } else {
    await reopen()
  }
  return { ok: true, action: plan.action, commentAdded: plan.action === 'comment-and-reopen' }
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }))
}

/** Event entrypoint. Reads all evidence before making the comment/reopen mutation. */
export async function runAccidentalClose({ root, configPath, eventPath, env = process.env } = {}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const repo = event.repository?.full_name || env.GITHUB_REPOSITORY
  const number = event.issue?.number
  if (!repo || !number) throw new Error('issue event repository and number are required')
  const issue = ghJson(['api', `repos/${repo}/issues/${number}`])
  const comments = ghJson(['api', `repos/${repo}/issues/${number}/comments`, '--paginate', '--slurp']).flat()
  const timeline = ghJson(['api', `repos/${repo}/issues/${number}/timeline`, '-H', 'Accept: application/vnd.github+json', '--paginate', '--slurp']).flat()
  const production = config.branches?.production
  let mergedProduction = false
  for (const entry of timeline) {
    const pr = entry.source?.issue?.pull_request?.url
    if (!pr) continue
    try {
      const detail = ghJson(['api', pr.replace(/^https:\/\/api\.github\.com\//, '')])
      if (detail.merged_at && detail.base?.ref === production) mergedProduction = true
    } catch { /* a missing historical PR is not evidence */ }
  }
  let inProductionRange = false
  try {
    const commits = ghJson(['api', `repos/${repo}/commits`, '--method', 'GET', '-f', `sha=${production}`, '-f', 'per_page=100', '--paginate', '--slurp']).flat()
    const refs = resolveIssueReferences({ commits: commits.map((c) => ({ subject: c.commit?.message, body: c.commit?.message })) })
    inProductionRange = refs.includes(Number(number))
  } catch { /* inability to prove production is a safe reason to defer to the normal policy */ }
  const plan = planAccidentalClose({ issue: { number: issue.number, open: issue.state === 'open' }, labels: issue.labels?.map((l) => l.name) ?? [], closeReason: issue.state_reason, mergedProduction, inProductionRange, comments: comments.map((c) => c.body) })
  return applyAccidentalClosePlan(plan, {
    comment: async (body) => { ghJson(['api', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]) },
    reopen: async () => { ghJson(['api', '-X', 'PATCH', `repos/${repo}/issues/${number}`, '-f', 'state=open']) },
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, root, configPath, eventPath] = process.argv.slice(2)
  runAccidentalClose({ root, configPath, eventPath }).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
