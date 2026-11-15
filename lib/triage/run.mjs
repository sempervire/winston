/**
 * The triage flow, with its I/O passed in: `gh` (every GitHub call), `decide` (the model
 * call) and `sleep`. scripts/triage-issue.mjs passes the real ones; tests pass fakes.
 *
 * Returns the exit code: 0 every selected issue was decided and applied (or rightly left
 * alone), 1 at least one issue failed and is named on stderr, 2 the question could not be
 * asked at all and nothing was written.
 */

import { addLabel, assignable, boardIssues, readBoard, readIssue, removeLabel, setAssignee, setPriority, writeComment } from './github.mjs'
import {
  assigneeChange, grantedLabels, labelChanges, parseVerdict, planComment, sameConclusion, tierOf,
  TRUSTED_ASSOCIATIONS, verdictSchema,
} from './verdict.mjs'

const DEFAULT_STATUSES = ['New', 'Ready']
// Longer than an opened run can take: its board wait plus the job's 30-minute timeout.
const SETTLE_MS = 60 * 60 * 1000

/** What a verdict would write on an issue as it stands now. */
export function plannedChanges(issue, verdict, comment) {
  const { add, remove } = labelChanges({ current: issue.labels, verdict })
  const previous = issue.comments.filter((c) => c.triage).at(-1)
  return {
    add,
    remove,
    comment: previous && sameConclusion(previous.body, verdict) ? null : comment,
    priority: verdict.priority !== issue.item?.priority ? verdict.priority : null,
    assignee: assigneeChange(issue),
  }
}

export function describe(number, verdict, ch) {
  const parts = [
    ch.comment ? 'comment' : 'comment unchanged',
    ch.priority && `Priority=${ch.priority}`,
    ch.assignee && `assignee=@${ch.assignee}`,
    ...ch.remove.map((l) => `-${l}`),
    ...ch.add.map((l) => `+${l}`),
  ].filter(Boolean)
  return `#${number} ${verdict.stop ? 'STOP' : `risk: ${verdict.risk}`}: ${parts.join(', ')}`
}

/**
 * The writes, in the order that makes a partial failure safe to retry: the comment first,
 * then Priority, the assignee and the other labels, and the `risk:` tier last. Until the
 * tier lands the issue counts as untriaged, so the next run (or the sweep) takes it again,
 * and its comment comparison keeps that retry from posting the plan twice.
 */
function write(gh, ctx, issue, ch) {
  if (ch.comment) writeComment(gh, ctx.slug, issue.number, ch.comment)
  if (ch.priority) setPriority(gh, ctx.boardFields(), issue.item.id, ch.priority)
  if (ch.assignee) {
    // Asked first, because the PATCH replaces the whole list: an unassignable reporter
    // would leave the issue with no assignee at all. Someone who cannot be assigned here
    // (an outside reporter) is not a failure, and the issue keeps its assignees.
    if (!assignable(gh, ctx.slug, ch.assignee)) {
      ctx.err(`#${issue.number}: @${ch.assignee} is not assignable in ${ctx.slug}, so the issue keeps its assignees`)
    } else if (!setAssignee(gh, ctx.slug, issue.number, ch.assignee)) {
      throw new Error(`@${ch.assignee} could not be assigned (GitHub dropped the login); the risk: tier was not written, so the next run retries`)
    }
  }
  for (const l of ch.remove) removeLabel(gh, ctx.slug, issue.number, l)
  // labelChanges puts the tier last.
  for (const l of ch.add) addLabel(gh, ctx.slug, issue.number, l)
}

/** Why an issue gets nothing written, or null when it is in scope. */
function outOfScope(issue, ctx) {
  if (!issue.open) return 'closed'
  if (!issue.item) return `not on board ${ctx.board.owner} project ${ctx.board.number}`
  if (!ctx.scope.includes(issue.item.status)) return `at status ${issue.item.status ?? '(none)'}, not ${ctx.scope.join(' or ')}`
  return null
}

async function triageOne(ctx, issue) {
  const { gh, log, opts } = ctx
  const skip = outOfScope(issue, ctx)
  if (skip) return log(`#${issue.number}: ${skip} — nothing written`)
  const tier = tierOf(issue.labels)
  // The unattended run stamps what has no stamp; re-reading triaged issues is the
  // whole-board /winston:triage pass's job. A dry run still decides, to show its verdict.
  if (tier && !opts.dryRun) return log(`#${issue.number}: already has ${tier} — nothing written`)

  const fields = ctx.boardFields()
  const priorities = fields.priority.options.map((o) => o.name)
  const raw = await ctx.decide({ issue, status: issue.item.status, priority: issue.item.priority, policy: ctx.policy, schema: verdictSchema(priorities), model: ctx.model })
  const verdict = parseVerdict(raw, { priorities, granted: ctx.granted })
  const comment = planComment(verdict, { model: ctx.model, runUrl: ctx.runUrl, policyName: ctx.policyName })

  if (opts.dryRun) {
    const ch = plannedChanges(issue, verdict, comment)
    log(`${describe(issue.number, verdict, ch)}   (dry run: nothing written)`)
    log(`verdict: ${JSON.stringify(verdict)}`)
    if (ch.comment) log(`comment:\n${ch.comment.trimEnd().replace(/^/gm, '  | ')}`)
    return
  }

  // The state as it is now, not as it was before the model call: another run (the sweep
  // and an opened run are different concurrency groups) may have stamped it meanwhile.
  const fresh = readIssue(gh, { slug: ctx.slug, number: issue.number, board: ctx.board })
  const freshSkip = fresh ? outOfScope(fresh, ctx) : 'gone'
  if (freshSkip) return log(`#${issue.number}: ${freshSkip} by the time of writing — nothing written`)
  if (tierOf(fresh.labels)) return log(`#${issue.number}: stamped ${tierOf(fresh.labels)} by another run meanwhile — nothing written`)
  const ch = plannedChanges(fresh, verdict, comment)
  write(gh, ctx, fresh, ch)
  log(describe(issue.number, verdict, ch))
}

/** On `issues: opened` the board item arrives a moment after the issue: wait for it. */
async function readWhenOnBoard(ctx, number) {
  let issue = null
  for (let i = 0; i < ctx.waitTries; i++) {
    issue = readIssue(ctx.gh, { slug: ctx.slug, number, board: ctx.board })
    if (!issue || !issue.open || issue.item?.status) return issue
    if (i < ctx.waitTries - 1) await ctx.sleep(ctx.waitMs)
  }
  return issue
}

/**
 * A stop no one has answered: the last triage comment is a stop, and since it nobody has
 * commented, edited the body or renamed the issue. Deciding it again would reach the same
 * stop, so the sweep passes it by rather than spend a model call and a slot on it.
 */
export function unansweredStop(issue) {
  const at = issue.comments.findLastIndex((c) => c.triage)
  if (at === -1 || !issue.comments[at].body.trimStart().startsWith('## Triage stopped')) return false
  if (issue.comments.slice(at + 1).some((c) => !c.triage)) return false
  const since = Date.parse(issue.comments[at].createdAt ?? '')
  if (Number.isNaN(since)) return false
  return ![issue.editedAt, issue.renamedAt].some((t) => t && Date.parse(t) > since)
}

function sweepSelection(ctx) {
  const all = boardIssues(ctx.gh, { slug: ctx.slug, board: ctx.board })
  // An issue filed within the hour belongs to its own `opened` run, which may still be
  // waiting for the board or deciding; the sweep and that run are different concurrency
  // groups, and both deciding it could post two plans.
  const settled = (i) => !i.createdAt || ctx.now() - Date.parse(i.createdAt) >= SETTLE_MS
  const want = all.filter((i) => i.open && ctx.scope.includes(i.status) && !tierOf(i.labels) && TRUSTED_ASSOCIATIONS.includes(i.association) && settled(i))
    .sort((a, b) => a.number - b.number)
  ctx.log(`sweep: ${want.length} unstamped issue(s) at ${ctx.scope.join(' or ')} from the owner or a collaborator, filed over an hour ago; taking up to ${ctx.opts.max}, oldest first, past any unanswered stop`)
  return want.map((i) => i.number)
}

export async function runTriage(opts, deps) {
  const { config } = deps
  const log = deps.log ?? ((l) => process.stdout.write(`${l}\n`))
  const err = deps.err ?? ((l) => process.stderr.write(`${l}\n`))
  const b = config.board ?? {}
  if (!b.owner || !Number.isInteger(b.number)) {
    err('.winston/config.json names no board (board.owner and board.number) — nothing written')
    return 2
  }
  const board = { owner: b.owner, number: b.number, priorityField: b.priorityField ?? 'Priority' }
  let fields = null
  const ctx = {
    ...deps, opts, log, err, board,
    scope: (Array.isArray(b.statuses) && b.statuses.length >= 2 ? b.statuses : DEFAULT_STATUSES).slice(0, 2),
    granted: grantedLabels(deps.policy),
    waitTries: deps.waitTries ?? 12,
    waitMs: deps.waitMs ?? 10000,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    // Read once, and only when an issue needs deciding.
    boardFields: () => (fields ??= readBoard(deps.gh, board)),
  }

  let numbers
  try {
    numbers = opts.sweep ? sweepSelection(ctx) : [opts.issue]
  } catch (e) {
    err(`cannot read the board: ${e.message} — nothing written`)
    return 2
  }

  let failed = 0
  let taken = 0
  for (const number of numbers) {
    // The cap counts issues sent to the model, so unanswered stops cannot starve the sweep.
    if (opts.sweep && taken >= opts.max) break
    try {
      const issue = opts.opened ? await readWhenOnBoard(ctx, number) : readIssue(ctx.gh, { slug: ctx.slug, number, board })
      if (!issue) {
        err(`#${number} is not an issue in ${ctx.slug} — nothing written`)
        if (!opts.sweep) return 2
        failed++
        continue
      }
      if (opts.opened && issue.open && !issue.item?.status) {
        log(`#${number}: not on board ${board.owner} project ${board.number} with a status yet — nothing written; the daily sweep takes it once it is`)
        continue
      }
      if (opts.sweep && unansweredStop(issue)) {
        log(`#${number}: stopped, and nothing has changed since — passed by`)
        continue
      }
      taken++
      await triageOne(ctx, issue)
    } catch (e) {
      failed++
      err(`#${number}: ${e.message}`)
    }
  }
  return failed ? 1 : 0
}
