import test from 'node:test'
import assert from 'node:assert/strict'
import { closingKeywordIssues, explicitIssueReferences, integrationIssueNumbers } from '../lib/lifecycle/resolvers.mjs'
import { applyIntegrationPlan, planIntegrationPush, validateBranches } from '../lib/lifecycle/integration.mjs'

test('lifecycle resolvers collect closing keywords and explicit declarations once', () => {
  assert.deepEqual(closingKeywordIssues('Fixes #12; closes owner/repo#13; fixed #12'), [12, 13])
  assert.deepEqual(explicitIssueReferences('Refs #14 and issue: #15'), [14, 15])
  assert.deepEqual(integrationIssueNumbers({ rangeIssues: [15], text: 'Fixes #12\nRefs #15' }), [12, 15])
})

test('branch validation fails closed before any write', () => {
  assert.deepEqual(validateBranches({ integration: 'staging', production: 'main', defaultBranch: 'staging', integrationExists: true, productionExists: true }), {
    ok: false, errors: ['the repository default branch must not be the integration branch'],
  })
})

test('integration planning preflights all issue and board state', () => {
  const plan = planIntegrationPush({
    config: { branches: { integration: 'staging', production: 'main' }, statuses: { ready: 'Ready', intake: 'New', verify: 'Verify', verified: 'Verified', done: 'Done' }, integrationExists: true, productionExists: true, defaultBranch: 'main' },
    event: { before: 'abc', after: 'def' },
    rangeIssues: [1, 2, 3],
    issues: [{ number: 1, open: true }, { number: 2, open: true }, { number: 3, open: false }],
    boardItems: [{ number: 1, id: 'a', status: 'Ready' }, { number: 2, id: 'b', status: 'Verified' }],
  })
  assert.equal(plan.ok, false)
  assert.match(plan.errors.join('\n'), /#3 has no board item/)
  assert.deepEqual(plan.writes, [])
})

test('integration planning moves only New and Ready items and is idempotent for Verify', () => {
  const base = { config: { branches: { integration: 'staging', production: 'main' }, statuses: { ready: 'Ready', intake: 'New', verify: 'Verify', verified: 'Verified', done: 'Done' }, integrationExists: true, productionExists: true, defaultBranch: 'main' }, event: { before: 'abc', after: 'def' }, rangeIssues: [1, 2, 3], issues: [{ number: 1, open: true }, { number: 2, open: true }, { number: 3, open: true }], boardItems: [{ number: 1, id: 'a', status: 'New' }, { number: 2, id: 'b', status: 'Verify' }, { number: 3, id: 'c', status: 'Done' }] }
  const plan = planIntegrationPush(base)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.writes.map((x) => x.number), [1])
  const seen = []
  return applyIntegrationPlan(plan, { moveBoardItem: async (write) => { seen.push(write.number) } }).then((result) => {
    assert.deepEqual(seen, [1])
    assert.equal(result.ok, true)
  })
})

test('mutation failures report per-item results and retain successful moves', async () => {
  const plan = { ok: true, writes: [{ number: 1, itemId: 'a', from: 'New', to: 'Verify' }, { number: 2, itemId: 'b', from: 'Ready', to: 'Verify' }] }
  const result = await applyIntegrationPlan(plan, { moveBoardItem: async ({ number }) => { if (number === 2) throw new Error('API unavailable') } })
  assert.equal(result.ok, false)
  assert.deepEqual(result.results.map((x) => x.ok), [true, false])
  assert.match(result.results[1].error, /API unavailable/)
})

