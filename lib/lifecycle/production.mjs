/** Production-range gate and reconciliation planner. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolveIssueReferences } from './resolvers.mjs'

export function productionMarker(sha) {
  if (!/^[0-9a-f]{40}$/i.test(String(sha ?? ''))) throw new Error('production marker needs a full commit SHA')
  return `winston-prod-${String(sha).toLowerCase()}`
}

export function validateBaseline({ baseline, current, isAncestor }) {
  if (!/^[0-9a-f]{40}$/i.test(String(baseline ?? ''))) return { ok: false, error: 'baseline_sha must be a full commit SHA' }
  if (!/^[0-9a-f]{40}$/i.test(String(current ?? ''))) return { ok: false, error: 'current production commit must be a full commit SHA' }
  if (baseline.toLowerCase() === current.toLowerCase()) return { ok: false, error: 'baseline_sha must precede the current production commit' }
  if (!isAncestor) return { ok: false, error: 'baseline_sha is not an ancestor of the current production commit' }
  return { ok: true }
}

export function productionRange({ markerSha, baselineSha, currentSha, isAncestor }) {
  if (markerSha) {
    const valid = validateBaseline({ baseline: markerSha, current: currentSha, isAncestor })
    return valid.ok ? { ok: true, from: markerSha, to: currentSha } : valid
  }
  const valid = validateBaseline({ baseline: baselineSha, current: currentSha, isAncestor })
  return valid.ok ? { ok: true, from: baselineSha, to: currentSha, firstRun: true } : valid
}

export function planPromotionGate({ issueRefs, issues, verified = 'Verified' }) {
  const byNumber = new Map((issues ?? []).map((issue) => [Number(issue.number), issue]))
  const blockers = []
  for (const number of [...new Set(issueRefs ?? [])].sort((a, b) => a - b)) {
    const issue = byNumber.get(Number(number))
    if (!issue) blockers.push({ number, reason: 'missing issue' })
    else if (!issue.item) blockers.push({ number, reason: 'missing board item' })
    else if (issue.status !== verified) blockers.push({ number, status: issue.status, reason: 'not Verified' })
  }
  return { ok: blockers.length === 0, blockers }
}

export function planProductionReconciliation({ issueRefs, issues, verified = 'Verified', done = 'Done' }) {
  const refs = [...new Set(issueRefs ?? [])].sort((a, b) => a - b)
  const byNumber = new Map((issues ?? []).map((issue) => [Number(issue.number), issue]))
  const errors = []
  const writes = []
  for (const number of refs) {
    const issue = byNumber.get(Number(number))
    if (!issue) { errors.push(`#${number} is missing`); continue }
    if (!issue.item) { errors.push(`#${number} has no board item`); continue }
    if (issue.status !== verified) continue
    if (issue.open) writes.push({ number, action: 'close', itemId: issue.item.id, boardFrom: issue.status, boardTo: done })
    else if (issue.status !== done) writes.push({ number, action: 'move', itemId: issue.item.id, boardFrom: issue.status, boardTo: done })
  }
  return errors.length ? { ok: false, errors, writes: [] } : { ok: true, errors: [], writes }
}

export async function applyProductionPlan(plan, { closeIssue, moveBoardItem, createMarker }) {
  if (!plan?.ok) throw new Error('refusing to mutate an unverified production plan')
  const results = []
  for (const write of plan.writes ?? []) {
    try {
      if (write.action === 'close') await closeIssue(write.number)
      await moveBoardItem(write)
      results.push({ ...write, ok: true })
    } catch (error) {
      results.push({ ...write, ok: false, error: error.message })
    }
  }
  const ok = results.every((r) => r.ok)
  if (ok && createMarker) await createMarker()
  return { ok, results, markerCreated: ok && Boolean(createMarker) }
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }))
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function ancestor(root, from, to) {
  try { git(root, ['merge-base', '--is-ancestor', from, to]); return true } catch { return false }
}

function graph(variables, query) {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
  const out = ghJson(args)
  if (out.errors?.length) throw new Error(out.errors.map((e) => e.message).join('; '))
  return out.data
}

const ISSUE = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){number state body projectItems(first:100){totalCount nodes{id isArchived project{number owner{... on User{login} ... on Organization{login}}} status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`
const BOARD = `query($owner:String!,$number:Int!){repositoryOwner(login:$owner){... on Organization{projectV2(number:$number){id fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}} ... on User{projectV2(number:$number){id fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}}`
const MOVE = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`

function statuses(config) {
  const s = config.board?.statuses ?? []
  return { verify: s[2] ?? 'Verify', verified: s[3] ?? 'Verified', done: 'Done' }
}

function commitMessages(root, from, to) {
  const raw = git(root, ['log', '--format=%H%x00%s%x00%b%x01', `${from}..${to}`])
  return raw.split('\x01').filter(Boolean).map((row) => {
    const [sha, subject, ...body] = row.split('\x00')
    return { sha, subject, body: body.join('\x00') }
  })
}

function readIssues(repo, board, numbers) {
  const [owner, name] = repo.split('/')
  return numbers.map((number) => {
    const issue = graph({ owner, repo: name, number }, ISSUE).repository?.issue
    if (!issue) return { number }
    if (issue.projectItems.totalCount > issue.projectItems.nodes.length) throw new Error(`#${number}: board item pagination is incomplete`)
    const item = issue.projectItems.nodes.find((i) => !i.isArchived && i.project?.number === board.number && i.project.owner?.login?.toLowerCase() === String(board.owner).toLowerCase())
    return { number: issue.number, open: issue.state === 'OPEN', status: item?.status?.name, item: item ? { id: item.id } : null }
  })
}

/** Workflow entrypoint for the promotion gate and production close jobs. */
export async function runProduction({ mode, root, configPath, eventPath, baselineSha = '', env = process.env } = {}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const repo = event.repository?.full_name || env.GITHUB_REPOSITORY
  const current = event.after || event.pull_request?.merge_commit_sha || event.pull_request?.head?.sha
  const baseline = event.before || event.pull_request?.base?.sha || baselineSha
  const range = productionRange({ baselineSha: baseline, currentSha: current, isAncestor: Boolean(baseline && current && ancestor(root, baseline, current)) })
  if (!range.ok) return range
  const messages = commitMessages(root, range.from, range.to)
  const issueRefs = resolveIssueReferences({ commits: messages, text: event.pull_request?.body ?? '' })
  const boardData = graph({ owner: config.board.owner, number: config.board.number }, BOARD).repositoryOwner?.projectV2
  if (!boardData) return { ok: false, errors: ['configured board could not be read'] }
  const field = boardData.fields.nodes.find((f) => f?.name === 'Status')
  if (!field) return { ok: false, errors: ['configured board has no Status field'] }
  const issues = readIssues(repo, config.board, issueRefs)
  if (mode === 'gate') {
    const result = planPromotionGate({ issueRefs, issues, verified: statuses(config).verified })
    if (!result.ok) process.stderr.write(`${JSON.stringify(result)}\n`)
    return result
  }
  const plan = planProductionReconciliation({ issueRefs, issues, verified: statuses(config).verified, done: statuses(config).done })
  if (!plan.ok) return plan
  const [owner, name] = repo.split('/')
  return applyProductionPlan(plan, {
    closeIssue: async (number) => { ghJson(['api', '-X', 'PATCH', `repos/${owner}/${name}/issues/${number}`, '-f', 'state=closed']) },
    moveBoardItem: async ({ itemId, boardTo }) => {
      const option = field.options.find((o) => o.name === boardTo)
      if (!option) throw new Error(`board has no Status option named ${boardTo}`)
      graph({ project: boardData.id, item: itemId, field: field.id, option: option.id }, MOVE)
    },
    createMarker: async () => { const tag = productionMarker(current); git(root, ['tag', '-a', tag, '-m', `Winston production checkpoint ${current}`, current]); git(root, ['push', 'origin', tag]) },
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, root, configPath, eventPath, baselineSha] = process.argv.slice(2)
  runProduction({ mode, root, configPath, eventPath, baselineSha }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.ok) process.exitCode = 1
  }).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
