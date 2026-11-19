import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { accidentalCloseMarker, applyAccidentalClosePlan, isExempt, planAccidentalClose, productionEvidence } from '../lib/lifecycle/accidental-close.mjs'

test('exemptions and production evidence are explicit', () => {
  assert.equal(isExempt({ labels: ['duplicate'] }), true)
  assert.equal(isExempt({ closeReason: 'NOT_PLANNED' }), true)
  assert.equal(productionEvidence({ mergedProduction: true }), true)
  assert.equal(productionEvidence({ inProductionRange: true }), true)
  assert.equal(accidentalCloseMarker(42), 'accidental-close:issue-42')
})
test('unproven close gets one stable comment and reopen', () => {
  const plan = planAccidentalClose({ issue: { number: 42, open: false } })
  assert.equal(plan.action, 'comment-and-reopen')
  assert.match(plan.comment, /accidental-close:issue-42/)
})
test('retries repair reopen without duplicating the comment', () => {
  const plan = planAccidentalClose({ issue: { number: 42, open: false }, comments: ['accidental-close:issue-42'] })
  assert.equal(plan.action, 'reopen')
  const calls = []
  return applyAccidentalClosePlan(plan, { comment: async () => calls.push('comment'), reopen: async () => calls.push('reopen') }).then((result) => {
    assert.equal(result.commentAdded, false)
    assert.deepEqual(calls, ['reopen'])
  })
})
test('open, exempt, and production-proven issues are left alone', () => {
  for (const input of [{ issue: { number: 1, open: true } }, { issue: { number: 2, open: false }, labels: ['wontfix'] }, { issue: { number: 3, open: false }, inProductionRange: true }]) {
    assert.equal(planAccidentalClose(input).action, 'noop')
  }
})
// End of contract tests.
test('workflow uses separate checkouts and the event issue trigger', () => {
  const workflow = readFileSync(join(import.meta.dirname, '..', 'templates/lifecycle-accidental-close.yml'), 'utf8')
  assert.match(workflow, /types: \[closed\]/)
  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /repository: sempervire\/winston[\s\S]*ref: [0-9a-f]{40}/)
  assert.match(workflow, /workspace\/target\/\.winston\/config\.json/)
})
