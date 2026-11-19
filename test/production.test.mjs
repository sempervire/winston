import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyProductionPlan, planProductionReconciliation, planPromotionGate, productionMarker, productionRange, validateBaseline } from '../lib/lifecycle/production.mjs'

test('production markers and first-run ranges are strict', () => {
  assert.equal(productionMarker('A'.repeat(40)), `winston-prod-${'a'.repeat(40)}`)
  assert.equal(validateBaseline({ baseline: 'a'.repeat(40), current: 'b'.repeat(40), isAncestor: true }).ok, true)
  assert.equal(productionRange({ baselineSha: 'a'.repeat(40), currentSha: 'b'.repeat(40), isAncestor: true }).firstRun, true)
})
test('promotion gate blocks every in-range issue not Verified', () => {
  const result = planPromotionGate({ issueRefs: [1, 2, 3], issues: [{ number: 1, item: { id: 'a' }, status: 'Verified' }, { number: 2, item: { id: 'b' }, status: 'Verify' }] })
  assert.equal(result.ok, false)
  assert.deepEqual(result.blockers.map((x) => x.number), [2, 3])
})

test('production reconciliation is preflighted and idempotent', () => {
  const result = planProductionReconciliation({ issueRefs: [1, 2, 3], issues: [{ number: 1, open: true, status: 'Verified', item: { id: 'a' } }, { number: 2, open: false, status: 'Verified', item: { id: 'b' } }, { number: 3, open: true, status: 'Done', item: { id: 'c' } }] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.writes.map((x) => [x.number, x.action]), [[1, 'close'], [2, 'move']])
})

test('production reconciliation blocks an unverified reference instead of checkpointing it', () => {
  const result = planProductionReconciliation({ issueRefs: [7], issues: [{ number: 7, open: true, status: 'Verify', item: { id: 'x' } }] })
  assert.equal(result.ok, false)
  assert.match(result.errors[0], /#7 is not Verified/)
  assert.deepEqual(result.writes, [])
})

test('production mutation failure leaves marker creation off', async () => {
  const calls = []
  const result = await applyProductionPlan({ ok: true, writes: [{ number: 1, action: 'close' }] }, { closeIssue: async () => calls.push('close'), moveBoardItem: async () => { throw new Error('board unavailable') }, createMarker: async () => calls.push('marker') })
  assert.equal(result.ok, false)
  assert.equal(result.markerCreated, false)
  assert.deepEqual(calls, ['close'])
})

test('production workflows use separate full-history checkouts and pinned entrypoints', () => {
  for (const name of ['lifecycle-promotion.yml', 'lifecycle-production-close.yml']) {
    const workflow = readFileSync(join(import.meta.dirname, '..', 'templates', name), 'utf8')
    assert.match(workflow, /fetch-depth: 0/)
    assert.match(workflow, /path: workspace\/target/)
    assert.match(workflow, /repository: sempervire\/winston[\s\S]*ref: [0-9a-f]{40}[\s\S]*path: workspace\/winston/)
    assert.match(workflow, /workspace\/target\/\.winston\/config\.json/)
  }
})

