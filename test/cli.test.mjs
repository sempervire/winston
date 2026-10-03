import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, loadLayers } from '../lib/config.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'bin/winston');

function sandbox(t) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'winston-cli-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = join(tmp, 'winston');
  const repo = join(tmp, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const env = { ...process.env, WINSTON_HOME: home, CODEX_HOME: join(tmp, 'codex'), PATH: `${bin}:${process.env.PATH}` };
  const cli = (args, cwd = repo) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  const fake = (name, script) => { writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`); chmodSync(join(bin, name), 0o755); };
  return { tmp, home, repo, env, cli, fake };
}

test('config: layers merge shallowly per top-level key, repo wins', (t) => {
  const s = sandbox(t);
  process.env.WINSTON_HOME = s.home;
  t.after(() => delete process.env.WINSTON_HOME);
  writeFileSync(join(s.home, 'config.json'), JSON.stringify({ owner: 'Pat', worktree: { copy: ['a'], link: ['b'] }, launcher: { repo: '~/x' } }));
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ worktree: { copy: ['c'] } }));
  assert.deepEqual(loadConfig(s.repo), { owner: 'Pat', worktree: { copy: ['c'] }, launcher: { repo: '~/x' } });
  assert.deepEqual(loadConfig(s.tmp), { owner: 'Pat', worktree: { copy: ['a'], link: ['b'] }, launcher: { repo: '~/x' } }, 'outside a repo: user layer only');
  writeFileSync(join(s.repo, '.winston/config.json'), '{ nope');
  assert.throws(() => loadLayers(s.repo), /repo\/\.winston\/config\.json is not valid JSON/);
  rmSync(join(s.home, 'config.json'));
  rmSync(join(s.repo, '.winston'), { recursive: true });
  assert.deepEqual(loadConfig(s.repo), {}, 'missing files are {}');
});

test('winston config prints the layers and the merged config', (t) => {
  const s = sandbox(t);
  writeFileSync(join(s.home, 'config.json'), JSON.stringify({ owner: 'Pat' }));
  const human = s.cli(['config']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /user layer: .*config\.json\n/);
  assert.match(human.stdout, /repo layer: .*\(not found\)/);
  assert.deepEqual(JSON.parse(s.cli(['config', '--json']).stdout), { owner: 'Pat' });
  writeFileSync(join(s.home, 'config.json'), '{');
  assert.equal(s.cli(['config']).status, 1);
});

test('install-codex-agents copies, keeps identical, and refuses a differing file without --force', (t) => {
  const s = sandbox(t);
  const sources = existsSync(join(ROOT, 'codex/agents')) ? readdirSync(join(ROOT, 'codex/agents')).filter((f) => f.endsWith('.toml')) : [];
  const first = s.cli(['install-codex-agents']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  if (!sources.length) return assert.match(first.stdout, /No Codex agents/);
  for (const f of sources) assert.equal(readFileSync(join(s.env.CODEX_HOME, 'agents', f), 'utf8'), readFileSync(join(ROOT, 'codex/agents', f), 'utf8'));
  assert.match(s.cli(['install-codex-agents']).stdout, /^same/m);
  const target = join(s.env.CODEX_HOME, 'agents', sources[0]);
  writeFileSync(target, 'local edit');
  const refused = s.cli(['install-codex-agents']);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /differs.*--force/);
  assert.equal(readFileSync(target, 'utf8'), 'local edit');
  assert.equal(s.cli(['install-codex-agents', '--force']).status, 0);
  assert.notEqual(readFileSync(target, 'utf8'), 'local edit');
});

test('doctor reports missing pieces and points at init; init plans, then creates with --yes', (t) => {
  const s = sandbox(t);
  s.fake('claude', 'exit 0');
  // gh: project scope, no labels yet, no board; label create logs its call.
  s.fake('gh', `case "$1 $2" in
    "auth status") echo "project, repo";;
    "label list") cat "${s.tmp}/labels" 2>/dev/null; true;;
    "label create") echo "$3" >> "${s.tmp}/labels";;
    *) exit 1;;
  esac`);
  const doc = s.cli(['doctor']);
  assert.equal(doc.status, 1);
  assert.match(doc.stdout, /^ok\s+claude on PATH/m);
  assert.match(doc.stdout, /^ok\s+gh auth with project scope/m);
  assert.match(doc.stdout, /^missing\s+repo config/m);
  assert.match(doc.stdout, /^missing\s+triage labels\s+— missing: risk: low/m);
  assert.match(doc.stdout, /^missing\s+triage-on-new-issue workflow/m);
  assert.match(doc.stdout, /^(on|off)\s+codex CLI/m);
  assert.match(doc.stdout, /Fix: winston init\n$/);

  const plan = s.cli(['init']);
  assert.equal(plan.status, 0);
  assert.match(plan.stdout, /would create:/);
  assert.match(plan.stdout, /--yes/);
  assert.ok(!existsSync(join(s.repo, '.winston/config.json')), 'no --yes, no change');

  const made = s.cli(['init', '--yes']);
  assert.equal(made.status, 0, made.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(s.repo, '.winston/config.json'), 'utf8')), JSON.parse(readFileSync(join(ROOT, 'templates/config.sample.json'), 'utf8')));
  assert.ok(existsSync(join(s.repo, '.github/workflows/triage-on-new-issue.yml')));
  assert.match(readFileSync(join(s.tmp, 'labels'), 'utf8'), /^risk: high$/m);

  // The sample config names branches and a board this sandbox lacks: doctor still
  // says so, and init now has only the hand fixes and the board left.
  const after = s.cli(['init']);
  assert.match(after.stdout, /board needs the owner's decisions/);
  assert.doesNotMatch(after.stdout, /would create/);
});

test('triage.labels extends the required set', (t) => {
  const s = sandbox(t);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ triage: { labels: ['HOLD', { name: 'verify-prod', color: '000000' }] } }));
  s.fake('gh', 'case "$1 $2" in "label list") printf "risk: low\\nrisk: medium\\nrisk: high\\nauto-merge\\nauto-verify\\nhuman-verify\\n";; *) exit 1;; esac');
  assert.match(s.cli(['doctor']).stdout, /triage labels\s+— missing: HOLD, verify-prod/);
});
