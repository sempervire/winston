# Reading the board whole

Every Winston skill that reads the board or lists a repository's issues follows this file, so
the limit is set in one place. A read that silently stops at a page limit is worse than a read
that fails: a 105-item board read with `--limit 100` once dropped five `Ready` issues and the
session reported the wrong Ready count (#102).

## Board items

Read every item in one call, with a limit far above any real board, and let `gh` check the
count against the board's own `totalCount`:

```sh
gh project item-list <board.number> --owner <board.owner> --format json --limit 5000 --jq 'if (.items | length) < .totalCount then error("board read short: \(.items | length) of \(.totalCount) items") else .items[] end'
```

`totalCount` is the board's real item count whatever `--limit` says, so a short read exits
non-zero with `board read short: N of M items` instead of handing back partial data. Filter by
Status (or anything else) after this check, in a second step or a further `jq` stage, never by
lowering the limit. Never omit `--limit`: `gh` then returns only the first 30 items. The same goes for every
list read (`gh issue list`, `gh pr list`): a list with no `--limit` is a violation, not a
default.

Each command below stays on one line, so a permission rule can match it exactly. Send it as
one line.

Paging through GraphQL instead (`items(first:100, after:$cursor)` until `pageInfo.hasNextPage`
is false, then comparing the rows with `items.totalCount`) meets the same contract, and is
what triage's own read does.

## Open issues

`gh issue list` reports no total, so a result that reaches the limit is treated as truncated
(change the `--json` fields to what the step needs, never the limit check):

```sh
gh issue list --state open --limit 5000 --json number,title,labels --jq 'if length >= 5000 then error("issue list reached its limit of 5000; it may be short") else .[] end'
```

## When the count comes back short

Say so, with both numbers, and stop the step that needed the list. Do not count, choose,
report, or write from partial data: a Ready count, a work set, a reconcile diff or a release
list built from a short read is wrong in a way nobody can see. A failed read (no `gh`, no
auth, no board) is the same: it is never an empty board.
