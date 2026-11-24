import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { coveredBy, permissionRules } from '../bin/winston';

// #102: a board read with `--limit 100` against a 105-item board silently dropped five Ready
// issues. Every board read and open-issue list in the skills goes through one shared
// instruction, which checks the returned count instead of trusting the limit.

const ROOT = resolve(import.meta.dirname, '..');
const SHARED = 'skills/winston/board-read.md';
const shared = readFileSync(join(ROOT, SHARED), 'utf8');

function markdown(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return markdown(p);
    return /\.(md|toml)$/.test(name) ? [p] : [];
  });
}
const docs = [...markdown(join(ROOT, 'skills')), ...markdown(join(ROOT, 'agents')), ...markdown(join(ROOT, 'codex'))]
  .map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));

// The fenced shell block that follows a heading in the shared file, joined into one command.
function command(heading) {
  const block = shared.split(`## ${heading}`)[1]?.match(/```sh\n([\s\S]*?)```/)?.[1];
  assert.ok(block, `${SHARED} has a command under "${heading}"`);
  return block.replace(/\\\n\s*/g, '').trim();
}
const jqOf = (cmd) => cmd.match(/--jq '([^']*)'/)?.[1];
const limitOf = (cmd) => Number(cmd.match(/--limit (\d+)/)?.[1]);

test('the shared board read checks the item count against the board\'s totalCount', () => {
  const board = command('Board items');
  assert.match(board, /^gh project item-list <board\.number> --owner <board\.owner> --format json /);
  assert.ok(limitOf(board) >= 1000, 'the limit is far above any real board');
  assert.match(jqOf(board), /\(\.items \| length\) < \.totalCount/);
  assert.match(jqOf(board), /error\("board read short/);
  assert.match(shared, /Never omit `--limit`/);
  assert.match(shared, /hasNextPage/, 'paging through GraphQL is named as the equivalent');
});

test('the shared open-issue list treats a result at the limit as truncated', () => {
  const issues = command('Open issues');
  assert.match(issues, /^gh issue list --state open /);
  const limit = limitOf(issues);
  assert.ok(limit >= 1000);
  assert.match(jqOf(issues), new RegExp(`length >= ${limit}`));
  assert.match(jqOf(issues), /error\(/);
});

test('a short read is reported and stops the step', () => {
  const text = shared.replace(/\s+/g, ' ');
  assert.match(text, /## When the count comes back short Say so, with both numbers, and stop the step/);
  assert.match(text, /never an empty board/);
});

test('the shared jq guards fail on a short read and pass a whole one', (t) => {
  if (spawnSync('jq', ['--version']).status !== 0) return t.skip('jq is not installed');
  const jq = (filter, input) => spawnSync('jq', ['-c', filter], { input: JSON.stringify(input), encoding: 'utf8' });
  const items = (n) => Array.from({ length: n }, (_, i) => ({ content: { number: i + 1 }, status: i < 5 ? 'Ready' : 'New' }));
  const board = jqOf(command('Board items'));
  const short = jq(board, { items: items(100), totalCount: 105 });
  assert.notEqual(short.status, 0, 'the 105-item board read at 100 fails');
  assert.match(short.stderr, /board read short: 100 of 105 items/);
  const whole = jq(board, { items: items(105), totalCount: 105 });
  assert.equal(whole.status, 0);
  assert.equal(whole.stdout.trim().split('\n').length, 105);

  const issuesCmd = command('Open issues');
  const issues = jqOf(issuesCmd);
  const limit = limitOf(issuesCmd);
  assert.notEqual(jq(issues, Array.from({ length: limit }, (_, i) => ({ number: i }))).status, 0, 'a list at the limit fails');
  assert.equal(jq(issues, [{ number: 1 }, { number: 2 }]).status, 0);
});

test('every skill that reads the board or lists open issues cites the shared instruction', () => {
  for (const name of ['winston', 'radar', 'triage']) {
    const text = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(text, /board-read\.md/, `skills/${name}/SKILL.md points at ${SHARED}`);
  }
  for (const { path, text } of docs) {
    if (path === SHARED) continue;
    if (/gh project item-list/.test(text)) assert.match(text, /board-read\.md/, `${path} reads board items and cites ${SHARED}`);
  }
});

test('no skill hardcodes an unchecked capped board or issue read', () => {
  for (const { path, text } of docs) {
    if (path === SHARED) continue;
    for (const [line] of text.matchAll(/^.*gh (?:project item-list|issue list)\b.*$/gm)) {
      const limit = line.match(/--limit (\d+)/)?.[1];
      // `--limit 1` picks any one issue (init's triage self-test); it is not a list to count.
      if (!limit || limit === '1') continue;
      assert.ok(Number(limit) >= 1000 && /error\(/.test(line + text.slice(text.indexOf(line) + line.length).split('\n')[1]), `${path}: "${line.trim()}" caps a read without a count check`);
    }
    assert.doesNotMatch(text, /item-list[^\n]*--limit 100\b/, `${path} reads the board at --limit 100`);
  }
});

test('the board read command is covered by the board allow rule winston permissions writes', () => {
  const { allow } = permissionRules({ board: { owner: 'acme', number: 6 } });
  const cmd = command('Board items').replace('<board.number>', '6').replace('<board.owner>', 'acme');
  assert.ok(coveredBy(`Bash(${cmd})`, allow), 'the shared read runs without a permission prompt');
  const issues = command('Open issues');
  assert.ok(coveredBy(`Bash(${issues})`, allow));
});
