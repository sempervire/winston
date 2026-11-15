/**
 * The GitHub half of the triage script: reads of the issue, its board item and the board's
 * fields, and the writes a verdict turns into. Every call goes through one `gh(args,
 * { input })` function, so tests pass a fake one and no network is touched.
 *
 * Priority is a field on the board item (ProjectV2), not on the issue: read from the item,
 * written with `gh project item-edit`, its options read from the board each run.
 */

import { execFileSync } from 'node:child_process'

export function realGh(args, { input } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    const err = new Error(`gh ${args.slice(0, 2).join(' ')}: ${(e.stderr || e.message || '').trim().split('\n')[0]}`)
    err.stdout = (e.stdout || '').trim()
    throw err
  }
}

function graphql(gh, query, vars = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`)
  let out
  try {
    out = gh(args)
  } catch (e) {
    if (!e.stdout) throw e
    out = e.stdout
  }
  const json = JSON.parse(out)
  if (json.errors?.length) {
    const why = json.errors.map((x) => x.message).join('; ')
    // The usual cause: the token reaches the repository but not the board. A fine-grained
    // token cannot reach a project a user owns, so GH_PAT must then be a classic token.
    const hint = /not accessible by (personal access|integration) token/i.test(why)
      ? ' (the token cannot read the board: GH_PAT needs Projects read/write on the board\'s owner, which for a board a user owns means a classic token with the repo and project scopes; winston doctor prints the steps)'
      : ''
    throw new Error(why + hint)
  }
  return json.data
}

const OWNER_PROJECT = `query($owner:String!,$number:Int!){ repositoryOwner(login:$owner){
  ... on Organization{ projectV2(number:$number){ ...P } } ... on User{ projectV2(number:$number){ ...P } } } }
fragment P on ProjectV2 { id fields(first:100){ nodes{ ... on ProjectV2SingleSelectField{ id name options{ id name } } } } }`

/** The board's id and its Priority field, with the options in the board's own order. */
export function readBoard(gh, { owner, number, priorityField }) {
  const project = graphql(gh, OWNER_PROJECT, { owner, number }).repositoryOwner?.projectV2
  if (!project) throw new Error(`board ${owner} project ${number} not found, or this token cannot read it`)
  const field = project.fields.nodes.find((f) => f?.name === priorityField)
  if (!field?.options?.length) throw new Error(`board ${owner} project ${number} has no single-select ${priorityField} field`)
  return { projectId: project.id, priority: { id: field.id, options: field.options } }
}

const ISSUE = `query($owner:String!,$name:String!,$number:Int!,$status:String!,$priority:String!){ repository(owner:$owner,name:$name){
  issue(number:$number){ number title body state authorAssociation author{ login __typename }
    assignees(first:50){ nodes{ login } }
    labels(first:100){ totalCount nodes{ name } }
    comments(first:100){ totalCount pageInfo{ hasNextPage endCursor } nodes{ author{ login } body } }
    projectItems(first:100){ totalCount nodes{ id isArchived project{ number owner{ ... on User{ login } ... on Organization{ login } } }
      status: fieldValueByName(name:$status){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
      priority: fieldValueByName(name:$priority){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } } } } }`

const MORE_COMMENTS = `query($owner:String!,$name:String!,$number:Int!,$after:String!){ repository(owner:$owner,name:$name){
  issue(number:$number){ comments(first:100,after:$after){ pageInfo{ hasNextPage endCursor } nodes{ author{ login } body } } } } }`

/**
 * One issue, read whole: every comment (paged), every label, and its item on this board.
 * Returns null when the number is not an issue in the repository.
 */
export function readIssue(gh, { slug, number, board }) {
  const [owner, name] = slug.split('/')
  let issue
  try {
    issue = graphql(gh, ISSUE, { owner, name, number, status: 'Status', priority: board.priorityField }).repository?.issue
  } catch (e) {
    if (/Could not resolve to an Issue/i.test(e.message)) return null
    throw e
  }
  if (!issue) return null
  if (issue.labels.totalCount > issue.labels.nodes.length) throw new Error(`#${number}: more labels than one page`)
  const comments = [...issue.comments.nodes]
  let page = issue.comments.pageInfo
  while (page.hasNextPage) {
    const more = graphql(gh, MORE_COMMENTS, { owner, name, number, after: page.endCursor }).repository.issue.comments
    if (!more.nodes.length) throw new Error(`#${number}: a comment page came back empty`)
    comments.push(...more.nodes)
    page = more.pageInfo
  }
  if (comments.length < issue.comments.totalCount) throw new Error(`#${number}: ${comments.length} of ${issue.comments.totalCount} comments read`)
  const item = issue.projectItems.nodes.find((i) => !i.isArchived && i.project?.number === board.number &&
    i.project.owner?.login?.toLowerCase() === String(board.owner).toLowerCase())
  // Off this board only when every item was read: past one page, the board's item may be on the next.
  if (!item && issue.projectItems.totalCount > issue.projectItems.nodes.length) throw new Error(`#${number}: on more projects than one page reads`)
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    open: issue.state === 'OPEN',
    association: issue.authorAssociation,
    author: issue.author ? { login: issue.author.login, __typename: issue.author.__typename } : null,
    assignees: issue.assignees.nodes.map((a) => a.login),
    labels: issue.labels.nodes.map((l) => l.name),
    comments: comments.map((c) => ({ author: c.author?.login ?? 'ghost', body: c.body ?? '' })),
    item: item ? { id: item.id, status: item.status?.name ?? null, priority: item.priority?.name ?? null } : null,
  }
}

const BOARD_ITEMS = `query($owner:String!,$number:Int!,$after:String){ repositoryOwner(login:$owner){
  ... on Organization{ projectV2(number:$number){ ...I } } ... on User{ projectV2(number:$number){ ...I } } } }
fragment I on ProjectV2 { items(first:100,after:$after){ pageInfo{ hasNextPage endCursor } nodes{ isArchived
  status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
  content{ __typename ... on Issue{ number state createdAt authorAssociation repository{ nameWithOwner } labels(first:100){ nodes{ name } } } } } } }`

/** Every issue of this repository on the board, as { number, open, createdAt, status, association, labels }. */
export function boardIssues(gh, { slug, board }) {
  const out = []
  let after = null
  for (let page = 0; page < 100; page++) {
    const vars = { owner: board.owner, number: board.number, ...(after ? { after } : {}) }
    const items = graphql(gh, BOARD_ITEMS, vars).repositoryOwner?.projectV2?.items
    if (!items) throw new Error(`board ${board.owner} project ${board.number} not found, or this token cannot read it`)
    for (const n of items.nodes) {
      const c = n.content
      if (n.isArchived || c?.__typename !== 'Issue' || c.repository?.nameWithOwner?.toLowerCase() !== slug.toLowerCase()) continue
      out.push({ number: c.number, open: c.state === 'OPEN', createdAt: c.createdAt, status: n.status?.name ?? null, association: c.authorAssociation, labels: c.labels.nodes.map((l) => l.name) })
    }
    if (!items.pageInfo.hasNextPage) return out
    after = items.pageInfo.endCursor
  }
  throw new Error('the board has more items than the sweep reads')
}

export function addLabel(gh, slug, number, label) {
  gh(['api', `repos/${slug}/issues/${number}/labels`, '-f', `labels[]=${label}`])
}

export function removeLabel(gh, slug, number, label) {
  gh(['api', '-X', 'DELETE', `repos/${slug}/issues/${number}/labels/${encodeURIComponent(label)}`])
}

/** The reporter becomes the sole assignee: PATCH replaces the whole list. */
/** Whether GitHub lets this login be assigned here: 204 yes, 404 no. */
export function assignable(gh, slug, login) {
  try {
    gh(['api', `repos/${slug}/assignees/${encodeURIComponent(login)}`])
    return true
  } catch (e) {
    if (/404|Not Found/i.test(e.message)) return false
    throw e
  }
}

export function setAssignee(gh, slug, number, login) {
  const out = JSON.parse(gh(['api', '-X', 'PATCH', `repos/${slug}/issues/${number}`, '-f', `assignees[]=${login}`]) || '{}')
  // GitHub drops a login it cannot assign and still answers 200.
  return !out.assignees || out.assignees.some((u) => u.login.toLowerCase() === login.toLowerCase())
}

/** The body goes on stdin, so a plan full of backticks never touches the argument list. */
export function writeComment(gh, slug, number, body) {
  gh(['issue', 'comment', String(number), '-R', slug, '-F', '-'], { input: body })
}

export function setPriority(gh, { projectId, priority }, itemId, name) {
  const option = priority.options.find((o) => o.name === name)
  if (!option) throw new Error(`the board has no Priority option named "${name}"`)
  gh(['project', 'item-edit', '--id', itemId, '--project-id', projectId, '--field-id', priority.id, '--single-select-option-id', option.id])
}
