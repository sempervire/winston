// chattr is part of Winston (#48). No skill, README line, doctor row or marketplace entry may
// describe it as optional or as a separate install to get; only the migration away from the old
// separate plugin may name that plugin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const PATTERNS = [
  /without chattr/i,
  /where chattr is installed/i,
  /\bwith chattr,/i,
  /chattr (is|as) (an? )?(optional|separate)/i,
  /optional[^.\n]{0,60}\bchattr\b/i,
  /\bchattr\b[^.\n]{0,60}\boptional\b/i,
  /(plugin|codex plugin) (install|add) chattr@/i,
  /who needs chattr/i,
  /chattr CLI/,
  /chattr needs Node 26/i,
];

function files() {
  const out = [join(ROOT, 'README.md'), join(ROOT, 'bin/winston'), join(ROOT, 'lib/chattr-checks.mjs')];
  for (const skill of readdirSync(join(ROOT, 'skills'))) {
    try {
      readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'));
      out.push(join(ROOT, 'skills', skill, 'SKILL.md'));
    } catch {}
  }
  return out;
}

test('no skill, README line or doctor row describes chattr as optional or separate', () => {
  const hits = [];
  for (const file of files()) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const re of PATTERNS) if (re.test(line)) hits.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the marketplace lists Winston only', () => {
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.deepEqual(market.plugins.map((p) => p.name), ['winston']);
});

test('the patterns catch the sentences they exist for', () => {
  for (const line of [
    'Without chattr there are no claims or peer visibility',
    'Where chattr is installed, add `chattr state`',
    '| chattr | Claims and peer messages | No account. Optional; see [Who needs chattr] |',
    'chattr is a separate plugin in the same marketplace',
    "add({ name: 'chattr CLI', required: false, state: 'off', detail: 'optional: peer messages, claims' })",
  ]) assert.ok(PATTERNS.some((re) => re.test(line)), line);
  assert.ok(!PATTERNS.some((re) => re.test('**Moving from the separate chattr plugin.** chattr used to be its own plugin.')));
});
