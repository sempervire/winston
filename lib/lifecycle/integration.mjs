/** Integration-push lifecycle planner and executor.
 *
 * `github` and `git` are injected adapters.  Nothing mutates while planning;
 * callers can therefore fail closed before invoking applyIntegrationPlan.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { integrationIssueNumbers, shouldMoveToVerify } from './resolvers.mjs'

function statusNames(config) {
  const s = config?.board?.statuses ?? config?.statuses
  if (Array.isArray(s)) return { intake: s[0] ?? 'New', ready: s[1] ?? 'Ready', verify: s[2] ?? 'Verify', verified: s[3] ?? 'Verified', done: 'Done' }
  return { intake: s?.intake ?? 'New', ready: s?.ready ?? 'Ready', verify: s?.verify ?? 'Verify', verified: s?.verified ?? 'Verified', done: s?.done ?? 'Done' }
}

export function validateBranches({ integration, production, defaultBranch, integrationExists, productionExists }) {
  const errors = []
  if (!integration || !production) errors.push('branches.integration and branches.production are required')
  if (integration === production) errors.push('integration and production branches must differ')
  if (defaultBranch && defaultBranch === integration) errors.push('the repository default branch must not be the integration branch')
  if (integration && integrationExists === false) errors.push(`integration branch ${integration} does not exist`)
  if (production && productionExists === false) errors.push(`production branch ${production} does not exist`)
  return { ok: errors.length === 0, errors }
}

export function planIntegrationPush({ config, event, rangeIssues, commits, declarations, text, issues, boardItems }) {
  const branches = config?.branches ?? {}
  const statuses = statusNames(config)
  const validation = validateBranches({
    integration: branches.integration,
    production: branches.production,
    defaultBranch: config.defaultBranch,
    integrationExists: config.integrationExists,
    productionExists: config.productionExists,
  })
  if (!validation.ok) return { ok: false, errors: validation.errors, writes: [] }
  if (!event?.before || /^0+$/.test(event.before)) return { ok: false, errors: ['the push has no usable before SHA'], writes: [] }
  if (event.deleted || !event.after) return { ok: false, errors: ['branch deletion or missing after SHA cannot be reconciled'], writes: [] }
  if (!Array.isArray(issues) || !Array.isArray(boardItems)) return { ok: false, errors: ['issue and board preflight data is incomplete'], writes: [] }
  const itemByNumber = new Map(boardItems.map((item) => [Number(item.number), item]))
  const numbers = integrationIssueNumbers({ rangeIssues, commits, declarations, text })
  const errors = []
  const writes = []
  for (const number of numbers) {
    const issue = issues.find((x) => Number(x.number) === number)
    if (!issue) { errors.push(`#${number} is missing`); continue }
    if (!issue.open) continue
    const item = itemByNumber.get(number)
    if (!item) { errors.push(`#${number} has no board item`); continue }
    if (item.closed || item.status === statuses.verified || item.status === statuses.done) continue
    if (shouldMoveToVerify({ ...item, closed: !issue.open }, statuses)) writes.push({ number, itemId: item.id, from: item.status, to: statuses.verify })
  }
  return errors.length ? { ok: false, errors, writes: [] } : { ok: true, errors: [], writes }
}

export async function applyIntegrationPlan(plan, { moveBoardItem }) {
  if (!plan?.ok) throw new Error('refusing to mutate an unverified integration plan')
  const results = []
  for (const write of plan.writes ?? []) {
    try {
      await moveBoardItem(write)
      results.push({ ...write, ok: true })
    } catch (error) {
      results.push({ ...write, ok: false, error: error.message })
    }
  }
  return { ok: results.every((r) => r.ok), results }
}

function ghJson(args, input) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }))
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function branchExists(repo, branch) {
  try { ghJson(['api', `repos/${repo}/branches/${encodeURIComponent(branch)}`]); return true } catch { return false }
}

function eventCommits(root, before, after) {
  const raw = git(root, ['log', '--format=%H%x00%s%x00%b%x01', `${before}..${after}`])
  return raw.split('\x01').filter(Boolean).map((row) => {
    const [sha, subject, ...body] = row.split('\x00')
    return { sha, subject, body: body.join('\x00') }
  })
}

const BOARD = `query($owner:String!,$number:Int!){repositoryOwner(login:$owner){... on Organization{projectV2(number:$number){id fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}} ... on User{projectV2(number:$number){id fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}}`
const ISSUE = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){number state projectItems(first:100){nodes{id isArchived project{number owner{... on User{login} ... on Organization{login}}} status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`
const MOVE = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`

function graph(variables, query) {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
  const data = ghJson(args)
  if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join('; '))
  return data.data
}

/** CLI entrypoint used by the pinned workflow. It does nothing for non-integration pushes. */
export async function runIntegration({ root, configPath, eventPath, env = process.env } = {}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const integration = config.branches?.integration
  const refName = event.ref?.replace(/^refs\/heads\//, '') || env.GITHUB_REF_NAME
  if (!integration || refName !== integration) return { ok: true, skipped: true, reason: 'not the configured integration branch' }
  if (!event.before || /^0+$/.test(event.before) || event.deleted) return { ok: false, errors: ['the push range is empty or deleted'] }
  const repo = event.repository?.full_name || env.GITHUB_REPOSITORY
  const [owner, name] = String(repo).split('/')
  if (!owner || !name) throw new Error('GITHUB_REPOSITORY or event.repository.full_name is required')
  const integrationExists = branchExists(repo, integration)
  const production = config.branches?.production
  const productionExists = branchExists(repo, production)
  const validation = validateBranches({ integration, production, defaultBranch: event.repository?.default_branch, integrationExists, productionExists })
  if (!validation.ok) return { ok: false, errors: validation.errors }
  const commits = eventCommits(root, event.before, event.after)
  const text = commits.map((c) => `${c.subject}\n${c.body}`).join('\n')
  const rangeIssues = integrationIssueNumbers({ commits, text })
  const boardData = graph({ owner: config.board.owner, number: config.board.number }, BOARD).repositoryOwner?.projectV2
  if (!boardData) return { ok: false, errors: ['configured board could not be read'] }
  const statusField = boardData.fields.nodes.find((f) => f?.name === 'Status')
  if (!statusField) return { ok: false, errors: ['configured board has no Status field'] }
  const statuses = statusNames(config)
  const issues = []
  const boardItems = []
  for (const number of rangeIssues) {
    const data = graph({ owner, repo: name, number }, ISSUE)
    const issue = data.repository?.issue
    if (!issue) { issues.push({ number: null }); continue }
    issues.push({ number: issue.number, open: issue.state === 'OPEN' })
    const item = issue.projectItems.nodes.find((i) => !i.isArchived && i.project?.number === config.board.number && i.project.owner?.login?.toLowerCase() === String(config.board.owner).toLowerCase())
    if (item) boardItems.push({ number: issue.number, id: item.id, status: item.status?.name })
  }
  const plan = planIntegrationPush({ config: { ...config, statuses, integrationExists, productionExists, defaultBranch: event.repository?.default_branch }, event, rangeIssues, commits, issues, boardItems })
  if (!plan.ok) return plan
  return applyIntegrationPlan(plan, { moveBoardItem: async ({ itemId, to }) => {
    const option = statusField.options.find((o) => o.name === to)
    if (!option) throw new Error(`board has no Status option named ${to}`)
    graph({ project: boardData.id, item: itemId, field: statusField.id, option: option.id }, MOVE)
  } })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, configPath, eventPath] = process.argv.slice(2)
  runIntegration({ root, configPath, eventPath }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.ok) process.exitCode = 1
  }).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
