/** Pure issue-reference and push-range resolvers used by the lifecycle workflows.
 *
 * These functions deliberately know nothing about GitHub or the filesystem.  The
 * workflow adapter supplies the event commits and API reads, which keeps the
 * dangerous "decide before write" part straightforward to test.
 */

const KEYWORDS = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https?:\/\/github\.com\/[^/\s]+\/[^/#\s]+\/issues\/)?(?:[^#\s]+\/[^#\s]+#)?#?(\d+)\b/gi
const EXPLICIT = /\b(?:refs?|references?|issue|issues|related)\s*[:#]?\s*(?:https?:\/\/github\.com\/[^/\s]+\/[^/#\s]+\/issues\/)?(?:[^#\s]+\/[^#\s]+#)?#?(\d+)\b/gi

function numbers(re, text = '') {
  const out = new Set()
  for (const m of String(text).matchAll(re)) out.add(Number(m[1]))
  return [...out].filter(Number.isSafeInteger).sort((a, b) => a - b)
}

/** Issue numbers mentioned by GitHub closing-keyword syntax. */
export function closingKeywordIssues(text) {
  return numbers(KEYWORDS, text)
}

/** Issue numbers explicitly declared with Refs/Issue/Related wording. */
export function explicitIssueReferences(text) {
  return numbers(EXPLICIT, text)
}

/** Union of resolver results, with stable numeric ordering and no duplicates. */
export function resolveIssueReferences({ commits = [], declarations = [], text = '' } = {}) {
  const body = [text, ...declarations, ...commits.flatMap((c) => [c.subject, c.body, c.message])].filter(Boolean).join('\n')
  return [...new Set([...closingKeywordIssues(body), ...explicitIssueReferences(body)])].sort((a, b) => a - b)
}

/**
 * Resolve the issue set for an integration push. `rangeIssues` is the result of
 * the adapter's commit/range lookup; explicit references are retained because a
 * declaration can be present in a branch/commit that the keyword parser cannot
 * classify as a closing keyword.
 */
export function integrationIssueNumbers({ rangeIssues = [], commits = [], declarations = [], text = '' } = {}) {
  return [...new Set([...rangeIssues, ...resolveIssueReferences({ commits, declarations, text })])]
    .map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b)
}

export function isEligibleIntegrationStatus(status, { ready = 'Ready', intake = 'New', verify = 'Verify' } = {}) {
  return status === intake || status === ready || status === verify
}

export function shouldMoveToVerify(item, statuses = {}) {
  if (!item || item.closed || item.status === statuses.verified || item.status === statuses.done) return false
  return isEligibleIntegrationStatus(item.status, statuses) && item.status !== statuses.verify
}

