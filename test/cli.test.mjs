import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { harnessOfRoot } from '../lib/update.mjs';
import { loadConfig, loadLayers } from '../lib/config.mjs';
import { coveredBy, DOCTOR_POINTER, firesOnNewIssue, permissionRules, policyBlanks, policyState, repinTriage, tokenUrl, triageMechanism } from '../bin/winston';

const ROOT = resolve(import.meta.dirname, '..');

// The keys directly under a workflow's top-level `on:` block, each with the lines nested under it.
function triggers(text) {
  const block = text.match(/^on:\n((?:[ \t]+.*\n|\n)*)/m);
  assert.ok(block, 'the workflow has a block-style on:');
  const out = {};
  let key = null;
  for (const line of block[1].split('\n')) {
    const top = line.match(/^  ([A-Za-z_]+):/);
    if (top) out[key = top[1]] = '';
    else if (key && line.trim()) out[key] += line.trim() + '\n';
  }
  return out;
}

// Both installed workflows fire on a new issue and on a manual dispatch, and never on a timer (#76).
function assertNoTimer(text, name) {
  const on = triggers(text);
  assert.ok(!('schedule' in on), `${name} has no schedule trigger`);
  assert.doesNotMatch(text, /^\s*-\s*cron:/m, `${name} has no cron line`);
  assert.match(on.issues ?? '', /^types: \[opened\]$/m, `${name} runs on issues: opened`);
  assert.ok('workflow_dispatch' in on, `${name} can be dispatched by hand`);
}
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
  // No test asks the network for the latest version: the lookup reads a file that is absent unless a test writes it.
  const env = { ...process.env, WINSTON_HARNESS: 'claude', HOME: join(tmp, 'home'), WINSTON_HOME: home, CODEX_HOME: join(tmp, 'codex'), CLAUDE_CONFIG_DIR: join(tmp, 'claude'), WINSTON_UPDATE_URL: `file://${join(tmp, 'latest.json')}`, PATH: `${bin}:${process.env.PATH}` };
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

test('doctor on a repo with no config says it is not set up and points at init', (t) => {
  const s = sandbox(t);
  s.fake('claude', 'exit 0');
  s.fake('gh', `case "$1 $2" in
    "auth status") echo "project, repo";;
    "label list") true;;
    *) exit 1;;
  esac`);
  const doc = s.cli(['doctor']);
  assert.equal(doc.status, 1);
  assert.match(doc.stdout, /^done\s+Claude Code installed/m);
  assert.match(doc.stdout, /^done\s+GitHub sign-in with board access/m);
  assert.match(doc.stdout, /^needs you\s+Winston settings for this repo\s+— not set up yet$/m);
  // What follows from the config is init's to set up, not the person's: "after setup", no detail.
  assert.match(doc.stdout, /^after setup\s+Triage labels$/m);
  assert.match(doc.stdout, /^after setup\s+Automatic triage of new issues$/m);
  assert.match(doc.stdout, /^after setup\s+Fewer permission prompts$/m);
  assert.equal(doc.stdout.match(/^needs you/gm).length, 1, 'the rows agree with "Needs you (1)"');
  assert.match(doc.stdout, /^(on|off)\s+Codex \(second opinions\)/m);
  assert.match(doc.stdout, /^Winston setup checklist for repo\. Safe to run again: it only reads\.\n/, 'the repo by name, not its path');
  // A repo with no config has one thing to do, and the last line names it.
  assert.match(doc.stdout, /Needs you \(1\):\n\n1\. Winston settings for this repo\n   Why: [^\n]+\n   Fix:\n     Type \/winston:init in this Claude Code chat\. It shows its plan and changes nothing until you say yes/);
  assert.match(doc.stdout, /\nNext step: Winston settings for this repo – type \/winston:init in this Claude Code chat\. Then run \/winston:doctor again\.\n$/);
});

test('doctor finds a missing kanban view and starting milestone; init creates them', (t) => {
  const s = sandbox(t);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ board: { owner: 'acme', number: 1 } }));
  const board = {
    data: { repositoryOwner: { projectV2: {
      id: 'PROJECT1', title: 'Acme board',
      fields: { nodes: [
        { id: 'STATUS1', name: 'Status', options: [{ name: 'New' }, { name: 'Ready' }, { name: 'In Progress' }, { name: 'Verify' }, { name: 'Verified' }, { name: 'Done' }] },
        { id: 'PRIO1', name: 'Priority' }, { id: 'TITLE1', name: 'Title' }, { id: 'LABELS1', name: 'Labels' },
      ] },
      views: { nodes: [] },
    } } } };
  writeFileSync(join(s.tmp, 'board.json'), JSON.stringify(board));
  s.fake('gh', `case "$1 $2" in
    "auth status") echo "project, repo";;
    "label list") printf "risk: low\\nrisk: medium\\nrisk: high\\nauto-merge\\nauto-verify\\nhuman-verify\\n";;
    "label create") exit 0;;
    "api graphql") case "$*" in
      *createProjectV2View*) echo "$*" >> "${s.tmp}/view-create-calls"; echo '{"data":{"createProjectV2View":{"projectV2View":{"id":"VIEW1"}}}}';;
      *updateProjectV2View*) echo "$*" >> "${s.tmp}/view-filter-calls"; echo '{"data":{"updateProjectV2View":{"projectV2View":{"id":"VIEW1"}}}}';;
      *) cat "${s.tmp}/board.json";;
      esac;;
    "api --method") cat "${s.tmp}/milestones" 2>/dev/null; true;;
    "api repos/{owner}/{repo}/milestones") echo "$*" >> "${s.tmp}/milestone-create-calls"; echo "Phase 1.0" >> "${s.tmp}/milestones";;
    *) exit 1;;
  esac`);

  const doc = s.cli(['doctor']);
  assert.match(doc.stdout, /^done\s+Board access/m);
  assert.match(doc.stdout, /^needs you\s+Board column view\s+— no view that shows the work in columns/m);
  assert.match(doc.stdout, /^needs you\s+Current phase exists\s+— no open milestone/m);
  // Neither new check needs the owner's input, so init can create both on its own.
  assert.match(doc.stdout, /\d\. Board column view\n   Why: [^\n]+\n   Fix:\n     Type \/winston:init in this Claude Code chat\. [^\n]*\. It will: Add a board view that shows the work in columns/);

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout);
  assert.match(made.stdout, /done\s+Create the first phase, the milestone "Phase 1\.0"/);
  assert.match(made.stdout, /done\s+Add a board view that shows the work in columns, for the current phase, with labels on each card/);
  assert.equal(readFileSync(join(s.tmp, 'milestone-create-calls'), 'utf8').trim().split('\n').length, 1, 'the milestone is created exactly once, not once per check');
  assert.match(readFileSync(join(s.tmp, 'view-filter-calls'), 'utf8'), /filter:"milestone:\\"Phase 1\.0\\""/);
});

test('init creates the kanban view against an existing milestone instead of making a new one', (t) => {
  const s = sandbox(t);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ board: { owner: 'acme', number: 1 } }));
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\n');
  const board = {
    data: { repositoryOwner: { projectV2: {
      id: 'PROJECT1', title: 'Acme board',
      fields: { nodes: [
        { id: 'STATUS1', name: 'Status', options: [{ name: 'New' }, { name: 'Ready' }, { name: 'In Progress' }, { name: 'Verify' }, { name: 'Verified' }, { name: 'Done' }] },
        { id: 'PRIO1', name: 'Priority' }, { id: 'TITLE1', name: 'Title' }, { id: 'LABELS1', name: 'Labels' },
      ] },
      views: { nodes: [] },
    } } } };
  writeFileSync(join(s.tmp, 'board.json'), JSON.stringify(board));
  s.fake('gh', `case "$1 $2" in
    "auth status") echo "project, repo";;
    "label list") printf "risk: low\\nrisk: medium\\nrisk: high\\nauto-merge\\nauto-verify\\nhuman-verify\\n";;
    "label create") exit 0;;
    "api graphql") case "$*" in
      *createProjectV2View*) echo "$*" >> "${s.tmp}/view-create-calls"; echo '{"data":{"createProjectV2View":{"projectV2View":{"id":"VIEW1"}}}}';;
      *updateProjectV2View*) echo "$*" >> "${s.tmp}/view-filter-calls"; echo '{"data":{"updateProjectV2View":{"projectV2View":{"id":"VIEW1"}}}}';;
      *) cat "${s.tmp}/board.json";;
      esac;;
    "api --method") cat "${s.tmp}/milestones" 2>/dev/null; true;;
    "api repos/{owner}/{repo}/milestones") echo "$*" >> "${s.tmp}/milestone-create-calls"; echo "Phase 1.0" >> "${s.tmp}/milestones";;
    *) exit 1;;
  esac`);

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout);
  assert.match(readFileSync(join(s.tmp, 'view-filter-calls'), 'utf8'), /filter:"milestone:\\"Pilot\\""/);
  assert.ok(!existsSync(join(s.tmp, 'milestone-create-calls')), 'an existing milestone is reused, not created');
});

test('triage.labels extends the required set', (t) => {
  const s = sandbox(t);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ triage: { labels: ['HOLD', { name: 'verify-prod', color: '000000' }] } }));
  s.fake('gh', 'case "$1 $2" in "label list") printf "risk: low\\nrisk: medium\\nrisk: high\\nauto-merge\\nauto-verify\\nhuman-verify\\n";; *) exit 1;; esac');
  assert.match(s.cli(['doctor']).stdout, /Triage labels\s+— missing: HOLD, verify-prod/);
});

// A gh that answers from files in the sandbox and logs every call, for the init modes.
function fakeGh(s) {
  s.env.GIT_AUTHOR_NAME = s.env.GIT_COMMITTER_NAME = 'Pat';
  s.env.GIT_AUTHOR_EMAIL = s.env.GIT_COMMITTER_EMAIL = 'pat@example.com';
  s.fake('gh', `echo "$*" >> "${s.tmp}/gh-calls"
  case "$1 $2" in
    "auth status") echo "project, repo";;
    "api user") echo "pat";;
    "api repos/sempervire/"*) cat "${s.tmp}/published.json" 2>/dev/null || exit 1;;
    "api users/"*) cat "${s.tmp}/owner-type" 2>/dev/null || echo "User";;
    "repo view") echo "acme/thing";;
    "repo create") git init -q --bare "${s.tmp}/origin.git" && git -C "${s.repo}" remote add origin "${s.tmp}/origin.git" && git -C "${s.repo}" push -q origin HEAD;;
    "project create") echo '{"number":7,"id":"P7"}'; cp "${s.tmp}/new-board.json" "${s.tmp}/board.json";;
    "project field-create"|"project link") ;;
    "label list") cat "${s.tmp}/labels" 2>/dev/null; true;;
    "label create") echo "$3" >> "${s.tmp}/labels";;
    "secret list") if [ -f "${s.tmp}/secrets-denied" ]; then echo "HTTP 403: Resource not accessible" >&2; exit 1; fi; cat "${s.tmp}/secrets" 2>/dev/null; true;;
    "secret set"|"workflow run") echo "never run by winston" >&2; exit 1;;
    "run list") cat "${s.tmp}/runs" 2>/dev/null || exit 1;;
    "issue list") if [ -f "${s.tmp}/issues-denied" ]; then exit 1; fi; cat "${s.tmp}/issues-bare" 2>/dev/null; true;;
    "issue edit") : > "${s.tmp}/issues-bare";;
    "api graphql") case "$*" in
      *createProjectV2View*) echo '{"data":{"createProjectV2View":{"projectV2View":{"id":"VIEW1"}}}}';;
      *updateProjectV2View*) echo '{}';;
      *updateProjectV2Field*) echo '{}'; if [ -f "${s.tmp}/board-after.json" ]; then cp "${s.tmp}/board-after.json" "${s.tmp}/board.json"; fi;;
      *projectsV2*) cat "${s.tmp}/linked.json";;
      *timelineItems*) cat "${s.tmp}/timeline.json" 2>/dev/null || echo '{"data":{"repository":{"issues":{"nodes":[]}}}}';;
      *) cat "${s.tmp}/board.json" 2>/dev/null || exit 1;;
      esac;;
    "api --method") case "$4" in
      "repos/{owner}/{repo}/milestones") cat "${s.tmp}/milestones" 2>/dev/null; true;;
      "repos/{owner}/{repo}/issues") cat "${s.tmp}/issues" 2>/dev/null; true;;
      *) exit 1;;
    esac;;
    "api repos/{owner}/{repo}/milestones") echo "Phase 1.0" >> "${s.tmp}/milestones";;
    "api repos/{owner}/{repo}/issues/"*) n="\${2##*/issues/}"; n="\${n%/timeline}"; cat "${s.tmp}/timeline-$n" 2>/dev/null; true;;
    *) exit 1;;
  esac`);
  s.fake('claude', 'exit 0');
  s.calls = () => (existsSync(join(s.tmp, 'gh-calls')) ? readFileSync(join(s.tmp, 'gh-calls'), 'utf8') : '');
  s.git = (...args) => execFileSync('git', ['-C', s.repo, ...args], { env: s.env, encoding: 'utf8' }).trim();
}

const boardJson = ({ options = ['New', 'Ready', 'In Progress', 'Verify', 'Verified', 'Done'], priority = true, workflows = [], views = [] } = {}) => JSON.stringify({
  data: { repositoryOwner: { projectV2: {
    id: 'PROJECT1', title: 'Acme board',
    fields: { nodes: [
      { id: 'STATUS1', name: 'Status', options: options.map((name, i) => ({ id: `opt${i}`, name, color: 'GRAY', description: '' })) },
      ...(priority ? [{ id: 'PRIO1', name: 'Priority' }] : []),
      { id: 'TITLE1', name: 'Title' }, { id: 'LABELS1', name: 'Labels' }, { id: 'LINKED1', name: 'Linked pull requests' },
    ] },
    workflows: { nodes: workflows.map((w) => (typeof w === 'string' ? { name: w, enabled: true } : w)) },
    views: { nodes: views },
  } } } });
// As GitHub returns a board view: the columns are the vertical grouping, groupByFields is empty.
const KANBAN = [{ id: 'VIEW9', name: 'Pilot', layout: 'BOARD_LAYOUT', fields: { nodes: [{ id: 'TITLE1', name: 'Title' }, { id: 'LABELS1', name: 'Labels' }] }, groupByFields: { nodes: [] }, verticalGroupByFields: { nodes: [{ name: 'Status' }] } }];
const KANBAN_NO_LABELS = [{ ...KANBAN[0], fields: { nodes: [{ id: 'TITLE1', name: 'Title' }] } }];
const INTAKE = ['Auto-add to project', 'Item added to project'];
// Recent issues with their project events: [number, [[type, actor, board owner, board number, createdAt?], ...], { createdAt?, closed? }?].
const BOT = 'github-project-automation';
const timelineJson = (issues) => JSON.stringify({ data: { repository: { issues: { nodes: issues.map(([number, events, issue = {}]) => ({ number, ...issue, timelineItems: { nodes: events.map(([type, login, owner, n, at]) => ({ __typename: type === 'add' ? 'AddedToProjectV2Event' : 'ProjectV2ItemStatusChangedEvent', ...(at ? { createdAt: at } : {}), actor: { login }, project: { number: n, title: `Project ${n}`, owner: { login: owner } } })) } })) } } } });
const linkedJson = (boards) => JSON.stringify({ data: { repository: { projectsV2: { nodes: boards.map(([login, number, title]) => ({ number, title, closed: false, owner: { login } })) } } } });

// An existing repo: one commit holding AGENTS.md on main, pushed to a bare origin.
function existingRepo(s) {
  s.git('symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(join(s.repo, 'AGENTS.md'), '# Rules\n');
  s.git('add', 'AGENTS.md');
  s.git('commit', '-q', '-m', 'first');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(s.tmp, 'origin.git')]);
  s.git('remote', 'add', 'origin', join(s.tmp, 'origin.git'));
  s.git('push', '-q', 'origin', 'main');
}
const originHeads = (s) => execFileSync('git', ['-C', join(s.tmp, 'origin.git'), 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { encoding: 'utf8' }).trim().split('\n').sort();

test('init without --mode plans the setup the folder shows, says which in plain words, and changes nothing', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  const asked = s.cli(['init']);
  assert.equal(asked.status, 0, asked.stdout + asked.stderr);
  assert.match(asked.stdout, /^Setup: new, because this project has no saved history yet\. This is a new project, so Winston sets everything up\.\n/);
  assert.doesNotMatch(asked.stdout, /To choose a different setup/, 'no saved history and no settings: neither join nor adopt fits');
  assert.match(asked.stdout, /Winston will:\n/);
  assert.match(asked.stdout, /To go ahead, in this Claude Code chat, type: !winston init --mode new --yes/, 'the apply command names the mode the plan used');
  const forced = s.cli(['init', '--yes']);
  assert.equal(forced.status, 2, '--yes never picks the setup');
  assert.match(forced.stderr, /needs the setup named: in this Claude Code chat, type: !winston init --mode new --yes/);
  assert.equal(s.cli(['init', '--mode', 'sideways']).status, 2);
  // A flag missing its value never swallows the next flag, and unknown flags are refused.
  for (const bad of [['--mode', 'new', '--integration', '--yes'], ['--mode'], ['--mode', 'new', '--yess']]) {
    const r = s.cli(['init', ...bad]);
    assert.equal(r.status, 1, bad.join(' '));
    assert.match(r.stderr, /needs a value|unknown argument/);
  }
  assert.ok(!existsSync(join(s.repo, '.winston')), 'nothing written');
  assert.doesNotMatch(s.calls(), /create|link|edit/, 'GitHub only read');

  existingRepo(s);
  writeFileSync(join(s.tmp, 'linked.json'), linkedJson([]));
  const adopt = s.cli(['init']).stdout;
  assert.match(adopt, /^Setup: adopt, because this project is on GitHub and Winston has not been set up in it\. This is an existing project/);
  assert.match(adopt, /To choose a different setup, in this Claude Code chat, type: !winston init --mode new\n/, 'join is not offered where there are no settings to join');
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), '{}');
  const joined = s.cli(['init']).stdout;
  assert.match(joined, /^Setup: join, because Winston's settings are already in this project\./);
  assert.match(joined, /To choose a different setup, in this Claude Code chat, type: !winston init --mode adopt\n/);
});

test('init refuses the home folder and a folder of projects, and asks first where history has no GitHub link', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  // s.tmp holds the sandbox's git repo, so it is a folder of projects, not a project (HOME moved out of it).
  s.env.HOME = '/nonexistent-winston-home';
  for (const args of [['init'], ['init', '--mode', 'new']]) {
    const r = s.cli(args, s.tmp);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stdout, /^This folder doesn't look like a project\. Open Claude Code in your project's folder[^\n]*\n\(Winston did not use [^\n]*: it holds other projects \(repo\)\.\)\nIf repo is your project, open Claude Code there \(in the Terminal app: cd 'repo', then claude\) and type \/winston:init in this Claude Code chat\. If this folder itself is your project, run git init here first \(in the Terminal app\), then type \/winston:init in this Claude Code chat\.\n$/);
  }
  // Doctor there says where to go instead of sending the person to init.
  const doc = s.cli(['doctor'], s.tmp);
  assert.match(doc.stdout, /^needs you\s+Project folder uses git\s+— this folder is not a project folder: it holds other projects \(repo\)$/m);
  assert.match(doc.stdout, /Fix:\n     This folder doesn't look like a project\. Open Claude Code in your project's folder[^\n]* If repo is your project, open Claude Code there/);
  const home = spawnSync(process.execPath, [CLI, 'init', '--mode', 'new'], { cwd: s.tmp, env: { ...s.env, HOME: s.tmp }, encoding: 'utf8' });
  assert.match(home.stdout, /it is your home folder/);
  // The home folder (here it also holds a repo) is never told to run git init or to cd somewhere.
  assert.doesNotMatch(home.stdout, /git init|cd '/);
  const homeDoc = spawnSync(process.execPath, [CLI, 'doctor'], { cwd: s.tmp, env: { ...s.env, HOME: s.tmp }, encoding: 'utf8' });
  assert.match(homeDoc.stdout, /Fix:\n     This folder doesn't look like a project\.[^\n]*again\.\n/);
  assert.doesNotMatch(homeDoc.stdout, /git init/);
  // In Codex the way out names Codex and the skill.
  const codexWay = spawnSync(process.execPath, [CLI, 'init'], { cwd: s.tmp, env: { ...s.env, WINSTON_HARNESS: 'codex' }, encoding: 'utf8' });
  assert.match(codexWay.stdout, /If repo is your project, open Codex there \(in the Terminal app: cd 'repo', then codex\) and ask Codex to use the winston:init skill\./);
  // A home folder that is itself a git repository is refused too.
  const gitHome = spawnSync(process.execPath, [CLI, 'init'], { cwd: s.repo, env: { ...s.env, HOME: s.repo }, encoding: 'utf8' });
  assert.equal(gitHome.status, 1);
  assert.match(gitHome.stdout, /^This folder doesn't look like a project\.[^]*it is your home folder/);
  assert.ok(s.calls().trim().split('\n').every((l) => l.startsWith('auth status')), 'GitHub not touched beyond doctor reading the sign-in');
  // History and no GitHub address: maybe a copy that lost its link, so say how to connect it.
  s.git('symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(join(s.repo, 'a.txt'), 'a');
  s.git('add', 'a.txt');
  s.git('commit', '-q', '-m', 'a');
  const plan = s.cli(['init']);
  assert.match(plan.stdout, /^Setup: new, because this project is not on GitHub yet\./);
  assert.match(plan.stdout, /Check first: if this project is already on GitHub, connect this copy to it[^]*git remote add origin <the project's GitHub address>/);
});

test('init --mode new creates the repo, both branches, the board and the config, in that order', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  // A new project as GitHub makes it: stock statuses, no Priority, "Item added" already on.
  writeFileSync(join(s.tmp, 'new-board.json'), boardJson({ options: ['Todo', 'In Progress', 'Done'], priority: false, workflows: ['Item added to project'] }));
  writeFileSync(join(s.tmp, 'board-after.json'), boardJson({ workflows: ['Item added to project'] }));
  s.git('symbolic-ref', 'HEAD', 'refs/heads/main');
  s.git('config', 'user.name', 'Pat');
  writeFileSync(join(s.repo, 'notes.txt'), 'not Winston\'s to commit');

  const plan = s.cli(['init', '--mode', 'new']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /^This is a new project, so Winston sets everything up\.\n\nWinston will:\n/);
  assert.match(plan.stdout, /Make a private board, "repo", where your work is tracked[^\n]*\(a GitHub Project under pat\)/);
  assert.match(plan.stdout, /Put the project on GitHub as a private repository, pat\/repo, and upload main/);
  assert.match(plan.stdout, /Make the work branch, staging, on GitHub/);
  assert.match(plan.stdout, /Add the labels triage uses to rate each issue: risk: low/);
  assert.match(plan.stdout, /Save Winston's settings for this project \(\.winston\/config\.json\): releases from main, work lands on staging first, uses the new board\. Merging into main will need you to type "approve production deploy" in the session first/, 'repo-relative paths, plain words, and the default deploy gate stated');
  assert.doesNotMatch(plan.stdout, /process docs none found|No deploy gate/);
  // The one absolute path is the cd that starts the paste-ready command that lands the files.
  assert.doesNotMatch(plan.stdout.replaceAll(`cd '${s.repo}'`, ''), new RegExp(s.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no absolute paths into the repo');
  assert.match(plan.stdout, /\nNote: These files only start working once they are saved to main on GitHub [^\n]*: \.winston\/config\.json, \.github\/workflows\/set-issue-phase\.yml, TRIAGE\.md\. Next: \/winston:init asks in a question box \(recommended: yes\)/, 'one note for every file, including the config the phase step changes after the first commit');
  assert.doesNotMatch(plan.stdout, /Add .*triage-on-new-issue\.yml/, 'the first commit writes the workflow; it is not planned twice');
  assert.match(plan.stdout, /In the browser[^]*open the new board's Workflows page, choose "Auto-add to project"/);
  assert.doesNotMatch(plan.stdout, /set Status to New/, 'a new project already has "Item added" on, and init points it at New');
  assert.ok(!existsSync(join(s.repo, '.winston')), 'no --yes, no change');
  assert.doesNotMatch(s.calls(), /project create|repo create|label create/);

  const made = s.cli(['init', '--mode', 'new', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const config = JSON.parse(readFileSync(join(s.repo, '.winston/config.json'), 'utf8'));
  assert.deepEqual(config.branches, { integration: 'staging', production: 'main' });
  assert.deepEqual(config.board, { owner: 'pat', number: 7, statuses: ['New', 'Ready', 'Verify', 'Verified'], priorityField: 'Priority' });
  assert.equal(config.owner, 'Pat');
  assert.deepEqual(config.deployGate, { phrase: 'approve production deploy', guarded: [{ kind: 'pr-merge', base: 'main' }] }, 'every config init writes carries the default deploy gate');
  assert.deepEqual(originHeads(s), ['main', 'staging']);
  assert.deepEqual(s.git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.github/workflows/triage-on-new-issue.yml', '.winston/config.json'], 'the first commit holds only what init wrote');
  assertNoTimer(readFileSync(join(s.repo, '.github/workflows/triage-on-new-issue.yml'), 'utf8'), 'the installed triage workflow');
  const calls = s.calls();
  assert.match(calls, /updateProjectV2Field[^\n]*\[\{id:"opt0",name:"New",color:BLUE,description:"New issues, waiting to be looked at\."\},\{name:"Ready",color:GREEN[^\n]*\{id:"opt1",name:"In Progress",color:YELLOW[^\n]*\{name:"Verify",color:RED[^\n]*\{name:"Verified",color:GRAY[^\n]*\{id:"opt2",name:"Done",color:PURPLE/, 'six columns in order; each stock option kept by id, Todo as New so the board\'s own workflow sets it');
  assert.match(calls, /project field-create 7 --owner pat --name Start date --data-type DATE/);
  assert.match(calls, /project field-create 7 --owner pat --name Target date --data-type DATE/);
  assert.match(calls, /updateProjectV2View\(input:\{viewId:\$viewId,configuration:\{visibleFieldIds:\["TITLE1","STATUS1","LABELS1","LINKED1"\]\},filter:"milestone:\\"Phase 1\.0\\""\}/, 'the new view shows labels on its cards');
  assert.equal(calls.match(/updateProjectV2Field/g).length, 1);
  assert.match(calls, /project field-create 7 --owner pat --name Priority/);
  assert.match(calls, /project link 7 --owner pat --repo repo$/m);
  assert.ok(calls.indexOf('project create') < calls.indexOf('repo create') && calls.indexOf('repo create') < calls.indexOf('project link'));
  assert.match(readFileSync(join(s.tmp, 'labels'), 'utf8'), /^risk: high$/m);
  assert.match(made.stdout, /done\s+Add a board view that shows the work in columns/);
  assert.match(made.stdout, /\nNext: \/winston:doctor to see what's left\.\n$/);
  // The board is brand new and has no issues yet, so the "off" from the API cannot be told
  // apart from "on but not yet proven" (#45): not a required step, just an optional one.
  assert.match(made.stdout, /Could not confirm \(may already be on; optional, in the browser\):\n {2}- Board adds new issues: open https:\/\/github\.com\/users\/pat\/projects\/7\/workflows, choose "Auto-add to project", click Edit, pick this repository and set the filter to is:issue/);
});

test('init --mode adopt fits the config to the repo and adds to its board without replacing anything', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  existingRepo(s);
  writeFileSync(join(s.tmp, 'linked.json'), linkedJson([['acme', 3, 'Roadmap']]));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ options: ['Todo', 'Ready'], priority: false, workflows: INTAKE, views: KANBAN_NO_LABELS }));
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\n');

  const plan = s.cli(['init', '--mode', 'adopt']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /^This is an existing project Winston hasn't set up yet, so Winston adds only what is missing\. Nothing you already have is renamed or removed\.\n\nWinston will:\n/);
  assert.match(plan.stdout, /releases from main, work lands on staging first, uses board #3 \(acme\), follows AGENTS\.md/);
  assert.match(plan.stdout, /Add the board columns Winston uses: New, In Progress, Verify, Verified, Done \(the board's existing columns stay as they are\)/);
  assert.match(plan.stdout, /Show labels on the cards of the board view: Pilot/);
  assert.match(plan.stdout, /Add a Priority field to the board/);
  assert.match(plan.stdout, /Note: These files only start working once they are saved to main on GitHub \(GitHub runs workflows, and reads the settings they use, from there only\): \.winston\/config\.json, \.github\/workflows\/triage-on-new-issue\.yml, TRIAGE\.md\. Next: /);
  assert.equal(plan.stdout.match(/\nNote: /g).length, 1, 'one note, not one per file');
  assert.match(plan.stdout, /Add TRIAGE\.md, the rules triage follows, filled in from these settings\. Winston's standard risk ratings come with it and work as they are/);
  assert.doesNotMatch(plan.stdout, /In the browser|By hand/, 'both intake workflows are on');
  assert.ok(!existsSync(join(s.repo, '.winston')));

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const config = JSON.parse(readFileSync(join(s.repo, '.winston/config.json'), 'utf8'));
  assert.deepEqual(config.board, { owner: 'acme', number: 3, statuses: ['New', 'Ready', 'Verify', 'Verified'], priorityField: 'Priority' });
  assert.deepEqual(config.processDocs, ['AGENTS.md']);
  assert.equal(config.triage.policy, 'TRIAGE.md');
  assert.equal(policyState(join(s.repo, 'TRIAGE.md')), 'ok', 'the starter itself passes the rules test');
  assert.deepEqual(originHeads(s), ['main', 'staging']);
  const calls = s.calls();
  assert.doesNotMatch(calls, /project create|repo create/);
  assert.match(calls, /updateProjectV2Field[^\n]*\[\{name:"New",color:BLUE[^\n]*\{id:"opt1",name:"Ready",color:GRAY,description:""\},\{name:"In Progress"[^\n]*\{name:"Done",color:PURPLE[^\n]*\{id:"opt0",name:"Todo",color:GRAY,description:""\}\]/, 'existing options go back by id, unchanged; unknown ones follow');
  assert.match(calls, /updateProjectV2View\(input:\{viewId:\$viewId,configuration:\{visibleFieldIds:\["TITLE1","LABELS1"\]\}\}/, 'Labels is added to what the view already shows; its filter is not touched');
  assert.match(calls, /project field-create 3 --owner acme --name Priority/);
  assert.equal(s.git('rev-list', '--count', 'HEAD'), '1', 'an existing repo is not committed to');

  // An existing staging-like branch is used, not a new one made.
  rmSync(join(s.repo, '.winston'), { recursive: true });
  s.git('push', '-q', 'origin', 'main:develop');
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /work lands on staging first/, 'staging exists now and wins');
  const develop = s.cli(['init', '--mode', 'adopt', '--integration', 'develop']).stdout;
  assert.match(develop, /work lands on develop first/);
  assert.doesNotMatch(develop, /Make the work branch/);
  assert.match(develop, /To go ahead, in this Claude Code chat, type: !winston init --mode adopt --integration develop --yes/, 'the apply command keeps the flags the plan was made with');
});

test('with a config already here, init creates the integration branch it names when origin lacks it', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  existingRepo(s);
  mkdirSync(join(s.repo, '.winston'));
  const write = (branches) => writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ branches, board: { owner: 'acme', number: 1 }, phase: false }));
  write({ integration: 'staging', production: 'main' });
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\n');
  writeFileSync(join(s.tmp, 'labels'), 'risk: low\nrisk: medium\nrisk: high\nauto-merge\nauto-verify\nhuman-verify\n');
  writeFileSync(join(s.repo, 'TRIAGE.md'), '# Triage policy\n');
  mkdirSync(join(s.repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(s.repo, '.github/workflows/triage-on-new-issue.yml'), '');

  assert.match(s.cli(['doctor']).stdout, /\d\. Work branch on GitHub\n   Why: [^\n]+\n   Fix:\n     Type \/winston:init in this Claude Code chat\. [^\n]*It will: Make the work branch, staging, on GitHub/);
  const plan = s.cli(['init', '--mode', 'adopt']);
  assert.match(plan.stdout, /Winston will:\n\s+- Make the work branch, staging, on GitHub \(a copy of main where finished work waits to be checked\)\n/);
  assert.doesNotMatch(plan.stdout, /By hand/);
  assert.deepEqual(originHeads(s), ['main'], 'a plan changes nothing');

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.match(made.stdout, /done\s+Make the work branch, staging, on GitHub/);
  assert.deepEqual(originHeads(s), ['main', 'staging']);
  assert.match(s.cli(['doctor']).stdout, /^done\s+Work branch on GitHub\s+— staging$/m);

  // join changes nothing on GitHub: the gap stays the owner's.
  write({ integration: 'develop', production: 'main' });
  assert.match(s.cli(['init', '--mode', 'join', '--yes']).stdout, /They are [^\n]* to close[^]*- Work branch on GitHub — develop is not on GitHub/);
  assert.deepEqual(originHeads(s), ['main', 'staging']);

  // A production branch origin lacks is a wrong config, not something to create.
  write({ integration: 'develop', production: 'release' });
  const wrong = s.cli(['init', '--mode', 'adopt']);
  assert.doesNotMatch(wrong.stdout, /Make the work branch/);
  assert.match(wrong.stdout, /By hand \(each line says what to do next\):\n(\s+- [^\n]+\n)*\s+- Work branch on GitHub: develop is not on GitHub, and Winston makes it from the release branch, which must be on GitHub first/);
  assert.match(wrong.stdout, /- Release branch on GitHub: the settings name release as the release branch, and GitHub has no branch by that name: set branches\.production in \.winston\/config\.json/);
});

test('a workflow fires on a new issue when its on: names issues, with opened or with no types', () => {
  const yes = [
    'on: issues\n',
    'on: [push, issues]\n',
    'on:\n  issues:\n    types: [opened]\njobs: {}\n',
    'on:\n  issues:\n    types:\n      - edited\n      - opened\n',
    'on:\n  issues:\n  push:\n',
    'on:\n  - issues\n',
    '"on":\n  issues: { types: [opened, reopened] }\n',
    'name: x\n# on: nothing\non:\n  workflow_dispatch:\n  issues:\n    types: [opened] # new ones\n',
    'on:\n- issues\n- push\njobs: {}\n',
    'on: {issues: {types: [opened]}, pull_request: {types: [closed]}}\n',
    'on: {push: {}, issues}\n',
    'on:\r\n  issues:\r\n    types: [opened]\r\n',
  ];
  const no = [
    'on: push\n',
    'on:\n  issues:\n    types: [closed, labeled]\n',
    'on:\n  issue_comment:\n    types: [created]\n',
    'on:\n  push:\njobs:\n  issues:\n    types: [opened]\n',
    'jobs: {}\n',
    'on: {issues: {types: [labeled]}, pull_request: {types: [opened]}}\n',
    'on:\n  workflow_dispatch:\n    inputs:\n      issues:\n        description: how many\n',
    'on:\n  push:\n    branches:\n      - issues\n',
    'on:\n- push\n- pull_request\n',
  ];
  for (const text of yes) assert.equal(firesOnNewIssue(text), true, text);
  for (const text of no) assert.equal(firesOnNewIssue(text), false, text);
  assert.equal(firesOnNewIssue(readFileSync(join(ROOT, 'templates/triage-on-new-issue.yml'), 'utf8')), true);
});

test('a second workflow that triages new issues is the owner\'s choice: doctor reports it, init asks before writing', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  existingRepo(s);
  s.git('push', '-q', 'origin', 'main:staging');
  mkdirSync(join(s.repo, '.winston'));
  const configPath = join(s.repo, '.winston/config.json');
  const base = { branches: { integration: 'staging', production: 'main' }, board: { owner: 'acme', number: 1 }, phase: false };
  const reset = () => writeFileSync(configPath, JSON.stringify(base));
  const config = () => JSON.parse(readFileSync(configPath, 'utf8'));
  reset();
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\n');
  writeFileSync(join(s.tmp, 'labels'), 'risk: low\nrisk: medium\nrisk: high\nauto-merge\nauto-verify\nhuman-verify\n');
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  writeFileSync(join(s.repo, 'TRIAGE.md'), '# Triage policy\n');
  const dir = join(s.repo, '.github/workflows');
  mkdirSync(dir, { recursive: true });
  const ours = join(dir, 'triage-on-new-issue.yml');
  const theirs = join(dir, 'auto-triage.yml');
  const rival = () => writeFileSync(theirs, 'name: auto-triage\non:\n  issues:\n    types: [opened]\njobs:\n  triage:\n    steps:\n      - run: echo "risk: high"\n');
  // Runs on a new issue and does not triage; a workflow that triages and runs on something else.
  writeFileSync(join(dir, 'greet.yml'), 'on:\n  issues:\n    types: [opened]\njobs:\n  hello:\n    steps:\n      - run: echo welcome\n');
  writeFileSync(join(dir, 'label.yml'), 'name: Label new issues\non:\n  issues:\n    types: [opened]\njobs:\n  label:\n    steps:\n      - run: gh issue edit "$N" --add-label needs-triage\n');
  writeFileSync(join(dir, 'weekly.yml'), 'on:\n  schedule:\n    - cron: "0 6 * * 1"\njobs:\n  triage:\n    steps:\n      - run: echo sweep\n');

  // Only Winston's: nothing new.
  writeFileSync(ours, '');
  assert.doesNotMatch(s.cli(['doctor']).stdout, /triage workflow conflicts/);
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /(the setup is complete|Winston's part of the setup is done)\. Nothing was changed/);

  // Both on disk: doctor reports it, and init asks rather than guess.
  rival();
  const doc = s.cli(['doctor']);
  assert.match(doc.stdout, /^needs you\s+Two workflows triage new issues\s+— auto-triage\.yml also triages every new issue$/m);
  assert.match(doc.stdout, /\d\. Two workflows triage new issues\n   Why: Two workflows[^\n]+\n   Fix:\n     auto-triage\.yml and Winston's triage-on-new-issue\.yml would both triage every new issue[^\n]*Recommended: let Winston's replace it[^\n]*!winston init --mode adopt --triage replace[^\n]*--triage keep[^\n]*--triage both/);
  assert.doesNotMatch(doc.stdout, /greet\.yml|weekly\.yml|label\.yml/);
  const asked = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(asked.status, 0, asked.stdout);
  assert.match(asked.stdout, /Triage workflow, your choice \(one answer deletes a file\): auto-triage\.yml also triages every new issue, and Winston's would too\. Run init again with one of:\n  --triage replace  \(Recommended\) [^\n]+\n  --triage keep     [^\n]+\n  --triage both     [^\n]+\nUntil you choose, init leaves the triage workflows as they are\./);
  assert.ok(existsSync(ours) && existsSync(theirs), 'nothing is deleted without the choice');
  assert.equal(s.cli(['init', '--mode', 'adopt', '--triage', 'sometimes']).status, 2);

  // replace: Winston's stays, the other goes.
  assert.match(s.cli(['init', '--mode', 'adopt', '--triage', 'replace']).stdout, /Winston will:\n\s+- Make Winston's automatic triage the only one, so each issue is triaged once: delete \.github\/workflows\/auto-triage\.yml/);
  assert.ok(existsSync(theirs), 'a plan changes nothing');
  assert.match(s.cli(['init', '--mode', 'adopt', '--triage', 'replace', '--yes']).stdout, /done\s+Make Winston's automatic triage the only one[^]*Note: These files only start working once they are saved to main on GitHub [^\n]*: \.github\/workflows\/triage-on-new-issue\.yml\. \.github\/workflows\/auto-triage\.yml keeps running on every new issue until its deletion is saved there too\. Next: [^\n]*git -C "\$T\/w" rm -q -- '\.github\/workflows\/auto-triage\.yml'[^\n]*test \$s -eq 0; \}\n/);
  assert.ok(existsSync(ours) && !existsSync(theirs) && existsSync(join(dir, 'greet.yml')));
  assert.doesNotMatch(s.cli(['doctor']).stdout, /triage workflow conflicts/);

  // both: recorded, so it is asked once.
  rival();
  assert.match(s.cli(['init', '--mode', 'adopt', '--triage', 'both', '--yes']).stdout, /done\s+Keep both: record auto-triage\.yml under triage\.alongside/);
  assert.deepEqual(config().triage, { alongside: ['auto-triage.yml'] });
  assert.ok(existsSync(ours) && existsSync(theirs));
  assert.doesNotMatch(s.cli(['doctor']).stdout, /triage workflow conflicts/);

  // keep: the other stays, Winston's goes, and doctor stops asking for it.
  reset();
  assert.match(s.cli(['init', '--mode', 'adopt', '--triage', 'keep', '--yes']).stdout, /done\s+Keep auto-triage\.yml as this project's triage: delete \.github\/workflows\/triage-on-new-issue\.yml, and set triage\.workflow to false/);
  assert.ok(!existsSync(ours) && existsSync(theirs));
  assert.equal(config().triage.workflow, false);
  const kept = s.cli(['doctor']);
  assert.match(kept.stdout, /^off\s+Automatic triage of new issues\s+— off by choice: another workflow triages this project/m);
  assert.doesNotMatch(kept.stdout, /Two workflows triage|Automatic triage (keys|is working)/);
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /(the setup is complete|Winston's part of the setup is done)\. Nothing was changed/);

  // The other one first, Winston's not yet written: it is not written until the owner chooses.
  reset();
  const held = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.match(held.stdout, /Triage workflow, your choice/);
  assert.doesNotMatch(held.stdout, /Turn on automatic triage|claude setup-token/, 'no secrets steps for a workflow that is not being written');
  assert.ok(!existsSync(ours));
  assert.match(s.cli(['doctor']).stdout, /^off\s+Automatic triage of new issues\s+— not added yet: auto-triage\.yml already triages new issues, so Winston asks which to keep$/m);
  assert.match(s.cli(['init', '--mode', 'adopt', '--triage', 'replace', '--yes']).stdout, /done\s+Make Winston's automatic triage the only one, so each issue is triaged once: add \.github\/workflows\/triage-on-new-issue\.yml, and delete/);
  assert.ok(existsSync(ours) && !existsSync(theirs));
});

test('a new issue gets the current phase\'s milestone: doctor reports hidden issues, init sets the phase and installs the workflow', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  existingRepo(s);
  s.git('push', '-q', 'origin', 'main:staging');
  mkdirSync(join(s.repo, '.winston'));
  const configPath = join(s.repo, '.winston/config.json');
  const write = (extra = {}) => writeFileSync(configPath, JSON.stringify({ branches: { integration: 'staging', production: 'main' }, board: { owner: 'acme', number: 1 }, ...extra }));
  const config = () => JSON.parse(readFileSync(configPath, 'utf8'));
  const filtered = (...names) => names.map((name, i) => ({ ...KANBAN[0], id: `VIEW${i}`, name, filter: `milestone:"${name}" is:open` }));
  write();
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: filtered('Pilot') }));
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\nLater\n');
  writeFileSync(join(s.tmp, 'labels'), 'risk: low\nrisk: medium\nrisk: high\nauto-merge\nauto-verify\nhuman-verify\n');
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  writeFileSync(join(s.repo, 'TRIAGE.md'), '# Triage policy\n');
  const dir = join(s.repo, '.github/workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'triage-on-new-issue.yml'), '');
  writeFileSync(join(s.tmp, 'issues-bare'), '7\n13\n');
  const wf = join(dir, 'set-issue-phase.yml');

  const doc = s.cli(['doctor']);
  assert.equal(doc.status, 1);
  assert.match(doc.stdout, /^needs you\s+New issues join the current phase\s+— new issues get no milestone, so the board view for "Pilot" never shows them$/m);
  assert.match(doc.stdout, /^needs you\s+Older issues in the current phase\s+— 2 open issues have no milestone and are hidden from the board view for "Pilot"$/m);
  assert.match(doc.stdout, /\d\. New issues join the current phase\n   Why: The board shows only the current phase[^\n]+\n   Fix:\n     Type \/winston:init in this Claude Code chat\. [^\n]*It will: Put every new issue in the current phase, "Pilot"/);

  const plan = s.cli(['init', '--mode', 'adopt']);
  assert.match(plan.stdout, /- Put every new issue in the current phase, "Pilot", so it shows on the board: set "phase" in \.winston\/config\.json, and add \.github\/workflows\/set-issue-phase\.yml\. To move to the next phase later, change that one "phase" line/);
  assert.match(plan.stdout, /- Put the 2 open issues that have no milestone \(#7, #13\) in "Pilot", so the board shows them; an issue that already has a milestone is not touched/);
  assert.ok(!existsSync(wf) && config().phase === undefined, 'a plan changes nothing');
  assert.doesNotMatch(s.calls(), /issue edit/);

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.equal(config().phase, 'Pilot');
  assert.match(made.stdout, /Note: These files only start working once they are saved to main on GitHub [^\n]*: \.winston\/config\.json, \.github\/workflows\/set-issue-phase\.yml\. Next: /);
  assert.match(plan.stdout, /Note: These files [^\n]*set-issue-phase\.yml/);
  assert.deepEqual(config().board, { owner: 'acme', number: 1 }, 'the rest of the config is as it was');
  assert.equal(readFileSync(wf, 'utf8'), readFileSync(join(ROOT, 'templates/set-issue-phase.yml'), 'utf8'));
  assertNoTimer(readFileSync(wf, 'utf8'), 'the installed phase workflow');
  assert.match(s.calls(), /issue edit 7 --milestone Pilot\n[^]*issue edit 13 --milestone Pilot\n/);
  const after = s.cli(['doctor']);
  assert.match(after.stdout, /^done\s+New issues join the current phase\s+— new issues get the milestone "Pilot" once set-issue-phase\.yml and the settings are saved to the default branch on GitHub$/m);
  s.git('add', '.winston', '.github');
  s.git('commit', '-q', '-m', 'setup');
  assert.match(s.cli(['doctor']).stdout, /^done\s+New issues join the current phase\s+— new issues get the milestone "Pilot"$/m);
  assert.doesNotMatch(after.stdout, /Older issues in the current phase|Two workflows triage/, 'nothing reported when none is hidden; the phase workflow is not a second triage');
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /(the setup is complete|Winston's part of the setup is done)\. Nothing was changed/);

  // The phase is one line: a milestone that is not open is the owner's to correct.
  write({ phase: 'Gone' });
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+New issues join the current phase\s+— phase is "Gone", which is not an open milestone$/m);
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /By hand \(each line says what to do next\):\n\s+- New issues join the current phase: set "phase" in \.winston\/config\.json to the current milestone \(open: Pilot, Later\), or to false/);

  // Views filtered to several milestones: Winston picks the one GitHub lists first (the
  // nearest due date) and says so in the plan, rather than asking.
  write();
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: filtered('Later', 'Pilot') }));
  const several = s.cli(['init', '--mode', 'adopt']);
  assert.match(several.stdout, /- Put every new issue in the current phase, "Pilot", so it shows on the board \(the board shows several phases: Later, Pilot; Winston picked the one due soonest, and you can change it later in \.winston\/config\.json\)/);
  assert.doesNotMatch(several.stdout, /<one of/);
  write({ phase: 'Later' });
  assert.match(s.cli(['doctor']).stdout, /^done\s+New issues join the current phase\s+— new issues get the milestone "Later" once /m);

  // A view that filters nothing, excludes a milestone, or names a closed one hides no
  // issue a phase could show: nothing is proposed, and no issue is touched.
  write();
  rmSync(wf);
  writeFileSync(join(s.tmp, 'issues-bare'), '7\n');
  rmSync(join(s.tmp, 'gh-calls'));
  for (const filter of [undefined, '-milestone:"Pilot"', 'milestone:"Closed one"', 'no:milestone']) {
    writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: [{ ...KANBAN[0], filter }] }));
    assert.doesNotMatch(s.cli(['doctor']).stdout, /New issues join the current phase|Older issues in the current phase/, String(filter));
    assert.doesNotMatch(s.cli(['init', '--mode', 'adopt', '--yes']).stdout, /Put every new issue|Put the \d+ open/, String(filter));
  }
  assert.doesNotMatch(s.calls(), /issue edit/);
  assert.ok(!existsSync(wf) && config().phase === undefined);
  // A phase with no open milestone behind it is never called done.
  writeFileSync(join(s.tmp, 'milestones'), '');
  write({ phase: 'Phase 9' });
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+New issues join the current phase\s+— phase is "Phase 9", which is not an open milestone$/m);
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\nLater\n');
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: filtered('Pilot', 'Later') }));
  write({ phase: 'Later' });

  // Issues that cannot be listed are unknown, never clean; phase: false goes without.
  writeFileSync(join(s.tmp, 'issues-denied'), '');
  assert.match(s.cli(['doctor']).stdout, /^could not check\s+Older issues in the current phase\s+— GitHub would not list this repository's issues for this account; check you are signed in to the right one \(in the Terminal app: gh auth status\)$/m);
  write({ phase: false });
  assert.doesNotMatch(s.cli(['doctor']).stdout, /New issues join the current phase|Older issues in the current phase/);
});

test('with no board view yet, the phase is the milestone init is about to filter the new view to', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  existingRepo(s);
  s.git('push', '-q', 'origin', 'main:staging');
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ branches: { integration: 'staging', production: 'main' }, board: { owner: 'acme', number: 1 } }));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE }));
  writeFileSync(join(s.tmp, 'issues-bare'), '4\n');
  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.match(made.stdout, /done\s+Add a board view that shows the work in columns, for the current phase/);
  assert.match(made.stdout, /done\s+Put every new issue in the current phase, "Phase 1\.0"/);
  assert.match(made.stdout, /done\s+Put the 1 open issue that has no milestone \(#4\) in "Phase 1\.0", so the board shows it/);
  assert.equal(JSON.parse(readFileSync(join(s.repo, '.winston/config.json'), 'utf8')).phase, 'Phase 1.0');
  assert.match(s.calls(), /issue edit 4 --milestone Phase 1\.0\n/);
});

test('the phase workflow runs on a new issue and on a manual dispatch, never on a timer, needs no secret, and never changes a set milestone', () => {
  const text = readFileSync(join(ROOT, 'templates/set-issue-phase.yml'), 'utf8');
  assert.equal(firesOnNewIssue(text), true);
  assertNoTimer(text, 'templates/set-issue-phase.yml');
  assert.match(text, /if \[ -n "\$ISSUE" \]; then\n\s+numbers=\$ISSUE\n\s+else\n\s+numbers=\$\(gh issue list/, 'a dispatch with no issue still sweeps the open issues with no milestone');
  assert.match(text, /permissions:\n\s+contents: read\n\s+issues: write\n/);
  assert.doesNotMatch(text, /secrets\./);
  assert.match(text, /if \[ -z "\$has" \]; then\n\s+gh issue edit "\$n" --milestone "\$phase"/);
  assert.doesNotMatch(text.slice(text.indexOf('run: |')), /\$\{\{/, 'nothing is interpolated into the script');
});

test('init --mode adopt asks which board when several are linked, and refuses a repo with no origin', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  const none = s.cli(['init', '--mode', 'adopt']);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /adopt is for a project that already has saved history and is on GitHub.*For a new project, type \/winston:init in this Claude Code chat: it picks the right setup/);

  existingRepo(s);
  writeFileSync(join(s.tmp, 'linked.json'), linkedJson([['acme', 3, 'Roadmap'], ['acme', 4, 'Bugs']]));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  const asked = s.cli(['init', '--mode', 'adopt']);
  assert.match(asked.stdout, /Recommended: --board acme\/3\s+Roadmap\s+\(GitHub lists it first\)\n\s+--board acme\/4\s+Bugs\n\s+--board new/);
  assert.match(asked.stdout, /To plan with the recommended board, in this Claude Code chat, type: !winston init --mode adopt --board acme\/3$/m);
  assert.equal(s.cli(['init', '--mode', 'adopt', '--yes']).status, 2);
  assert.ok(!existsSync(join(s.repo, '.winston')));
  // A board named like the repository is the recommended one.
  writeFileSync(join(s.tmp, 'linked.json'), linkedJson([['acme', 3, 'Roadmap'], ['acme', 4, 'Thing']]));
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /Recommended: --board acme\/4\s+Thing\s+\(its name matches this project\)\n\s+--board acme\/3\s+Roadmap/);
  assert.match(s.cli(['init', '--mode', 'adopt', '--board', 'acme/4']).stdout, /uses board #4 \(acme\)/);
  rmSync(join(s.tmp, 'board.json'));
  const gone = s.cli(['init', '--mode', 'adopt', '--board', 'acme/99', '--yes']);
  assert.equal(gone.status, 1, 'a board this account cannot read is refused before anything is written');
  assert.match(gone.stderr, /--board acme\/99: this GitHub account cannot open that board\. Check the owner and number/);
  assert.ok(!existsSync(join(s.repo, '.winston')));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  assert.match(s.cli(['init', '--mode', 'adopt', '--board', 'new']).stdout, /Make a private board, "thing", where your work is tracked[^\n]*\(a GitHub Project under acme\)/);
});

test('init --mode join reports access as the joiner\'s, repo gaps as the owner\'s, and writes only the user layer', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  const bare = s.cli(['init', '--mode', 'join']);
  assert.equal(bare.status, 1, 'no config: not a Winston repo');
  assert.match(bare.stdout, /^Winston isn't set up in this copy of the project yet\.\nIf a teammate set it up, get their settings: [^\n]*git pull[^\n]*\nIf no one has set it up, run \/winston:init and Winston will set it up for you\.\n$/);
  existingRepo(s);
  mkdirSync(join(s.repo, '.winston'));
  const repoConfig = JSON.stringify({ owner: 'Dana', branches: { integration: 'staging', production: 'main' }, board: { owner: 'acme', number: 1 }, phase: false });
  writeFileSync(join(s.repo, '.winston/config.json'), repoConfig);

  const plan = s.cli(['init', '--mode', 'join']);
  assert.match(plan.stdout, /Its setup is Dana's: nothing in the project or on GitHub is changed/);
  assert.match(plan.stdout, /Yours to fix:\n\s+- Board access: access to a board is given separately from access to the repo: ask Dana to add your GitHub account at https:\/\/github\.com\/users\/acme\/projects\/1\/settings\/access/);
  assert.match(plan.stdout, /They are Dana's to close, not yours: send them this list, and they can run \/winston:init to fix it:[^]*- Work branch on GitHub[^]*- Triage labels/);
  assert.match(plan.stdout, /would:\n\s+- set launcher\.repo[^]*To go ahead, in this Claude Code chat, type: !winston init --mode join --yes/);
  assert.ok(!existsSync(join(s.home, 'config.json')));

  const applied = s.cli(['init', '--mode', 'join', '--yes']);
  assert.equal(applied.status, 1, 'the board is still out of reach');
  assert.equal(JSON.parse(readFileSync(join(s.home, 'config.json'), 'utf8')).launcher.repo, s.repo);
  assert.equal(readFileSync(join(s.repo, '.winston/config.json'), 'utf8'), repoConfig);
  assert.ok(!existsSync(join(s.repo, '.github')) && !existsSync(join(s.tmp, 'labels')), 'no repo files, no labels');
  assert.doesNotMatch(s.calls(), /label create|project create|updateProjectV2|createProjectV2/);
  assert.deepEqual(originHeads(s), ['main']);

  // With access and a complete repo, join is ready and leaves an existing launcher alone.
  writeFileSync(join(s.home, 'config.json'), JSON.stringify({ launcher: { repo: '~/elsewhere' } }));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\n');
  writeFileSync(join(s.tmp, 'labels'), 'risk: low\nrisk: medium\nrisk: high\nauto-merge\nauto-verify\nhuman-verify\n');
  mkdirSync(join(s.repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(s.repo, '.github/workflows/triage-on-new-issue.yml'), '');
  writeFileSync(join(s.repo, 'TRIAGE.md'), '# Triage policy\n');
  s.git('push', '-q', 'origin', 'main:staging');
  const ready = s.cli(['init', '--mode', 'join', '--yes']);
  assert.equal(ready.status, 0, ready.stdout);
  assert.match(ready.stdout, /Ready: everything Winston needs is in place/);
  assert.equal(JSON.parse(readFileSync(join(s.home, 'config.json'), 'utf8')).launcher.repo, '~/elsewhere');
});

test('doctor checks the board\'s two intake workflows and the triage workflow\'s secrets', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ board: { owner: 'acme', number: 1, statuses: ['Inbox', 'Ready', 'Verify', 'Verified'] } }));
  mkdirSync(join(s.repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(s.repo, '.github/workflows/triage-on-new-issue.yml'), '');
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ options: ['Inbox', 'Ready', 'Verify', 'Verified'], workflows: ['Item added to project'], views: KANBAN }));
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\n');
  // An issue exists, but the projects automation never touched it: both sources agree it is off.
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([[9, []]]));
  const off = s.cli(['doctor']);
  assert.equal(off.status, 1);
  assert.match(off.stdout, /^needs you\s+Board adds new issues\s+— not on yet: the board's "Auto-add to project" workflow is off/m);
  assert.match(off.stdout, /^done\s+Board puts new issues in Inbox$/m);
  assert.match(off.stdout, /^needs you\s+Automatic triage keys\s+— GH_PAT set, CLAUDE_CODE_OAUTH_TOKEN missing/m);
  assert.match(off.stdout, /\d\. Automatic triage keys\n   Why: [^\n]+\n   Fix:\n     Recommended: do this now \(about 5 minutes\)\. Without these two keys, Winston won't triage new issues on acme\/thing until you ask it to\.[^\n]*Missing: CLAUDE_CODE_OAUTH_TOKEN\.[^]*\n       1\. In the Terminal app, run: claude setup-token/);
  assert.match(off.stdout, /\d\. Board adds new issues\n   Why: Without this a new issue never shows up on the board\.\n   Fix:\n     Next: type \/winston:init in this Claude Code chat and it does this for you in the browser\. To do it yourself: open https:\/\/github\.com\/users\/acme\/projects\/1\/workflows/);
  assert.equal(off.stdout.match(/Board adds new issues/g).length, 2, 'once in the checklist, once under Needs you');

  writeFileSync(join(s.tmp, 'board.json'), boardJson({ options: ['Inbox', 'Ready', 'Verify', 'Verified'], workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  const on = s.cli(['doctor']);
  assert.match(on.stdout, /^done\s+Board adds new issues$/m);
  assert.match(on.stdout, /^done\s+Automatic triage keys\s+— GH_PAT set, CLAUDE_CODE_OAUTH_TOKEN set \(doctor sees names only: if a run fails with "cannot read the board", make GH_PAT again with the project box ticked\)$/m);
  assert.doesNotMatch(on.stdout, /\d\. (Board adds|Board puts|triage workflow)/);
});

test('doctor takes the projects automation\'s events on this board as proof its intake runs, never another board\'s or a person\'s (#45)', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ board: { owner: 'acme', number: 6 } }));
  // The API's workflows listing omits "Auto-add to project" entirely (not merely disabled),
  // the exact shape #45 reports, yet the bot's own timeline on a recent issue shows it ran.
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: ['Item added to project'], views: KANBAN }));
  // Another project auto-adds the repo's issues, and someone added them to this board by
  // hand: the shape #45 found. Neither says this board's workflows are on.
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([
    [43, [['add', BOT, 'acme', 1], ['status', BOT, 'acme', 1]]],
    [44, [['add', BOT, 'acme', 1], ['status', BOT, 'acme', 1], ['add', 'pat', 'acme', 6], ['status', 'pat', 'acme', 6], ['add', BOT, 'other', 6]]],
  ]));
  const elsewhere = s.cli(['doctor']);
  assert.match(elsewhere.stdout, /^needs you\s+Board adds new issues\s+— not on yet: the board's "Auto-add to project" workflow is off$/m);
  assert.match(elsewhere.stdout, /\d\. Board adds new issues\n/);
  // The automation's own event on this board is.
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([[43, [['add', BOT, 'acme', 6]]], [44, [['add', BOT, 'acme', 6], ['status', BOT, 'acme', 6]]]]));
  const confirmed = s.cli(['doctor']);
  assert.match(confirmed.stdout, /^done\s+Board adds new issues\s+— on \(confirmed by issue #44's timeline\)$/m);
  assert.match(confirmed.stdout, /^done\s+Board puts new issues in New$/m);
  assert.doesNotMatch(confirmed.stdout, /In the browser|\d\. Board (adds|puts)/, 'confirmed by the bot: no browser step, required or optional');

  // Control: a board whose API already says both are on (project 2 in #45) is unaffected,
  // and never asks the issue timeline at all.
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  rmSync(join(s.tmp, 'gh-calls'));
  const already = s.cli(['doctor']);
  assert.match(already.stdout, /^done\s+Board adds new issues$/m);
  assert.match(s.calls(), /timelineItems/, 'the timeline is read even when both workflows are on, to look for another capturing project');

  // No issues at all yet: neither source can be trusted over the other, so doctor says so
  // rather than sending the owner to redo a step that may already be on.
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: ['Item added to project'], views: KANBAN }));
  rmSync(join(s.tmp, 'timeline.json'));
  const blind = s.cli(['doctor']);
  assert.match(blind.stdout, /^could not check {2}Board adds new issues\s+— could not check yet: there are no issues to look at\. File one test issue, then run \/winston:doctor again$/m);
  assert.doesNotMatch(blind.stdout, /\d\. Board adds new issues/, 'not a required step: never counted as missing');
});

test('doctor counts the automation\'s events only when newer than the workflow\'s last change (#68)', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ board: { owner: 'acme', number: 6 } }));
  // Both intake workflows are listed as off, last changed on 1 October.
  const OFF_AT = '2026-10-01T00:00:00Z';
  const offBoard = (updatedAt = OFF_AT) => boardJson({ workflows: INTAKE.map((name) => ({ name, enabled: false, ...(updatedAt ? { updatedAt } : {}) })), views: KANBAN });
  writeFileSync(join(s.tmp, 'board.json'), offBoard());
  const BEFORE = '2026-09-15T12:00:00Z';
  const AFTER = '2026-10-05T12:00:00Z';
  const doctor = (issues) => { writeFileSync(join(s.tmp, 'timeline.json'), timelineJson(issues)); return s.cli(['doctor']).stdout; };
  const staleRow = (row, wf, n) => new RegExp(`^needs you\\s+${row}\\s+— not on yet: the board's "${wf}" workflow is off \\(issue #${n}'s timeline shows it ran, but before the workflow was last changed\\)$`, 'm');

  // False green: the bot ran, then the workflows were switched off. Not "on".
  const off = doctor([[44, [['add', BOT, 'acme', 6, BEFORE], ['status', BOT, 'acme', 6, BEFORE]]]]);
  assert.match(off, staleRow('Board adds new issues', 'Auto-add to project', 44));
  assert.match(off, staleRow('Board puts new issues in New', 'Item added to project', 44));
  assert.doesNotMatch(off, /confirmed by issue/);

  // False red (#45): the API says off, but the bot ran after the last change. "On".
  const running = doctor([[44, [['add', BOT, 'acme', 6, AFTER], ['status', BOT, 'acme', 6, AFTER]]]]);
  assert.match(running, /^done\s+Board adds new issues\s+— on \(confirmed by issue #44's timeline\)$/m);
  assert.match(running, /^done\s+Board puts new issues in New\s+— on \(confirmed by issue #44's timeline\)$/m);

  // A transferred issue carries its old board events: the newest-numbered issue's event is
  // old, so it proves nothing, and with nothing newer the row stays off.
  const moved = doctor([[49, []], [50, [['add', BOT, 'acme', 6, '2026-08-01T00:00:00Z']]]]);
  assert.match(moved, staleRow('Board adds new issues', 'Auto-add to project', 50));
  // An older issue's fresh event still proves it: the event's time counts, not the issue number.
  const movedFresh = doctor([[40, [['add', BOT, 'acme', 6, AFTER]]], [50, [['add', BOT, 'acme', 6, '2026-08-01T00:00:00Z']]]]);
  assert.match(movedFresh, /^done\s+Board adds new issues\s+— on \(confirmed by issue #40's timeline\)$/m);

  // An issue filed before the board existed, and one closed at once, carry no events of
  // this board; neither hides a fresh run on another issue.
  const quiet = doctor([[30, []], [45, [['add', BOT, 'acme', 6, AFTER], ['status', BOT, 'acme', 6, AFTER]]], [51, []]]);
  assert.match(quiet, /^done\s+Board adds new issues\s+— on \(confirmed by issue #45's timeline\)$/m);
  assert.match(quiet, /^done\s+Board puts new issues in New\s+— on \(confirmed by issue #45's timeline\)$/m);

  // Ambiguous: an event without a time can't be placed against the switch-off. Uncertain,
  // never a confident "on", and not counted as a required step either.
  const unsureRow = (row, wf, n) => new RegExp(`^could not check\\s+${row}\\s+— may be on: issue #${n}'s timeline shows the board's automation ran, but GitHub gave no time to compare it against, so doctor cannot tell whether the "${wf}" workflow was switched off since; check https://github\\.com/users/acme/projects/6/workflows$`, 'm');
  const untimed = doctor([[44, [['add', BOT, 'acme', 6], ['status', BOT, 'acme', 6]]]]);
  assert.match(untimed, unsureRow('Board adds new issues', 'Auto-add to project', 44));
  assert.match(untimed, unsureRow('Board puts new issues in New', 'Item added to project', 44));
  assert.doesNotMatch(untimed, /\d\. Board (adds|puts)/);
  // A workflow listed as off with no time of its last change: likewise uncertain.
  writeFileSync(join(s.tmp, 'board.json'), offBoard(null));
  const unbounded = doctor([[44, [['add', BOT, 'acme', 6, AFTER]]]]);
  assert.match(unbounded, unsureRow('Board adds new issues', 'Auto-add to project', 44));
  assert.match(unbounded, /^needs you\s+Board puts new issues in New\s+— not on yet: the board's "Item added to project" workflow is off$/m);
  // A dated proof outranks an undated one: with a bound, a fresh event still reads "on".
  writeFileSync(join(s.tmp, 'board.json'), offBoard());
  const mixed = doctor([[43, [['add', BOT, 'acme', 6, AFTER]]], [44, [['add', BOT, 'acme', 6]]]]);
  assert.match(mixed, /^done\s+Board adds new issues\s+— on \(confirmed by issue #43's timeline\)$/m);

  // Several Auto-add workflows, all off: the latest change bounds them all.
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: [
    { name: 'Auto-add to project', enabled: false, updatedAt: '2026-09-01T00:00:00Z' },
    { name: 'Auto-add to project (2)', enabled: false, updatedAt: OFF_AT },
    { name: 'Item added to project', enabled: true },
  ], views: KANBAN }));
  assert.match(doctor([[44, [['add', BOT, 'acme', 6, BEFORE]]]]), staleRow('Board adds new issues', 'Auto-add to project', 44), 'after the older workflow changed but before the newer one: not proof');
  assert.match(doctor([[44, [['add', BOT, 'acme', 6, AFTER]]]]), /^done\s+Board adds new issues\s+— on \(confirmed by issue #44's timeline\)$/m);

  // A workflow missing from the listing (#45's shape, or deleted) has no switch to bound
  // by: a newer open issue the automation did not take means intake stopped.
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: ['Item added to project'], views: KANBAN }));
  const ran = ['add', BOT, 'acme', 6, BEFORE];
  const stopped = doctor([[44, [ran], { createdAt: '2026-09-15T11:00:00Z' }], [45, [], { createdAt: OFF_AT }]]);
  assert.match(stopped, /^needs you\s+Board adds new issues\s+— not on yet: the board's "Auto-add to project" workflow is off \(issue #44's timeline shows it ran, but newer issue #45 was not taken\)$/m);
  assert.doesNotMatch(stopped, /confirmed by issue/);
  // The untaken issue was closed at once, or is older than the run (filed before the board
  // existed, or transferred in): neither says intake stopped.
  assert.match(doctor([[44, [ran]], [45, [], { createdAt: OFF_AT, closed: true }]]), /^done\s+Board adds new issues\s+— on \(confirmed by issue #44's timeline\)$/m);
  assert.match(doctor([[44, [ran]], [45, [], { createdAt: '2026-08-01T00:00:00Z' }]]), /^done\s+Board adds new issues\s+— on \(confirmed by issue #44's timeline\)$/m);
  // The untaken issue has no time: uncertain, not "on".
  assert.match(doctor([[44, [ran]], [45, []]]), unsureRow('Board adds new issues', 'Auto-add to project', 44));
});

test('doctor names another project that auto-adds the repo\'s issues, ahead of the board\'s own workflows (#45)', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ board: { owner: 'acme', number: 6 } }));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: [], views: KANBAN }));
  // Other project present: project 1 took the newest issues, board 6 took none.
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([[47, [['add', BOT, 'acme', 1], ['status', BOT, 'acme', 1]]], [48, [['add', BOT, 'acme', 1]]]]));
  const other = s.cli(['doctor']);
  assert.equal(other.status, 1);
  assert.match(other.stdout, /^needs you\s+Another board also takes new issues \(project 1\)\s+— new issues \(#48, #47\) also went to project 1 "Project 1" through its Auto-add workflow, not only to board 6$/m);
  assert.ok(other.stdout.indexOf('Another board also takes new issues (project 1)\n   Why') > 0 && other.stdout.indexOf('Another board also takes new issues (project 1)\n   Why') < other.stdout.indexOf('Board adds new issues\n   Why'), 'listed before the board\'s own workflows');
  assert.match(other.stdout, /Fix:\n     Next: type \/winston:init in this Claude Code chat and it does this for you in the browser\. To do it yourself: before turning on board 6's workflows, open https:\/\/github\.com\/users\/acme\/projects\/1\/workflows/);
  const plan = s.cli(['init', '--mode', 'adopt']);
  assert.match(plan.stdout, /In the browser[^\n]*\n  - Another board also takes new issues \(project 1\): before turning on board 6's workflows, open https:\/\/github\.com\/users\/acme\/projects\/1\/workflows, choose "Auto-add to project", click Edit, remove this repository \(or turn the workflow off if this repository is its only one\), then Save\n  - Board adds new issues/);

  // A project of another owner is named with its owner: numbers are owner-scoped.
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([[48, [['add', BOT, 'other-org', 6]]]]));
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+Another board also takes new issues \(other-org project 6\)\s+— new issues \(#48\) also went to other-org project 6 "Project 6"/m);

  // None: only this board's own events, or none at all.
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([[47, [['add', BOT, 'acme', 6]]], [48, []]]));
  assert.doesNotMatch(s.cli(['doctor']).stdout, /Another board also takes/);
  // History that predates a fix is not flagged: board 6 has taken #50 since project 1 took #47.
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([[47, [['add', BOT, 'acme', 1]]], [50, [['add', BOT, 'acme', 6]]]]));
  assert.doesNotMatch(s.cli(['doctor']).stdout, /Another board also takes/);
  // A person adding to another project by hand is not an intake workflow.
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([[47, [['add', 'pat', 'acme', 1]]]]));
  assert.doesNotMatch(s.cli(['doctor']).stdout, /Another board also takes/);

  // The configured board already on: another project taking the newest issue too is still named.
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([[50, [['add', BOT, 'acme', 6]]], [51, [['add', BOT, 'acme', 6], ['add', BOT, 'acme', 1]]], [52, [['add', BOT, 'acme', 1], ['add', BOT, 'acme', 6]]]]));
  const both = s.cli(['doctor']);
  assert.match(both.stdout, /^done\s+Board adds new issues$/m);
  assert.match(both.stdout, /^needs you\s+Another board also takes new issues \(project 1\)/m);
  // ...and once the configured board has taken the newest issue alone, it is not.
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([[51, [['add', BOT, 'acme', 1], ['add', BOT, 'acme', 6]]], [52, [['add', BOT, 'acme', 6]]]]));
  assert.doesNotMatch(s.cli(['doctor']).stdout, /Another board also takes/);
});

test('doctor says unknown, not missing, when it cannot list secrets, and flags a run of failed triage runs', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ board: { owner: 'acme', number: 1 } }));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  // No workflow in the repo: nothing about its secrets or runs.
  assert.doesNotMatch(s.cli(['doctor']).stdout, /Automatic triage (keys|is working)/);

  mkdirSync(join(s.repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(s.repo, '.github/workflows/triage-on-new-issue.yml'), '');
  // Newest first: one still running, three failures, then a success.
  writeFileSync(join(s.tmp, 'runs'), '\nfailure\nstartup_failure\nfailure\nsuccess\n');
  const failing = s.cli(['doctor']);
  assert.match(failing.stdout, /^needs you\s+Automatic triage is working\s+— its last 3 runs failed$/m);
  assert.match(failing.stdout, /\d\. Automatic triage is working\n   Why: Failed runs mean new issues are not being triaged, and nothing else reports it\.\n   Fix:\n     its last 3 runs failed\. A key that was mistyped, has expired or lacks access is the usual cause\. Ask Claude to look: it reads the failed run's log \(gh run list --workflow triage-on-new-issue\.yml --limit 1/);
  assert.match(s.calls(), /^run list --workflow triage-on-new-issue\.yml --limit 5 --json conclusion/m);

  writeFileSync(join(s.tmp, 'runs'), 'success\nfailure\nfailure\n');
  const fine = s.cli(['doctor']);
  assert.match(fine.stdout, /^done\s+Automatic triage is working\s+— last run: success$/m);
  writeFileSync(join(s.tmp, 'runs'), 'cancelled\nsuccess\n');
  assert.match(s.cli(['doctor']).stdout, /^off\s+Automatic triage is working\s+— last run: cancelled$/m);
  assert.doesNotMatch(fine.stdout, /\d\. Automatic triage is working/);
  writeFileSync(join(s.tmp, 'runs'), '');
  assert.match(s.cli(['doctor']).stdout, /^off\s+Automatic triage is working\s+— no finished runs yet: it runs when the next issue is opened$/m);

  // gh cannot list secrets (403) or runs: unknown, and not called a problem.
  writeFileSync(join(s.tmp, 'secrets-denied'), '');
  rmSync(join(s.tmp, 'runs'));
  const blind = s.cli(['doctor']);
  assert.match(blind.stdout, /^could not check\s+Automatic triage keys\s+— this GitHub account cannot see the repository's secrets \(only its admins can\); the steps below say how to check$/m);
  assert.match(blind.stdout, /^could not check\s+Automatic triage is working/m);
  assert.doesNotMatch(blind.stdout, /\d\. Automatic triage (keys|is working)|needs you\s+Automatic triage (keys|is working)|403/);
});

test('init walks the owner through the triage workflow\'s missing secrets, by who owns the board', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  existingRepo(s);
  writeFileSync(join(s.tmp, 'linked.json'), linkedJson([['acme', 3, 'Roadmap']]));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\n');
  writeFileSync(join(s.tmp, 'secrets'), 'CLAUDE_CODE_OAUTH_TOKEN\n');

  // The plan writes the workflow, so it carries the step; a user's board needs a classic token.
  const plan = s.cli(['init', '--mode', 'adopt']);
  assert.match(plan.stdout, /Turn on automatic triage \(yours to do: you type the keys yourself, in the Terminal app, never into a chat\):\n  Recommended: do this now[^]*Missing: GH_PAT\./);
  // The prefilled link first, then every field by name for when the link fills nothing in.
  assert.match(plan.stdout, /1\. Open this link while signed in to GitHub; it opens the form, and should tick the two boxes you need: https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo,project\n/);
  assert.match(plan.stdout, /2\. Check the form: type a name in Note[^\n]*Choose 90 days for Expiration: when it runs out, \/winston:doctor tells you[^\n]*"repo" and "project" must be ticked: tick them if the link did not[^\n]*\n\s+3\. If the form came up empty: [^\n]*Tokens \(classic\), "Generate new token \(classic\)"[^\n]*\n\s+4\. Click "Generate token" yourself and copy the token[^\n]*\n\s+5\. In the Terminal app, run: gh secret set GH_PAT --repo acme\/thing /);
  // Claude runs the proof itself: no placeholder issue number for the owner to work out.
  assert.match(plan.stdout, /Then tell Claude both are set\. Once triage-on-new-issue\.yml is on the default branch, Claude files a test issue if there is none, runs the workflow on it/);
  assert.doesNotMatch(plan.stdout, /-f issue=</);
  // The reason for the token type comes after the steps.
  assert.match(plan.stdout, /Why this kind of token: acme is a personal account, and GitHub's fine-grained tokens cannot reach a personal account's boards, so this is a classic token\./);
  assert.doesNotMatch(plan.stdout, /claude setup-token/, 'a secret that exists is not walked through');
  assert.match(s.calls(), /^secret list --repo acme\/thing --json name/m);

  // After applying, the same step; an organization's board takes a fine-grained token.
  writeFileSync(join(s.tmp, 'owner-type'), 'Organization\n');
  writeFileSync(join(s.tmp, 'secrets'), '');
  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.match(made.stdout, /Missing: GH_PAT, CLAUDE_CODE_OAUTH_TOKEN\./);
  assert.match(made.stdout, /Why this kind of token: acme is an organization, so this is a fine-grained token\./);
  assert.match(made.stdout, /1\. Open this link while signed in to GitHub; it fills in the form: https:\/\/github\.com\/settings\/personal-access-tokens\/new\?name=winston\+triage\+thing&description=[^ &]+&target_name=acme&expires_in=90&issues=write&organization_projects=write\n/);
  assert.match(made.stdout, /2\. Check the form: Token name \(filled in\), Resource owner acme, Expiration 90 days[^\n]*"Only select repositories" and pick acme\/thing; the link cannot fill that in[^\n]*"Issues: Read and write"[^\n]*"Projects: Read and write"\n\s+3\. If the form came up empty: [^\n]*Fine-grained tokens[^\n]*\n\s+4\. Click "Generate token" yourself/);
  assert.match(made.stdout, /6\. In the Terminal app, run: claude setup-token[^\n]*\n\s+7\. In the Terminal app, run: gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo acme\/thing /);

  // Set up already, secrets still missing: init says so rather than "Nothing to do".
  const again = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.match(again.stdout, /^Winston's part of the setup is done\. Nothing was changed\. Safe to run again\.\n\nTurn on automatic triage[^]*\n\nFewer permission prompts \(yours to do, in one step\):\n  Let Winston run everyday git and GitHub commands without asking you each time[^]*Claude is not allowed to grant itself permissions, so this one is yours to run: in this Claude Code chat, type: !winston permissions --apply/);
  // A board under another owner than the repo, or an owner gh cannot look up: classic.
  const config = JSON.parse(readFileSync(join(s.repo, '.winston/config.json'), 'utf8'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ ...config, board: { ...config.board, owner: 'other-org' } }));
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /1\. Open this link[^\n]*: https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo,project\n[^]*Why this kind of token: the board belongs to other-org and the repository does not, and a fine-grained token covers one owner, so this is a classic token\./);
  writeFileSync(join(s.tmp, 'owner-type'), '');
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /1\. Open this link[^\n]*: https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo,project\n[^]*Why this kind of token: GitHub did not say whether other-org is a person or an organization, so this is a classic token, which works for either\./);

  // Secrets this account cannot list: check first, then both, never "missing".
  writeFileSync(join(s.tmp, 'secrets-denied'), '');
  const blind = s.cli(['init', '--mode', 'adopt']);
  assert.match(blind.stdout, /This account cannot see which secrets acme\/thing has, so check first\. In the Terminal app, run: gh secret list --repo acme\/thing\./);
  assert.doesNotMatch(blind.stdout, /Missing:/);
  rmSync(join(s.tmp, 'secrets-denied'));
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  assert.doesNotMatch(s.cli(['init', '--mode', 'adopt']).stdout, /Turn on automatic triage|Nothing to do/);
  assert.equal(s.cli(['permissions', '--apply']).status, 0);
  const done = s.cli(['init', '--mode', 'adopt']);
  assert.match(done.stdout, /^Nothing to do: the setup is complete\. Nothing was changed\. Safe to run again\.\n$/);
  assert.doesNotMatch(s.calls(), /^(secret set|workflow run|secret list(?!.*--json name))/m, 'winston lists secret names and nothing else');
});

test('the triage workflow template skips, rather than fails, without its secrets', () => {
  const yml = readFileSync(join(ROOT, 'templates/triage-on-new-issue.yml'), 'utf8');
  const steps = yml.slice(yml.indexOf('    steps:'));
  assert.match(steps, /id: secrets/);
  // Every step after the secrets check: the two checkouts, Node, the CLI install and the triage run.
  const all = steps.split(/\n      - /).slice(1);
  const gated = all.slice(all.findIndex((step) => /id: secrets/.test(step)) + 1);
  assert.equal(gated.length, 5);
  // The install runs package scripts, so it holds no secret.
  assert.doesNotMatch(gated.find((step) => /npm install/.test(step)), /\$\{\{\s*secrets\./);
  assert.doesNotMatch(yml.slice(0, yml.indexOf('    steps:')), /\$\{\{\s*secrets\./, 'no secret at job level');
  for (const step of gated) assert.match(step, /if: steps\.secrets\.outputs\.ready == 'true'/);
});

test('doctor reports the triage mechanism; init offers to replace an agent workflow and rewrites only a stale pin', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ owner: 'Dana', branches: { integration: 'staging', production: 'main' }, board: { owner: 'acme', number: 1 }, phase: false }));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  mkdirSync(join(s.repo, '.github/workflows'), { recursive: true });
  const wf = join(s.repo, '.github/workflows/triage-on-new-issue.yml');
  const template = readFileSync(join(ROOT, 'templates/triage-on-new-issue.yml'), 'utf8');
  const pin = triageMechanism(template).pin;
  assert.match(pin, /^[0-9a-f]{40}$/);
  const short = pin.slice(0, 7);

  // The older template: an agent with a tool list.
  writeFileSync(wf, 'name: Triage a new issue\non:\n  issues:\n    types: [opened]\njobs:\n  t:\n    steps:\n      - uses: anthropics/claude-code-action@abc # v1\n');
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+Automatic triage is up to date\s+— an older version \(an agent with a tool list/m);
  const offer = s.cli(['init', '--mode', 'adopt']);
  assert.match(offer.stdout, /Winston will:\n(  - [^\n]+\n)*  - Replace \.github\/workflows\/triage-on-new-issue\.yml with Winston's newer automatic triage/);
  assert.match(readFileSync(wf, 'utf8'), /claude-code-action/, 'nothing changes without --yes');
  const applied = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.match(applied.stdout, /^done\s+Replace .*with Winston's newer automatic triage/m);
  assert.equal(readFileSync(wf, 'utf8'), template);
  assert.ok(s.cli(['doctor']).stdout.includes(`Automatic triage is up to date  — pinned to Winston ${short}\n`));

  // A copy pinned to an older Winston commit: only its ref: line is rewritten.
  const edited = repinTriage(template, 'a'.repeat(40)).replace('timeout-minutes: 30', 'timeout-minutes: 45');
  assert.notEqual(edited, template);
  writeFileSync(wf, edited);
  // GitHub's compare of the installed pin with this Winston's: the fake answers from published.json.
  writeFileSync(join(s.tmp, 'published.json'), 'behind\n');
  assert.ok(s.cli(['doctor']).stdout.includes(`Automatic triage is up to date  — pinned to Winston aaaaaaa, newer than this Winston's ${short}: update Winston rather than the file (the Winston version line says how)\n`), 'a newer pin is never rolled back');
  assert.doesNotMatch(s.cli(['init', '--mode', 'adopt']).stdout, /Update .*to this Winston's version/);
  rmSync(join(s.tmp, 'published.json'));
  assert.match(s.cli(['doctor']).stdout, /^could not check\s+Automatic triage is up to date\s+— .*GitHub could not say which is newer, so the file is left as it is\. Updating Winston settles it$/m);
  writeFileSync(join(s.tmp, 'published.json'), 'ahead\n');
  assert.match(s.calls(), /^api repos\/sempervire\/winston\/compare\/a{40}\.\.\.[0-9a-f]{40} --jq \.status$/m);
  assert.ok(s.cli(['doctor']).stdout.includes(`Automatic triage is up to date  — pinned to Winston aaaaaaa; this Winston has the newer ${short}\n`));
  assert.match(s.cli(['init', '--mode', 'adopt', '--yes']).stdout, /^done\s+Update \.github\/workflows\/triage-on-new-issue\.yml to this Winston's version, [0-9a-f]{7} \(only its pinned version line changes\)$/m);
  assert.equal(readFileSync(wf, 'utf8'), repinTriage(edited, pin));
  assert.match(readFileSync(wf, 'utf8'), /timeout-minutes: 45/);

  // A workflow running a script of its own repository (Winston's own) has no pin to compare.
  writeFileSync(wf, 'run: node scripts/triage-issue.mjs --sweep\n');
  assert.match(s.cli(['doctor']).stdout, /^done\s+Automatic triage is up to date\s+— runs this repository's own copy of the script$/m);
});

test('the template pins the triage script to a commit that holds the script as it is now', (t) => {
  const pin = triageMechanism(readFileSync(join(ROOT, 'templates/triage-on-new-issue.yml'), 'utf8')).pin;
  assert.match(pin, /^[0-9a-f]{40}$/);
  assert.notEqual(pin, '0'.repeat(40));
  const has = spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${pin}^{commit}`]);
  if (has.status !== 0) return t.skip('the pinned commit is not in this clone');
  // Bump the pin (a commit of its own, after the script change) whenever this fails.
  const diff = spawnSync('git', ['-C', ROOT, 'diff', '--stat', pin, '--', 'scripts/triage-issue.mjs', 'lib/triage', 'lib/config.mjs'], { encoding: 'utf8' });
  assert.equal(diff.stdout, '', `the script changed since the pinned commit ${pin}`);
});

test('doctor says when a newer Winston is out, with the command, and stays quiet otherwise', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  const have = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version;
  // doctor reads the update check's cached answer; forgetting it stands in for a day passing.
  const cache = join(s.home, 'state/update-check/latest.json');
  const latest = (v) => { rmSync(cache, { force: true }); writeFileSync(join(s.tmp, 'latest.json'), JSON.stringify({ version: v })); };

  const unknown = s.cli(['doctor']);
  assert.match(unknown.stdout, new RegExp(`^could not check\\s+Winston version\\s+— ${have} installed; could not reach GitHub`, 'm'));
  assert.doesNotMatch(unknown.stdout, /\d\. Winston version/);

  latest(have);
  const current = s.cli(['doctor']);
  assert.match(current.stdout, new RegExp(`^done\\s+Winston version\\s+— ${have}, the latest$`, 'm'));
  assert.doesNotMatch(current.stdout, /\d\. Winston version/);

  latest('99.0.0');
  const old = s.cli(['doctor']);
  assert.match(old.stdout, new RegExp(`^needs you\\s+Winston version\\s+— ${have} installed, 99\\.0\\.0 available$`, 'm'));
  assert.match(old.stdout, /\d\. Winston version\n   Why: [^\n]+\n   Fix:\n     To update, follow the line for the app you use Winston in:\n       Claude Code: run `claude plugin marketplace update winston && claude plugin update winston@winston`, then restart Claude Code[^\n]*\n       Codex: run `codex plugin marketplace upgrade winston`, then `codex plugin add winston@winston`, start a new Codex session, and trust the new or changed hooks once with \/hooks\.\n     Winston never updates itself/);
  assert.doesNotMatch(s.calls(), /plugin update/, 'doctor never updates');
  assert.equal(s.cli(['doctor', '--fix']).status, 1, 'an unknown flag is refused');
  // GitHub is asked at most once a day: a new answer there is not seen until the cache ages out.
  writeFileSync(join(s.tmp, 'latest.json'), JSON.stringify({ version: have }));
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+Winston version\s+— .* installed, 99\.0\.0 available$/m);
  writeFileSync(cache, JSON.stringify({ ...JSON.parse(readFileSync(cache, 'utf8')), checkedAt: Date.now() - 25 * 60 * 60 * 1000 }));
  assert.match(s.cli(['doctor']).stdout, /^done\s+Winston version/m, 'a day later it asks again');
  assert.equal(old.status, unknown.status, 'an old Winston is reported, never a failed check');

  // From a copy under Codex's plugin cache, doctor shows Codex's steps alone, and the next step runs both commands.
  latest('99.0.0');
  const home = join(s.tmp, '.codex/plugins/cache/winston/winston/0.0.1');
  cpSync(ROOT, home, { recursive: true, filter: (src) => !/\/(\.git|\.claude\/worktrees|node_modules)$/.test(src) });
  const codex = spawnSync(process.execPath, [join(home, 'bin/winston'), 'doctor'], { cwd: s.repo, env: s.env, encoding: 'utf8' }).stdout;
  assert.match(codex, /Fix:\n     To update, run `codex plugin marketplace upgrade winston`, then `codex plugin add winston@winston`, start a new Codex session, and trust the new or changed hooks once with \/hooks\.\n     Winston never updates itself/);
  assert.doesNotMatch(codex, /claude plugin/);
  latest('0.0.1');
  assert.match(s.cli(['doctor']).stdout, /^done\s+Winston version/m, 'an older "latest" is not an update');
  latest('not-a-version; rm -rf');
  assert.match(s.cli(['doctor']).stdout, /^could not check\s+Winston version/m, 'a manifest that is not a version is ignored');
});

test('harnessOfRoot tells a Codex install, a Claude install and a dev checkout apart', (t) => {
  assert.equal(harnessOfRoot('/Users/x/.codex/plugins/cache/winston/winston/1.2.3'), 'codex');
  assert.equal(harnessOfRoot('/Users/x/.claude/plugins/cache/winston/winston/1.2.3'), 'claude');
  assert.equal(harnessOfRoot('/Users/x/Developer/winston'), null, 'a dev checkout is neither');
  const dir = mkdtempSync(join(tmpdir(), 'winston-harness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(harnessOfRoot(dir), null);
  writeFileSync(join(dir, '.codex-marketplace-install.json'), '{}');
  assert.equal(harnessOfRoot(dir), 'codex', 'the marker file Codex writes is enough');
});

test('a policy has triage rules when a heading names triage or it carries a risk tier', (t) => {
  const s = sandbox(t);
  const state = (text) => { writeFileSync(join(s.tmp, 'doc.md'), text); return policyState(join(s.tmp, 'doc.md')); };
  assert.equal(policyState(join(s.tmp, 'absent.md')), 'missing');
  assert.equal(policyState(s.tmp), 'missing', 'a directory is not a policy');
  assert.equal(state(''), 'empty');
  assert.equal(state('# Rules\n\n1. Never commit data. Priority is the owner\'s call; we triage nothing here.\n'), 'empty', 'the word in prose is not a rule');
  assert.equal(state('# Rules\n\n## Issue triage\n\nBugs first.\n'), 'ok');
  assert.equal(state('# Rules\n\nLabel docs fixes `risk: low`.\n'), 'ok');
  assert.equal(state('# Rules\n\nThe risk: of rain is high.\n'), 'empty');
});

test('doctor flags a policy with no triage rules; init writes a starter, repoints the config, and overwrites nothing', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  existingRepo(s);
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\n');
  writeFileSync(join(s.tmp, 'labels'), 'risk: low\nrisk: medium\nrisk: high\nauto-merge\nauto-verify\nhuman-verify\n');
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  mkdirSync(join(s.repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(s.repo, '.github/workflows/triage-on-new-issue.yml'), '');
  s.git('push', '-q', 'origin', 'main:staging');
  mkdirSync(join(s.repo, '.winston'));
  const configPath = join(s.repo, '.winston/config.json');
  const write = (policy) => writeFileSync(configPath, JSON.stringify({ owner: 'Dana', branches: { integration: 'staging', production: 'main' }, board: { owner: 'acme', number: 1 }, phase: false, triage: { policy, workflow: 'triage-on-new-issue.yml' } }));

  // The repo's rules doc is named as the policy and says nothing about triage.
  write('AGENTS.md');
  const doc = s.cli(['doctor']);
  assert.equal(doc.status, 1);
  assert.match(doc.stdout, /^needs you\s+Triage rules\s+— AGENTS\.md has no triage rules \(no heading that names triage, no risk: low\/medium\/high tier\), so triage would change nothing$/m);
  assert.match(doc.stdout, /\nNext step: Triage rules – type \/winston:init in this Claude Code chat\. Then run \/winston:doctor again\.\n$/);
  const plan = s.cli(['init', '--mode', 'adopt']);
  assert.match(plan.stdout, /Add TRIAGE\.md, the rules triage follows, filled in from these settings, and point the settings at it \(AGENTS\.md is left as it is\)\. Winston's standard risk ratings come with it and work as they are/);
  assert.ok(!existsSync(join(s.repo, 'TRIAGE.md')), 'no --yes, no change');
  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  // The starter is the template with the config's values in place of its {{keys}}.
  const starter = readFileSync(join(s.repo, 'TRIAGE.md'), 'utf8');
  const template = readFileSync(join(ROOT, 'templates/TRIAGE.md'), 'utf8');
  assert.match(template, /\{\{board\.statuses\[0\]\}\}/);
  assert.match(starter, /only issues that are open and in status `New` or `Ready` are evaluated/);
  assert.match(starter, /\*\*Owner\*\*: `Dana`\.\n- \*\*Board\*\*: project `1` of `acme`/);
  assert.match(starter, /work lands on `staging`; `main` is/);
  assert.equal(starter.match(/\{\{[^}]*\}\}/g), null, 'no placeholder is left');
  assert.deepEqual(policyBlanks(join(s.repo, 'TRIAGE.md')), []);
  assert.doesNotMatch(made.stdout, /Values to fill in/);
  assert.match(starter, /## Risk tiers \(per-repo\)/);
  // Nothing in the Names section is left for the owner to copy in by hand.
  assert.match(starter, /\*\*Priority options\*\*: the options of the `Priority` field, most urgent\n  first: `P0`, `P1`, `P2`, `P3`\./);
  assert.match(starter, /\*\*Other rules\*\*: none beyond this file\./);
  assert.match(starter, /^<!-- Winston wrote this file from \.winston\/config\.json, and it works as it is\./);
  assert.match(starter, /You don't need to read the rest: it is instructions for Winston\./);
  assert.equal(readFileSync(join(s.repo, 'AGENTS.md'), 'utf8'), '# Rules\n');
  const after = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(after.triage, { policy: 'TRIAGE.md', workflow: 'triage-on-new-issue.yml' });
  assert.equal(after.owner, 'Dana', 'the rest of the config is kept');
  const ok = s.cli(['doctor']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^done\s+Triage rules\s+— TRIAGE\.md$/m);

  // A config without an owner, branches or a board number: plain "fill this in" lines,
  // listed by init as the owner's step and flagged by doctor until they are gone.
  rmSync(join(s.repo, 'TRIAGE.md'));
  writeFileSync(configPath, JSON.stringify({ board: { owner: 'acme', statuses: ['Inbox'] }, triage: { policy: 'AGENTS.md' } }));
  const sparse = s.cli(['init', '--mode', 'adopt', '--yes']);
  const filled = readFileSync(join(s.repo, 'TRIAGE.md'), 'utf8');
  assert.equal(filled.match(/\{\{[^}]*\}\}/g), null, 'never a raw placeholder');
  assert.match(filled, /in status `Inbox` or `fill this in: the status that means ready to work` are evaluated/);
  assert.match(filled, /\*\*Owner\*\*: `fill this in: the name of the person who approves and decides`\./);
  assert.match(filled, /project `fill this in: the board's project number` of `acme`/);
  assert.match(filled, /work lands on `fill this in: the branch work lands on`; `fill this in: the branch that is released` is/);
  assert.match(sparse.stdout, /\nValues to fill in \(yours to do\): .*TRIAGE\.md has \d+ lines that say "fill this in"[^\n]*\n  line \d+: [^\n]*fill this in: /);
  const flagged = s.cli(['doctor']);
  assert.match(flagged.stdout, new RegExp(`^needs you\\s+Triage rules: blanks to fill\\s+— TRIAGE\\.md has ${policyBlanks(join(s.repo, 'TRIAGE.md')).length} lines still to fill in$`, 'm'));
  assert.match(flagged.stdout, /TRIAGE\.md has \d+ lines still to fill in \(open the file and replace each "fill this in" or \{\{placeholder\}\} with the real value\): line \d+: /);
  writeFileSync(join(s.repo, 'TRIAGE.md'), '# Triage\n\nOwner: {{owner}}\n');
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+Triage rules: blanks to fill\s+— TRIAGE\.md has 1 line still to fill in$/m);
  writeFileSync(join(s.repo, 'TRIAGE.md'), '# Triage\n\nOwner: Dana\n');
  assert.doesNotMatch(s.cli(['doctor']).stdout, /Triage rules: blanks/);

  // A policy file that is not there at all.
  write('docs/POLICY.md');
  rmSync(join(s.repo, 'TRIAGE.md'));
  write('../outside.md');
  writeFileSync(join(s.tmp, 'outside.md'), '# Triage\n');
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+Triage rules\s+— triage\.policy must be a file inside the repository/m);
  write('docs/POLICY.md');
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+Triage rules\s+— docs\/POLICY\.md not found, so triage has no rules to follow$/m);

  // A TRIAGE.md with rules already in the repo is pointed at, not rewritten.
  writeFileSync(join(s.repo, 'TRIAGE.md'), '## Triage\n\nmine\n');
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /Use the triage rules already in TRIAGE\.md: set triage\.policy to it in \.winston\/config\.json/);
  assert.equal(s.cli(['init', '--mode', 'adopt', '--yes']).status, 0);
  assert.equal(readFileSync(join(s.repo, 'TRIAGE.md'), 'utf8'), '## Triage\n\nmine\n');
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).triage.policy, 'TRIAGE.md');

  // An existing TRIAGE.md without rules is the owner's to fill in: never overwritten.
  writeFileSync(join(s.repo, 'TRIAGE.md'), 'notes to self\n');
  const kept = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.match(kept.stdout, /By hand \(each line says what to do next\):\n\s+- Triage rules: TRIAGE\.md exists and has no triage rules, and Winston does not overwrite your files: ask Claude/);
  assert.equal(readFileSync(join(s.repo, 'TRIAGE.md'), 'utf8'), 'notes to self\n');
});

test('permission rules come from the config: a narrow allow list and a deny list for what a pattern cannot leave out', () => {
  const { allow, deny } = permissionRules({ branches: { integration: 'develop', production: 'main' }, board: { number: 4 }, permissions: { allow: ['Bash(npm test*)', 'mcp__claude-in-chrome__navigate'] } }, ['Bash(make lint*)', 'Bash(npm test*)']);
  for (const r of ['Bash(git worktree add *)', 'Bash(git rebase origin/develop*)', 'Bash(git switch develop)', 'Bash(gh project item-list 4*)', 'Bash(gh pr review * --comment*)', 'Bash(git commit -m *)', 'Bash(npm test*)', 'Bash(make lint*)', 'mcp__claude-in-chrome__navigate']) assert.ok(allow.includes(r), r);
  assert.equal(new Set(allow).size, allow.length, 'no rule twice');
  // Nothing that takes every form of a command that has a dangerous one.
  for (const wide of ['Bash(git branch*)', 'Bash(git worktree*)', 'Bash(git commit*)', 'Bash(git push origin*)', 'Bash(gh pr review*)', 'Bash(gh pr edit*)', 'Bash(git switch*)']) assert.ok(!allow.includes(wide), wide);
  assert.ok(!allow.some((r) => r.startsWith('Bash(gh pr merge')), 'merging is listed only where the deploy gate guards merges');
  assert.ok(permissionRules({ deployGate: { guarded: [{ kind: 'pr-merge', base: 'main' }] } }).allow.includes('Bash(gh pr merge *)'));
  // What `git push origin *` and `gh pr review * --comment*` would otherwise let through.
  const blocked = (command) => deny.some((d) => coveredBy(`Bash(${command})`, [d]));
  for (const command of ['git push origin feat/x --force', 'git push --force-with-lease origin feat/x', 'git push -f origin feat/x', 'git push origin main', 'git push origin HEAD:main', 'git push origin HEAD:main --tags', 'git push origin +main', 'git push origin +feat/x', 'git push -u origin +feat/x:feat/x', 'git push origin refs/heads/main', 'git push origin refs/heads/main --tags', 'git push origin feat/x:refs/heads/main', 'git push origin --all', 'git push --mirror origin', 'git push -u origin main --tags', 'git push origin --delete feat/x', 'gh pr review 5 --comment -b ok --approve', 'gh pr review 5 -a', 'git branch -D feat/x', 'git branch --delete --force feat/x', 'git worktree remove --force ../wt', 'git worktree remove -f ../wt']) assert.ok(blocked(command), command);
  for (const command of ['git push origin feat/x', 'git push -u origin feat/x', 'git push -u origin feat/maintenance', 'git push origin HEAD:maintenance', 'git push origin maintenance', 'git push origin refs/heads/maintenance', 'git push origin feat/x:refs/heads/maintenance', 'git push origin a+b', 'gh pr review 5 --comment -b ok', 'git branch --list', 'git worktree remove ../wt']) assert.ok(!blocked(command), command);
  assert.ok(!permissionRules({}).deny.some((d) => d.includes('undefined')), 'no production branch, no production rule');
  assert.ok(!deny.some((d) => /:\*\)$/.test(d)), 'no deny rule ends in Claude Code\'s prefix syntax, which would deny the whole command');

  assert.equal(coveredBy('Bash(git push origin *)', ['Bash(git push*--force*)']), null, 'a narrower deny is no conflict');
  assert.equal(coveredBy('Bash(git push origin *)', ['Bash(git push *)']), 'Bash(git push *)');
  assert.equal(coveredBy('Bash(git push origin *)', ['Bash(git push:*)']), 'Bash(git push:*)');
  assert.equal(coveredBy('Bash(git status*)', ['Bash']), 'Bash');
  assert.equal(coveredBy('Bash(git status*)', ['Read', 'Bash(gh *)']), null);
  assert.equal(coveredBy('mcp__claude-in-chrome__navigate', ['mcp__claude-in-chrome__navigate']), 'mcp__claude-in-chrome__navigate');
});

test('winston permissions lists the rules; --apply adds only the missing ones and keeps everything else', (t) => {
  const s = sandbox(t);
  mkdirSync(join(s.repo, '.winston'));
  const config = { branches: { integration: 'staging', production: 'main' }, board: { owner: 'acme', number: 2 }, permissions: { allow: ['mcp__claude-in-chrome__navigate'] } };
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify(config));
  const want = permissionRules(config);
  const file = join(s.repo, '.claude/settings.json');
  const userFile = join(s.tmp, 'home/.claude/settings.json');
  mkdirSync(join(s.tmp, 'home/.claude'), { recursive: true });
  writeFileSync(userFile, '{"permissions":{"allow":[]}}');
  s.env.HOME = join(s.tmp, 'home');

  // No file yet: listing changes nothing, --apply creates it with both lists.
  const listed = s.cli(['permissions']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^Let Winston run everyday git and GitHub commands without asking you each time, while still blocking risky ones[^\n]*\nClaude is not allowed to grant itself permissions, so this one is yours to run: in this Claude Code chat, type: !winston permissions --apply\n\nDetails: the Claude Code rules Winston runs use in this repo, against \.claude\/settings\.json \(not there yet\)\.\n/, 'the plain summary and the one command first, the raw rules under Details');
  assert.match(listed.stdout, /^Allow \(these stop prompting\):\n  missing  Bash\(git status\*\)$/m);
  assert.match(listed.stdout, /^  missing  Bash\(gh project item-list 2\*\)$/m);
  assert.match(listed.stdout, /^Deny \([^\n]*deny wins over allow\):\n  missing  Bash\(git push\*--force\*\)$/m);
  assert.match(listed.stdout, /^  missing  Bash\(git push\* main\)$/m);
  assert.match(listed.stdout, /\nThe deny list blocks every force push, --force-with-lease included\. To update a branch that is already pushed, merge its base branch into it and push normally; do not rebase it\.\n/);
  assert.match(listed.stdout, /winston permissions --apply adds the \d+ missing allow and \d+ missing deny rules to the project's settings and changes nothing else\.\nAn allow rule only removes a prompt, and deny wins over allow: deny and ask rules, hooks, production approval and secret grants still apply\./);
  assert.ok(!existsSync(file));
  const created = s.cli(['permissions', '--apply']);
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).permissions, { allow: want.allow, deny: want.deny });
  assert.deepEqual(created.stdout.match(/^added    (.*)$/gm).map((l) => l.slice(9)), want.allow, 'it prints exactly what it added');
  // The deny additions are printed apart, with the reason.
  assert.match(created.stdout, /\nAdded to permissions\.deny, which wins over allow \(no existing deny or ask rule was removed or loosened\):\ndenied   Bash\(git push\*--force\*\)\n/);
  assert.deepEqual(created.stdout.match(/^denied   (.*)$/gm).map((l) => l.slice(9)), want.deny);
  // A hyphenated tool name is recognised the second time: nothing is appended again.
  const second = s.cli(['permissions', '--apply']);
  assert.match(second.stdout, /^Nothing to add/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).permissions.allow.filter((r) => r === 'mcp__claude-in-chrome__navigate').length, 1);
  assert.match(s.cli(['permissions']).stdout, /^  have     mcp__claude-in-chrome__navigate$/m);

  // An existing file: its rules, deny and ask lists, other keys, tabs, mode and missing final newline are kept.
  const before = {
    env: { TZ: 'UTC' },
    permissions: {
      allow: ['Bash(make *)', 'Bash(git status*)', 'Bash(gh pr comment *)', 'Bash(git push origin feat/*)', 'mcp__claude-in-chrome__navigate', 'Bash(git push origin main)'],
      deny: ['Bash(git push*--force*)', 'Bash(gh issue edit *)', 'Bash(rm -rf *)'],
      ask: ['Bash(gh pr create*)'],
    },
    hooks: {},
  };
  writeFileSync(file, JSON.stringify(before, null, '\t'));
  chmodSync(file, 0o600);
  const applied = s.cli(['permissions', '--apply', '--add', 'Bash(npm test*)']);
  assert.equal(applied.status, 0, applied.stderr);
  const text = readFileSync(file, 'utf8');
  const after = JSON.parse(text);
  assert.match(text, /^\t"env"/m);
  assert.ok(!text.endsWith('\n'));
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the file keeps its mode');
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual([after.env, after.hooks, after.permissions.ask], [before.env, before.hooks, before.permissions.ask]);
  assert.deepEqual(after.permissions.allow.slice(0, 6), before.permissions.allow, 'existing allow rules first, untouched');
  // A new deny that covers an allow rule the project already had is pointed out, not hidden.
  assert.match(applied.stdout, /These deny rules cover allow rules the project already had[^\n]*\n  Bash\(git push\* main\) now overrides the existing allow rule Bash\(git push origin main\)\n/);
  assert.match(applied.stdout, /\nThe deny list blocks every force push, --force-with-lease included\./);
  assert.deepEqual(after.permissions.deny.slice(0, 3), before.permissions.deny, 'existing deny rules first, none removed or loosened');
  for (const list of [after.permissions.allow, after.permissions.deny]) assert.equal(new Set(list).size, list.length, 'no duplicate entries');
  const added = after.permissions.allow.slice(6);
  assert.ok(added.includes('Bash(npm test*)') && added.includes('Bash(git worktree add *)'));
  for (const not of ['Bash(git status*)', 'Bash(gh pr comment *)', 'Bash(gh issue edit * --add-label *)', 'Bash(git push origin *)', 'Bash(gh pr create *)']) assert.ok(!added.includes(not), not);
  assert.match(applied.stdout, /^denied   Bash\(gh issue edit \* --add-label \*\)  — not added: the deny rule Bash\(gh issue edit \*\) covers it$/m);
  assert.match(applied.stdout, /^narrower Bash\(git push origin \*\)  — not added: the project allows a narrower form, Bash\(git push origin feat\/\*\)$/m);
  assert.match(applied.stdout, /^asks     Bash\(gh pr create \*\)  — not added: the ask rule Bash\(gh pr create\*\) covers it, so it still prompts$/m);
  assert.deepEqual(applied.stdout.match(/^added    (.*)$/gm).map((l) => l.slice(9)), added);
  assert.deepEqual(after.permissions.deny.slice(3), want.deny.filter((d) => d !== 'Bash(git push*--force*)'));

  // Idempotent.
  const again = s.cli(['permissions', '--apply', '--add', 'Bash(npm test*)']);
  assert.match(again.stdout, /Nothing to add/);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.match(s.cli(['doctor']).stdout, /^done\s+Fewer permission prompts\s+— \.claude\/settings\.json$/m);
  assert.equal(readFileSync(userFile, 'utf8'), '{"permissions":{"allow":[]}}', 'user-level settings are never touched');

  // A rule that would allow every shell command is refused, from --add or from the config.
  for (const wide of ['Bash', 'Bash(*)', 'Bash(:*)']) {
    const refused = s.cli(['permissions', '--apply', '--add', wide]);
    assert.equal(refused.status, 1, wide);
    assert.match(refused.stderr, /would allow every shell command, so Winston does not add it[^]*Nothing was changed/);
  }
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ ...config, permissions: { allow: ['Bash(*)'] } }));
  assert.equal(s.cli(['permissions', '--apply']).status, 1);
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify(config));
  assert.equal(readFileSync(file, 'utf8'), text);

  // A file that is not valid JSON, or not the shape Claude Code reads: stop, change nothing.
  for (const broken of ['{ "permissions": { "allow": [ ', '{"permissions":{"allow":"Bash(ls)"}}', '[]']) {
    writeFileSync(file, broken);
    const stopped = s.cli(['permissions', '--apply']);
    assert.equal(stopped.status, 1, broken);
    assert.match(stopped.stderr, /settings\.json is not (valid JSON|a settings object)[^]*Nothing was changed/);
    assert.equal(readFileSync(file, 'utf8'), broken);
  }
  assert.match(s.cli(['doctor']).stdout, /^could not check\s+Fewer permission prompts\s+— .*settings\.json is not/m);
  // A settings file hard-linked to one elsewhere is replaced, not written through.
  rmSync(file);
  linkSync(userFile, file);
  assert.equal(s.cli(['permissions', '--apply']).status, 0);
  assert.equal(readFileSync(userFile, 'utf8'), '{"permissions":{"allow":[]}}');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).permissions.allow.length > 0);
  assert.deepEqual(readdirSync(join(s.repo, '.claude')), ['settings.json'], 'no temporary file is left');
  // A link to a file inside the repository is followed: the real file is written, the link stays.
  rmSync(file);
  mkdirSync(join(s.repo, 'shared'));
  writeFileSync(join(s.repo, 'shared/settings.json'), '{}\n');
  symlinkSync(join(s.repo, 'shared/settings.json'), file);
  assert.equal(s.cli(['permissions', '--apply']).status, 0);
  assert.ok(lstatSync(file).isSymbolicLink());
  assert.deepEqual(JSON.parse(readFileSync(join(s.repo, 'shared/settings.json'), 'utf8')).permissions.deny, want.deny);
  // A link that leads out of the repository is not followed.
  rmSync(file);
  symlinkSync(userFile, file);
  const linked = s.cli(['permissions', '--apply']);
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /is a link that leads outside the repository\. Nothing was changed\./);
  assert.equal(readFileSync(userFile, 'utf8'), '{"permissions":{"allow":[]}}');
  assert.equal(s.cli(['permissions', '--add']).status, 1);
  assert.equal(s.cli(['permissions', '--add', 'rm -rf']).status, 1);
  assert.equal(s.cli(['permissions', '--aply']).status, 1);
});

test('doctor reports the permission rules the project lacks', (t) => {
  const s = sandbox(t);
  s.fake('gh', 'exit 1');
  const { allow, deny } = permissionRules({});
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), '{}');
  mkdirSync(join(s.repo, '.claude'));
  writeFileSync(join(s.repo, '.claude/settings.json'), JSON.stringify({ permissions: { allow: allow.filter((r) => r !== 'Bash(gh pr comment *)'), deny: deny.slice(1) } }));
  const doc = s.cli(['doctor']).stdout;
  assert.match(doc, /^needs you\s+Fewer permission prompts\s+— not set up yet: a long run stops to ask before everyday commands$/m);
  assert.match(doc, /\d\. Fewer permission prompts\n   Why: [^\n]+\n   Fix:\n     Claude is not allowed to grant itself permissions, so this one is yours to run: in this Claude Code chat, type: !winston permissions --apply\n/);
});

// ---- guided setup: doctor as the one checklist

// A repo set up on GitHub (board, labels, branches, workflow file) with the three gaps of a
// first setup: no Actions secrets, a policy file with no triage rules, no permission rules.
function gappedRepo(s) {
  fakeGh(s);
  existingRepo(s);
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\n');
  writeFileSync(join(s.tmp, 'labels'), 'risk: low\nrisk: medium\nrisk: high\nauto-merge\nauto-verify\nhuman-verify\n');
  writeFileSync(join(s.tmp, 'runs'), '');
  mkdirSync(join(s.repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(s.repo, '.github/workflows/triage-on-new-issue.yml'), '');
  s.git('push', '-q', 'origin', 'main:staging');
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ owner: 'Dana', branches: { integration: 'staging', production: 'main' }, board: { owner: 'acme', number: 1 }, phase: false, triage: { policy: 'AGENTS.md', workflow: 'triage-on-new-issue.yml' } }));
}
const lastLine = (out) => out.trimEnd().split('\n').at(-1);

test('doctor lists what needs the owner with why and how, names the first as the next step, and moves on as each is fixed', (t) => {
  const s = sandbox(t);
  gappedRepo(s);
  const first = s.cli(['doctor']);
  for (const name of ['Triage rules', 'Automatic triage keys', 'Fewer permission prompts']) {
    assert.match(first.stdout, new RegExp(`^needs you\\s+${name}`, 'm'), name);
    assert.match(first.stdout, new RegExp(`\\d\\. ${name}\\n   Why: [^\\n]+\\n   Fix:\\n     \\S`), name);
  }
  assert.match(first.stdout, /Needs you \(3\):/);
  assert.equal(lastLine(first.stdout), 'Next step: Triage rules – type /winston:init in this Claude Code chat. Then run /winston:doctor again.');

  // Fix the policy: that item is done. The starter's standard risk ratings are a working
  // default: a tip, never "needs you", and never the next step.
  assert.equal(s.cli(['init', '--mode', 'adopt', '--yes']).status, 0);
  const second = s.cli(['doctor']);
  assert.match(second.stdout, /^done\s+Triage rules\s+— TRIAGE\.md$/m);
  assert.match(second.stdout, /^tip\s+Risk ratings for this project\s+— TRIAGE\.md uses Winston's standard risk ratings$/m);
  assert.match(second.stdout, /\nTips \(nothing is wrong; these make Winston fit this project better\):\n  - Tip: Claude can tailor the risk ratings in TRIAGE\.md to this project/);
  assert.doesNotMatch(second.stdout, /\d\. Risk ratings/);
  assert.equal(second.status, 0, 'the standard ratings are not a failed setup');
  const policy = join(s.repo, 'TRIAGE.md');
  writeFileSync(policy, readFileSync(policy, 'utf8').replace('is docs, copy or tooling only — nothing a user runs behaves differently', 'touches only docs/'));
  assert.doesNotMatch(s.cli(['doctor']).stdout, /Risk ratings for this project/, 'tailored ratings: no tip');

  // Then the secrets, then the permission rules.
  // A missing secret: the next step is the link that fills in the token form.
  assert.equal(lastLine(s.cli(['doctor']).stdout), 'Next step: Automatic triage keys – open https://github.com/settings/tokens/new?scopes=repo,project and follow the steps under 1 above. Then run /winston:doctor again.');
  // With GH_PAT in place, it is the one command that makes the other token.
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\n');
  assert.equal(lastLine(s.cli(['doctor']).stdout), 'Next step: Automatic triage keys – in the Terminal app, run: claude setup-token. Then run /winston:doctor again.');
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  const third = s.cli(['doctor']);
  assert.match(third.stdout, /^done\s+Automatic triage keys/m);
  assert.equal(lastLine(third.stdout), 'Next step: Fewer permission prompts – in this Claude Code chat, type: !winston permissions --apply. Then run /winston:doctor again.');
  assert.equal(s.cli(['permissions', '--apply']).status, 0);
  const complete = s.cli(['doctor']);
  assert.equal(complete.status, 0, complete.stdout);
  assert.doesNotMatch(complete.stdout, /^needs you/m);
  assert.match(lastLine(complete.stdout), /^Setup is complete: nothing needs you\./);
  assert.match(s.cli(['doctor', '--copy']).stdout, /\nNothing was copied: there is no next step\.\n/);

  // init on the finished repo changes nothing and says so.
  const before = s.git('status', '--porcelain');
  const again = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(again.stdout, 'Nothing to do: the setup is complete. Nothing was changed. Safe to run again.\n');
  assert.equal(s.git('status', '--porcelain'), before);
});

test('doctor --copy puts the next step\'s command on the clipboard', { skip: process.platform !== 'darwin' }, (t) => {
  const s = sandbox(t);
  s.fake('gh', 'exit 1');
  s.fake('pbcopy', `cat > "${s.tmp}/clipboard"`);
  assert.match(lastLine(s.cli(['doctor', '--copy']).stdout), /^Next step: GitHub sign-in with board access – in the Terminal app, run: gh auth login   \(copied to the clipboard\)\./);
  assert.equal(readFileSync(join(s.tmp, 'clipboard'), 'utf8'), 'gh auth login');
  rmSync(join(s.tmp, 'clipboard'));
  s.cli(['doctor']);
  assert.ok(!existsSync(join(s.tmp, 'clipboard')), 'only when asked');
  // When nothing reaches the clipboard it says so, and the next step is still the last line.
  s.fake('pbcopy', 'exit 1');
  const failed = s.cli(['doctor', '--copy']).stdout;
  assert.match(failed, /\nNothing was copied: pbcopy did not run\.\n/);
  assert.match(lastLine(failed), /^Next step: GitHub sign-in with board access – in the Terminal app, run: gh auth login\. Then/);
});

test('every stop on a missing prerequisite points at /winston:doctor', (t) => {
  assert.equal(DOCTOR_POINTER, 'Run /winston:doctor to see what is missing and how to fix it.');
  const flat = (f) => readFileSync(join(ROOT, 'skills', f, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  for (const skill of ['codex', 'gemini', 'radar', 'rex', 'verdict', 'triage', 'winston']) assert.ok(flat(skill).includes(DOCTOR_POINTER.replace(/\s+/g, ' ')) || flat(skill).includes('Run /winston:doctor to see what is missing and how to fix it.'), skill);
  assert.equal(flat('triage').split('to see what is missing and how to fix it').length - 1, 2, 'no policy, and no board');

  const s = sandbox(t);
  s.fake('gh', 'exit 1');
  // The CLI's own stops say what to do next, in place, rather than sending the reader on.
  const noGh = s.cli(['init', '--mode', 'new']);
  assert.equal(noGh.status, 1);
  assert.match(noGh.stderr, /^Winston can't reach GitHub: the GitHub command-line tool \(gh\) is not signed in\. In the Terminal app, run: gh auth login, then: gh auth refresh -s project\. Then run \/winston:init again\.\n$/);
  assert.match(s.cli(['init', '--mode', 'join']).stdout, /run \/winston:init and Winston will set it up for you\.\n$/);
  assert.match(s.cli(['permissions'], s.tmp).stderr, /is not a project that uses git[^\n]*Open Claude Code in your project's folder and try again\.\n$/);
});

test('skills with a closing report carry the no-bare-statement rule (#52)', () => {
  const flat = (f) => readFileSync(join(ROOT, 'skills', f, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  for (const skill of ['init', 'doctor', 'handoff']) {
    const t = flat(skill);
    assert.ok(t.includes('Closing report') && t.includes('no item without an action') || t.includes('Closing report rule'), skill);
    assert.match(t, /already done/, skill);
    assert.match(t, /pbcopy/, skill);
    assert.match(t, /question-box choice with the recommended option first/, skill);
  }
  assert.doesNotMatch(flat('init'), /Relay it as it stands/);
  assert.match(flat('init'), /Never use `gh pr merge --admin`/);
  assert.match(flat('init'), /gh pr merge <n> --merge/);
  assert.match(flat('init'), /production deploy/);
  assert.match(flat('doctor'), /read-only and performs no fix/);
});

test('the token link fills in what GitHub documents, by who owns the board', () => {
  // A user's board, or one under another owner than the repo: the classic form, scopes ticked.
  assert.equal(tokenUrl({ fineGrained: false, slug: 'pat/thing', boardOwner: 'pat' }), 'https://github.com/settings/tokens/new?scopes=repo,project');
  // An organization's board: the fine-grained form, owner, expiry and the two permissions.
  const url = new URL(tokenUrl({ fineGrained: true, slug: 'acme-co/my app & more-than-forty-characters-long-name', boardOwner: 'acme-co' }));
  assert.equal(url.origin + url.pathname, 'https://github.com/settings/personal-access-tokens/new');
  assert.deepEqual([...url.searchParams.keys()], ['name', 'description', 'target_name', 'expires_in', 'issues', 'organization_projects'], 'only documented parameters');
  assert.equal(url.searchParams.get('target_name'), 'acme-co');
  assert.equal(url.searchParams.get('expires_in'), '90');
  assert.equal(url.searchParams.get('issues'), 'write');
  assert.equal(url.searchParams.get('organization_projects'), 'write');
  assert.equal(url.searchParams.get('name'), 'winston triage my app & more-than-forty-');
  assert.equal(url.searchParams.get('name').length, 40, 'GitHub caps a token name at 40 characters');
  assert.match(url.searchParams.get('description'), /^Winston triage workflow for acme-co\/my app & more-than-forty-characters-long-name: /);
  // Encoded, so a space or an ampersand in a name cannot add or break a parameter.
  assert.doesNotMatch(url.search, / /);
  assert.match(url.search, /name=winston\+triage\+my\+app\+%26\+more/);
  assert.doesNotMatch(tokenUrl({ fineGrained: true, slug: 'acme/thing', boardOwner: 'acme' }), /scopes=|token=|ghp_/);
});

test('commands for a person take the form of the app Winston runs in, and the merge rule is stated', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  const as = (h, args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd: cwd ?? s.repo, env: { ...s.env, WINSTON_HARNESS: h }, encoding: 'utf8' });
  // Codex: no `!` and no slash command, and a legend says how to read the rest.
  const codex = as('codex', ['doctor']).stdout;
  assert.match(codex, /^In Codex: where this says \/winston:<name>, ask Codex to use the winston:<name> skill; where it says !winston \.\.\., ask Codex to run winston \.\.\.\.\n/m);
  assert.match(codex, /Fix:\n     Ask Codex to use the winston:init skill\. It shows its plan/);
  assert.match(codex, /\nNext step: Winston settings for this repo – ask Codex to use the winston:init skill\. Then/);
  assert.doesNotMatch(codex, /this Claude Code chat/);
  assert.match(as('codex', ['init']).stdout, /To go ahead, ask Codex to run: winston init --mode new --yes/);
  // Not known: both forms.
  assert.match(as('unknown', ['init']).stdout, /To go ahead, in Claude Code, type in the chat: !winston init --mode new --yes   \(in Codex, ask it to run: winston init --mode new --yes\)/);
  // A value the shell would expand is single-quoted.
  assert.match(s.cli(['init', '--mode', 'new', '--owner', 'Pat $HOME']).stdout, /To go ahead, in this Claude Code chat, type: !winston init --mode new --owner 'Pat \$HOME' --yes/);
  // The default gate brings the merge allow rule, and the plan says what it allows.
  assert.match(s.cli(['init']).stdout, /It also lets Winston merge pull requests without asking; a merge into main still waits until you type "approve production deploy" in the session \(the deploy gate\)\./);
  // adopt is refused in a home folder that is a git repository, as new is.
  existingRepo(s);
  const adopt = spawnSync(process.execPath, [CLI, 'init', '--mode', 'adopt'], { cwd: s.repo, env: { ...s.env, HOME: s.repo }, encoding: 'utf8' });
  assert.equal(adopt.status, 1);
  assert.match(adopt.stdout, /it is your home folder/);
});

test('release step: per-issue Fixes lines, Verify excluded, Done after promotion (#85)', () => {
  const w = readFileSync(join(ROOT, 'skills', 'winston', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(w, /one `Fixes #N` line per issue then in `Verified`, read with one `gh project item-list` call just before the body is written \(configured status names\); each line has its own keyword/);
  assert.match(w, /Issues still in `Verify` get no keyword; they stay with the promotion gate/);
  assert.match(w, /After the promotion PR merges, Winston moves every released card \(the issues on those `Fixes` lines, not later arrivals in `Verified`\) from `Verified` to `Done`/);
  assert.match(w, /`Done` is not one of the four config roles/);
});

test('model tiers, scope, fresh review lane, lane briefs and handoff rules (#78)', () => {
  const flat = (f) => readFileSync(join(ROOT, 'skills', f, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  const w = flat('winston');
  const cost = "Cost never delays startable work. It still sets each lane's model tier and scope: the lowest tier and narrowest scope that do the job, unless a lane states why not.";
  assert.equal(w.split(cost).length - 1, 2, 'Parallelism row and Parallelism check');
  assert.match(w, /name it\. Cost never delays/);
  assert.match(w, /\. Only the real limits in step 3 hold work back\./);
  assert.doesNotMatch(w, /Token or model cost is never a reason/);
  const raw = readFileSync(join(ROOT, 'skills', 'winston', 'SKILL.md'), 'utf8').split('\n');
  const row = (name) => { const l = raw.find((x) => x.startsWith('| ' + name + ' |')); assert.ok(l, name); return l; };
  const tiers = row('Model tiers');
  assert.match(tiers, /top, middle, lowest/);
  assert.match(tiers, /Lowest tier for pure scripting \(provisional\)/);
  assert.match(tiers, /both the production model \(.*?\) and the middle tier/);
  assert.match(tiers, /one-line reason in its dispatch/);
  assert.match(tiers, /This table is the default; the cost rule governs any deviation/);
  assert.match(tiers, /the model whose output the stand-in must match/);
  assert.match(tiers, /recorded with the slice result in the dispatch/);
  const scope = row('Scope and fan-out');
  assert.match(scope, /required scope first/);
  assert.match(scope, /if the required-scope result misses its acceptance check, or if the owner opted in at setup/);
  assert.match(scope, /more than 5 agents, write a token estimate in the plan; it is a note, not a stop/);
  assert.match(scope, /fewer, larger agents/);
  const review = row('Fresh review lane');
  assert.match(review, /Provisional/);
  assert.match(review, /reports when the PR is green, then sits idle for review/);
  assert.match(review, /one or two files, Winston resumes that same build lane/);
  assert.match(review, /over two files goes to a fresh lane briefed with the PR, its findings and the files touched/);
  assert.match(review, /review-round limits are unchanged/);
  const briefs = row('Lane briefs');
  assert.match(briefs, /Pin the base commit/);
  assert.match(briefs, /Grep before reading any file over about 500 lines/);
  assert.match(briefs, /Trim inputs/);
  assert.match(briefs, /Lane dispatch prompts carry this rule/);
  const size = row('Orchestrator size');
  assert.match(size, /\/winston:handoff/);
  for (const r of [tiers, scope, review, briefs, size]) assert.doesNotMatch(r, /haiku|sonnet|opus/i);
});
