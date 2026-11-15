import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { harnessOfRoot } from '../lib/update.mjs';
import { loadConfig, loadLayers } from '../lib/config.mjs';
import { coveredBy, DOCTOR_POINTER, firesOnNewIssue, permissionRules, policyBlanks, policyState, tokenUrl } from '../bin/winston';

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
  // No test asks the network for the latest version: the lookup reads a file that is absent unless a test writes it.
  const env = { ...process.env, WINSTON_HOME: home, CODEX_HOME: join(tmp, 'codex'), CLAUDE_CONFIG_DIR: join(tmp, 'claude'), WINSTON_UPDATE_URL: `file://${join(tmp, 'latest.json')}`, PATH: `${bin}:${process.env.PATH}` };
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
  assert.match(doc.stdout, /^done\s+claude on PATH/m);
  assert.match(doc.stdout, /^done\s+gh auth with project scope/m);
  assert.match(doc.stdout, /^needs you\s+repo config/m);
  assert.match(doc.stdout, /^needs you\s+triage labels\s+— missing: risk: low/m);
  assert.match(doc.stdout, /^needs you\s+triage-on-new-issue workflow/m);
  assert.match(doc.stdout, /^(on|off)\s+codex CLI/m);
  assert.match(doc.stdout, /^Winston setup checklist for .*\. Safe to run again: it only reads\.\n/);
  // A repo with no config has one thing to do, and the last line names it.
  assert.match(doc.stdout, /Needs you \(1\):\n\n1\. repo config\n   Why: [^\n]+\n   Fix:\n     winston init   \(or \/winston:init; it asks which setup fits: join, new or adopt/);
  assert.match(doc.stdout, /\nNext step: repo config – run: winston init\. Then run winston doctor again\.\n$/);
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
  assert.match(doc.stdout, /^done\s+board reachable/m);
  assert.match(doc.stdout, /^needs you\s+board kanban view\s+— no board view with Status columns/m);
  assert.match(doc.stdout, /^needs you\s+starting milestone\s+— no open milestone/m);
  // Neither new check needs the owner's input, so init can create both on its own.
  assert.match(doc.stdout, /\d\. board kanban view\n   Why: [^\n]+\n   Fix:\n     winston init --mode adopt   \(or \/winston:init; it shows this plan first, then asks: create a board view with Status columns/);

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout);
  assert.match(made.stdout, /done\s+create milestone "Phase 1\.0" on the repo/);
  assert.match(made.stdout, /done\s+create a board view with Status columns, filtered to a milestone, its cards showing labels/);
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
  assert.match(s.cli(['doctor']).stdout, /triage labels\s+— missing: HOLD, verify-prod/);
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
    workflows: { nodes: workflows.map((name) => ({ name, enabled: true })) },
    views: { nodes: views },
  } } } });
// As GitHub returns a board view: the columns are the vertical grouping, groupByFields is empty.
const KANBAN = [{ id: 'VIEW9', name: 'Pilot', layout: 'BOARD_LAYOUT', fields: { nodes: [{ id: 'TITLE1', name: 'Title' }, { id: 'LABELS1', name: 'Labels' }] }, groupByFields: { nodes: [] }, verticalGroupByFields: { nodes: [{ name: 'Status' }] } }];
const KANBAN_NO_LABELS = [{ ...KANBAN[0], fields: { nodes: [{ id: 'TITLE1', name: 'Title' }] } }];
const INTAKE = ['Auto-add to project', 'Item added to project'];
// Recent issues with their project events: [number, [[type, actor, board owner, board number], ...]].
const BOT = 'github-project-automation';
const timelineJson = (issues) => JSON.stringify({ data: { repository: { issues: { nodes: issues.map(([number, events]) => ({ number, timelineItems: { nodes: events.map(([type, login, owner, n]) => ({ __typename: type === 'add' ? 'AddedToProjectV2Event' : 'ProjectV2ItemStatusChangedEvent', actor: { login }, project: { number: n, owner: { login: owner } } })) } })) } } } });
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

test('init without --mode asks which setup this is, names the likely one, and changes nothing', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  const asked = s.cli(['init']);
  assert.equal(asked.status, 0);
  assert.match(asked.stdout, /^  join /m);
  assert.match(asked.stdout, /^  new /m);
  assert.match(asked.stdout, /^  adopt /m);
  assert.match(asked.stdout, /Looks like: new — the repository has no commits\./);
  const forced = s.cli(['init', '--yes']);
  assert.equal(forced.status, 2, '--yes never picks the setup');
  assert.match(forced.stderr, /needs --mode/);
  assert.equal(s.cli(['init', '--mode', 'sideways']).status, 2);
  // A flag missing its value never swallows the next flag, and unknown flags are refused.
  for (const bad of [['--mode', 'new', '--integration', '--yes'], ['--mode'], ['--mode', 'new', '--yess']]) {
    const r = s.cli(['init', ...bad]);
    assert.equal(r.status, 1, bad.join(' '));
    assert.match(r.stderr, /needs a value|unknown argument/);
  }
  assert.ok(!existsSync(join(s.repo, '.winston')) && s.calls() === '', 'nothing written, GitHub not touched');

  existingRepo(s);
  assert.match(s.cli(['init']).stdout, /Looks like: adopt/);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), '{}');
  assert.match(s.cli(['init']).stdout, /Looks like: join/);
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
  assert.match(plan.stdout, /create a private GitHub Project "repo" under pat/);
  assert.match(plan.stdout, /create the private GitHub repository pat\/repo/);
  assert.match(plan.stdout, /create branch staging on origin from main/);
  assert.match(plan.stdout, /create labels: risk: low/);
  assert.doesNotMatch(plan.stdout, /write .*triage-on-new-issue\.yml from the template/, 'the first commit writes the workflow; it is not planned twice');
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
  assert.deepEqual(originHeads(s), ['main', 'staging']);
  assert.deepEqual(s.git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.github/workflows/triage-on-new-issue.yml', '.winston/config.json'], 'the first commit holds only what init wrote');
  const calls = s.calls();
  assert.match(calls, /updateProjectV2Field[^\n]*\[\{id:"opt0",name:"New",color:BLUE,description:"Issues That Need To Be Evaluated"\},\{name:"Ready",color:GREEN[^\n]*\{id:"opt1",name:"In Progress",color:YELLOW[^\n]*\{name:"Verify",color:RED[^\n]*\{name:"Verified",color:GRAY[^\n]*\{id:"opt2",name:"Done",color:PURPLE/, 'six columns in order; each stock option kept by id, Todo as New so the board\'s own workflow sets it');
  assert.match(calls, /project field-create 7 --owner pat --name Start date --data-type DATE/);
  assert.match(calls, /project field-create 7 --owner pat --name Target date --data-type DATE/);
  assert.match(calls, /updateProjectV2View\(input:\{viewId:\$viewId,configuration:\{visibleFieldIds:\["TITLE1","STATUS1","LABELS1","LINKED1"\]\},filter:"milestone:\\"Phase 1\.0\\""\}/, 'the new view shows labels on its cards');
  assert.equal(calls.match(/updateProjectV2Field/g).length, 1);
  assert.match(calls, /project field-create 7 --owner pat --name Priority/);
  assert.match(calls, /project link 7 --owner pat --repo repo$/m);
  assert.ok(calls.indexOf('project create') < calls.indexOf('repo create') && calls.indexOf('repo create') < calls.indexOf('project link'));
  assert.match(readFileSync(join(s.tmp, 'labels'), 'utf8'), /^risk: high$/m);
  assert.match(made.stdout, /done\s+create a board view with Status columns/);
  // The board is brand new and has no issues yet, so the "off" from the API cannot be told
  // apart from "on but not yet proven" (#45): not a required step, just an optional one.
  assert.match(made.stdout, /Could not confirm \(may already be on; optional, in the browser\):\n {2}- board auto-adds new issues: open https:\/\/github\.com\/users\/pat\/projects\/7\/workflows, choose "Auto-add to project", click Edit, pick this repository and set the filter to is:issue/);
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
  assert.match(plan.stdout, /production main, integration staging, board acme project 3, process docs AGENTS\.md/);
  assert.match(plan.stdout, /add Status columns to the board, in Winston's order: New, In Progress, Verify, Verified, Done \(its existing options are kept as they are\)/);
  assert.match(plan.stdout, /show Labels on the cards of: Pilot/);
  assert.match(plan.stdout, /add a single-select Priority field/);
  assert.match(plan.stdout, /Note: Commit .*config\.json and .*triage-on-new-issue\.yml to main/);
  assert.match(plan.stdout, /write .*TRIAGE\.md, a starter triage policy filled in from the config\. Its three \(per-repo\) sections are generic: the risk tiers must be written for this repo/);
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
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /integration staging/, 'staging exists now and wins');
  assert.match(s.cli(['init', '--mode', 'adopt', '--integration', 'develop']).stdout, /integration develop/);
  assert.doesNotMatch(s.cli(['init', '--mode', 'adopt', '--integration', 'develop']).stdout, /create branch/);
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

  assert.match(s.cli(['doctor']).stdout, /\d\. integration branch on origin\n   Why: [^\n]+\n   Fix:\n     winston init --mode adopt   \([^\n]*create branch staging on origin from main\)/);
  const plan = s.cli(['init', '--mode', 'adopt']);
  assert.match(plan.stdout, /would:\n\s+- create branch staging on origin from main\n/);
  assert.doesNotMatch(plan.stdout, /By hand/);
  assert.deepEqual(originHeads(s), ['main'], 'a plan changes nothing');

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.match(made.stdout, /done\s+create branch staging on origin from main/);
  assert.deepEqual(originHeads(s), ['main', 'staging']);
  assert.match(s.cli(['doctor']).stdout, /^done\s+integration branch on origin\s+— staging$/m);

  // join changes nothing on GitHub: the gap stays the owner's.
  write({ integration: 'develop', production: 'main' });
  assert.match(s.cli(['init', '--mode', 'join', '--yes']).stdout, /They are [^\n]* to close[^]*- integration branch on origin — develop/);
  assert.deepEqual(originHeads(s), ['main', 'staging']);

  // A production branch origin lacks is a wrong config, not something to create.
  write({ integration: 'develop', production: 'release' });
  const wrong = s.cli(['init', '--mode', 'adopt']);
  assert.doesNotMatch(wrong.stdout, /create branch/);
  assert.match(wrong.stdout, /By hand:\n(\s+- [^\n]+\n)*\s+- integration branch on origin: develop\n/);
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
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /very required check passes\. Nothing was changed/);

  // Both on disk: doctor reports it, and init asks rather than guess.
  rival();
  const doc = s.cli(['doctor']);
  assert.match(doc.stdout, /^needs you\s+triage workflow conflicts\s+— auto-triage\.yml also triages every new issue$/m);
  assert.match(doc.stdout, /\d\. triage workflow conflicts\n   Why: Two workflows[^\n]+\n   Fix:\n     auto-triage\.yml and triage-on-new-issue\.yml would both triage every new issue[^\n]*--triage keep[^\n]*--triage replace[^\n]*--triage both/);
  assert.doesNotMatch(doc.stdout, /greet\.yml|weekly\.yml|label\.yml/);
  const asked = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(asked.status, 0, asked.stdout);
  assert.match(asked.stdout, /Triage workflow, your choice: auto-triage\.yml also triages every new issue, and Winston's would too\. Rerun with one of:\n  --triage keep  [^\n]+\n  --triage replace [^\n]+\n  --triage both  [^\n]+\nUntil you choose, init leaves the triage workflows as they are\./);
  assert.ok(existsSync(ours) && existsSync(theirs), 'nothing is deleted without the choice');
  assert.equal(s.cli(['init', '--mode', 'adopt', '--triage', 'sometimes']).status, 2);

  // replace: Winston's stays, the other goes.
  assert.match(s.cli(['init', '--mode', 'adopt', '--triage', 'replace']).stdout, /would:\n\s+- make Winston's workflow the only triage: delete .*auto-triage\.yml/);
  assert.ok(existsSync(theirs), 'a plan changes nothing');
  assert.match(s.cli(['init', '--mode', 'adopt', '--triage', 'replace', '--yes']).stdout, /done\s+make Winston's workflow the only triage[^]*Note: Commit the deletion of .*auto-triage\.yml to main: until then it still runs on every new issue/);
  assert.ok(existsSync(ours) && !existsSync(theirs) && existsSync(join(dir, 'greet.yml')));
  assert.doesNotMatch(s.cli(['doctor']).stdout, /triage workflow conflicts/);

  // both: recorded, so it is asked once.
  rival();
  assert.match(s.cli(['init', '--mode', 'adopt', '--triage', 'both', '--yes']).stdout, /done\s+keep both, knowingly: record auto-triage\.yml under triage\.alongside/);
  assert.deepEqual(config().triage, { alongside: ['auto-triage.yml'] });
  assert.ok(existsSync(ours) && existsSync(theirs));
  assert.doesNotMatch(s.cli(['doctor']).stdout, /triage workflow conflicts/);

  // keep: the other stays, Winston's goes, and doctor stops asking for it.
  reset();
  assert.match(s.cli(['init', '--mode', 'adopt', '--triage', 'keep', '--yes']).stdout, /done\s+keep auto-triage\.yml as this repository's triage: delete .*triage-on-new-issue\.yml, and set triage\.workflow to false/);
  assert.ok(!existsSync(ours) && existsSync(theirs));
  assert.equal(config().triage.workflow, false);
  const kept = s.cli(['doctor']);
  assert.match(kept.stdout, /^off\s+triage-on-new-issue workflow\s+— not installed, by choice/m);
  assert.doesNotMatch(kept.stdout, /triage workflow (conflicts|secrets|runs)/);
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /very required check passes\. Nothing was changed/);

  // The other one first, Winston's not yet written: it is not written until the owner chooses.
  reset();
  const held = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.match(held.stdout, /Triage workflow, your choice/);
  assert.doesNotMatch(held.stdout, /Secrets the triage workflow needs|claude setup-token/, 'no secrets steps for a workflow that is not being written');
  assert.ok(!existsSync(ours));
  assert.match(s.cli(['doctor']).stdout, /^off\s+triage-on-new-issue workflow\s+— not written: auto-triage\.yml already triages new issues$/m);
  assert.match(s.cli(['init', '--mode', 'adopt', '--triage', 'replace', '--yes']).stdout, /done\s+make Winston's workflow the only triage: write .*triage-on-new-issue\.yml from the template, and delete/);
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
  assert.match(doc.stdout, /^needs you\s+issue phase\s+— new issues get no milestone, so a board view filtered to "Pilot" never shows them$/m);
  assert.match(doc.stdout, /^needs you\s+issues without a milestone\s+— 2 open issues have no milestone and are hidden from a board view filtered to "Pilot"$/m);
  assert.match(doc.stdout, /\d\. issue phase\n   Why: A board view filtered to a milestone hides[^\n]+\n   Fix:\n     winston init --mode adopt   \([^\n]*give every new issue the milestone "Pilot"/);

  const plan = s.cli(['init', '--mode', 'adopt']);
  assert.match(plan.stdout, /- give every new issue the milestone "Pilot": set "phase" to it in .*config\.json, and write .*set-issue-phase\.yml \(it takes effect once it and the config are committed to the default branch/);
  assert.match(plan.stdout, /- set the milestone "Pilot" on the 2 open issues that have none \(#7, #13\), so the board view shows them; an issue that has a milestone is not touched/);
  assert.ok(!existsSync(wf) && config().phase === undefined, 'a plan changes nothing');
  assert.doesNotMatch(s.calls(), /issue edit/);

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.equal(config().phase, 'Pilot');
  assert.match(made.stdout, /Note: Commit .*config\.json and .*set-issue-phase\.yml to main: GitHub runs the phase workflow from the default branch only/);
  assert.match(plan.stdout, /Note: Commit .*set-issue-phase\.yml to main/);
  assert.deepEqual(config().board, { owner: 'acme', number: 1 }, 'the rest of the config is as it was');
  assert.equal(readFileSync(wf, 'utf8'), readFileSync(join(ROOT, 'templates/set-issue-phase.yml'), 'utf8'));
  assert.match(s.calls(), /issue edit 7 --milestone Pilot\n[^]*issue edit 13 --milestone Pilot\n/);
  const after = s.cli(['doctor']);
  assert.match(after.stdout, /^done\s+issue phase\s+— new issues get the milestone "Pilot" once set-issue-phase\.yml and the config are committed to the default branch$/m);
  s.git('add', '.winston', '.github');
  s.git('commit', '-q', '-m', 'setup');
  assert.match(s.cli(['doctor']).stdout, /^done\s+issue phase\s+— new issues get the milestone "Pilot"$/m);
  assert.doesNotMatch(after.stdout, /issues without a milestone|triage workflow conflicts/, 'nothing reported when none is hidden; the phase workflow is not a second triage');
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /very required check passes\. Nothing was changed/);

  // The phase is one line: a milestone that is not open is the owner's to correct.
  write({ phase: 'Gone' });
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+issue phase\s+— phase is "Gone", which is not an open milestone$/m);
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /By hand:\n\s+- issue phase: set "phase" in .*config\.json to the current milestone \(open: Pilot, Later\), or to false/);

  // Views filtered to several milestones: which is current is the owner's to say.
  write();
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: filtered('Pilot', 'Later') }));
  const several = s.cli(['doctor']);
  assert.match(several.stdout, /^needs you\s+issue phase\s+— the board's views filter to several milestones \(Pilot, Later\) and none is named as current$/m);
  assert.match(several.stdout, /add "phase": "<one of Pilot, Later>" to /);
  assert.doesNotMatch(s.cli(['init', '--mode', 'adopt', '--yes']).stdout, /give every new issue/);
  write({ phase: 'Later' });
  assert.match(s.cli(['doctor']).stdout, /^done\s+issue phase\s+— new issues get the milestone "Later" once /m);

  // A view that filters nothing, excludes a milestone, or names a closed one hides no
  // issue a phase could show: nothing is proposed, and no issue is touched.
  write();
  rmSync(wf);
  writeFileSync(join(s.tmp, 'issues-bare'), '7\n');
  rmSync(join(s.tmp, 'gh-calls'));
  for (const filter of [undefined, '-milestone:"Pilot"', 'milestone:"Closed one"', 'no:milestone']) {
    writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: [{ ...KANBAN[0], filter }] }));
    assert.doesNotMatch(s.cli(['doctor']).stdout, /issue phase|issues without a milestone/, String(filter));
    assert.doesNotMatch(s.cli(['init', '--mode', 'adopt', '--yes']).stdout, /give every new issue|set the milestone/, String(filter));
  }
  assert.doesNotMatch(s.calls(), /issue edit/);
  assert.ok(!existsSync(wf) && config().phase === undefined);
  // A phase with no open milestone behind it is never called done.
  writeFileSync(join(s.tmp, 'milestones'), '');
  write({ phase: 'Phase 9' });
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+issue phase\s+— phase is "Phase 9", which is not an open milestone$/m);
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\nLater\n');
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: filtered('Pilot', 'Later') }));
  write({ phase: 'Later' });

  // Issues that cannot be listed are unknown, never clean; phase: false goes without.
  writeFileSync(join(s.tmp, 'issues-denied'), '');
  assert.match(s.cli(['doctor']).stdout, /^could not check\s+issues without a milestone/m);
  write({ phase: false });
  assert.doesNotMatch(s.cli(['doctor']).stdout, /issue phase|issues without a milestone/);
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
  assert.match(made.stdout, /done\s+create a board view with Status columns, filtered to a milestone/);
  assert.match(made.stdout, /done\s+give every new issue the milestone "Phase 1\.0"/);
  assert.match(made.stdout, /done\s+set the milestone "Phase 1\.0" on the 1 open issue that has none \(#4\), so the board view shows it/);
  assert.equal(JSON.parse(readFileSync(join(s.repo, '.winston/config.json'), 'utf8')).phase, 'Phase 1.0');
  assert.match(s.calls(), /issue edit 4 --milestone Phase 1\.0\n/);
});

test('the phase workflow runs on a new issue and daily, needs no secret, and never changes a set milestone', () => {
  const text = readFileSync(join(ROOT, 'templates/set-issue-phase.yml'), 'utf8');
  assert.equal(firesOnNewIssue(text), true);
  assert.match(text, /schedule:\n\s+- cron:/);
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
  assert.match(none.stdout, /adopt needs an existing repository.*--mode new/);

  existingRepo(s);
  writeFileSync(join(s.tmp, 'linked.json'), linkedJson([['acme', 3, 'Roadmap'], ['acme', 4, 'Bugs']]));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  const asked = s.cli(['init', '--mode', 'adopt']);
  assert.match(asked.stdout, /--board acme\/3\s+Roadmap\n\s+--board acme\/4\s+Bugs\n\s+--board new/);
  assert.equal(s.cli(['init', '--mode', 'adopt', '--yes']).status, 2);
  assert.ok(!existsSync(join(s.repo, '.winston')));
  assert.match(s.cli(['init', '--mode', 'adopt', '--board', 'acme/4']).stdout, /board acme project 4/);
  rmSync(join(s.tmp, 'board.json'));
  const gone = s.cli(['init', '--mode', 'adopt', '--board', 'acme/99', '--yes']);
  assert.equal(gone.status, 1, 'a board this account cannot read is refused before anything is written');
  assert.match(gone.stderr, /--board acme\/99: no such project[^\n]*\nRun \/winston:doctor to see what is missing and how to fix it\.\n$/);
  assert.ok(!existsSync(join(s.repo, '.winston')));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  assert.match(s.cli(['init', '--mode', 'adopt', '--board', 'new']).stdout, /create a private GitHub Project "thing" under acme/);
});

test('init --mode join reports access as the joiner\'s, repo gaps as the owner\'s, and writes only the user layer', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  assert.equal(s.cli(['init', '--mode', 'join']).status, 1, 'no config: not a Winston repo');
  existingRepo(s);
  mkdirSync(join(s.repo, '.winston'));
  const repoConfig = JSON.stringify({ owner: 'Dana', branches: { integration: 'staging', production: 'main' }, board: { owner: 'acme', number: 1 }, phase: false });
  writeFileSync(join(s.repo, '.winston/config.json'), repoConfig);

  const plan = s.cli(['init', '--mode', 'join']);
  assert.match(plan.stdout, /Its setup is Dana's: nothing in the repo or on GitHub is changed/);
  assert.match(plan.stdout, /Yours to fix:\n\s+- board reachable: a project's access is separate from the repo's: ask Dana to add this account at https:\/\/github\.com\/users\/acme\/projects\/1\/settings\/access/);
  assert.match(plan.stdout, /They are Dana's to close[^]*- integration branch on origin[^]*- triage labels/);
  assert.match(plan.stdout, /would:\n\s+- set launcher\.repo/);
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
  assert.match(ready.stdout, /Ready: every required check passes/);
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
  assert.match(off.stdout, /^needs you\s+board auto-adds new issues\s+— the board's "Auto-add to project" workflow is off/m);
  assert.match(off.stdout, /^done\s+board sets Inbox on added items\s+— on; GitHub's API does not show which Status it sets$/m);
  assert.match(off.stdout, /^needs you\s+triage workflow secrets\s+— GH_PAT set, CLAUDE_CODE_OAUTH_TOKEN missing/m);
  assert.match(off.stdout, /\d\. triage workflow secrets\n   Why: [^\n]+\n   Fix:\n     Not set on acme\/thing: CLAUDE_CODE_OAUTH_TOKEN\.[^]*\n       1\. In your own terminal: claude setup-token/);
  assert.match(off.stdout, /\d\. board auto-adds new issues\n   Why: Without this a new issue never shows up on the board\.\n   Fix:\n     \/winston:init does this for you in the browser\. By hand: open https:\/\/github\.com\/users\/acme\/projects\/1\/workflows/);
  assert.equal(off.stdout.match(/board auto-adds new issues/g).length, 2, 'once in the checklist, once under Needs you');

  writeFileSync(join(s.tmp, 'board.json'), boardJson({ options: ['Inbox', 'Ready', 'Verify', 'Verified'], workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  const on = s.cli(['doctor']);
  assert.match(on.stdout, /^done\s+board auto-adds new issues$/m);
  assert.match(on.stdout, /^done\s+triage workflow secrets\s+— GH_PAT set, CLAUDE_CODE_OAUTH_TOKEN set$/m);
  assert.doesNotMatch(on.stdout, /\d\. (board auto-adds|board sets|triage workflow)/);
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
  assert.match(elsewhere.stdout, /^needs you\s+board auto-adds new issues\s+— the board's "Auto-add to project" workflow is off$/m);
  assert.match(elsewhere.stdout, /\d\. board auto-adds new issues\n/);
  // The automation's own event on this board is.
  writeFileSync(join(s.tmp, 'timeline.json'), timelineJson([[43, [['add', BOT, 'acme', 6]]], [44, [['add', BOT, 'acme', 6], ['status', BOT, 'acme', 6]]]]));
  const confirmed = s.cli(['doctor']);
  assert.match(confirmed.stdout, /^done\s+board auto-adds new issues\s+— on \(confirmed by issue #44's timeline\)$/m);
  assert.match(confirmed.stdout, /^done\s+board sets New on added items\s+— on; GitHub's API does not show which Status it sets$/m);
  assert.doesNotMatch(confirmed.stdout, /In the browser|\d\. board (auto-adds|sets)/, 'confirmed by the bot: no browser step, required or optional');

  // Control: a board whose API already says both are on (project 2 in #45) is unaffected,
  // and never asks the issue timeline at all.
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  rmSync(join(s.tmp, 'gh-calls'));
  const already = s.cli(['doctor']);
  assert.match(already.stdout, /^done\s+board auto-adds new issues$/m);
  assert.doesNotMatch(s.calls(), /timelineItems/, 'both workflows already read as on: the timeline is never consulted');

  // No issues at all yet: neither source can be trusted over the other, so doctor says so
  // rather than sending the owner to redo a step that may already be on.
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: ['Item added to project'], views: KANBAN }));
  rmSync(join(s.tmp, 'timeline.json'));
  const blind = s.cli(['doctor']);
  assert.match(blind.stdout, /^could not check {2}board auto-adds new issues\s+— could not check — file one test issue and rerun doctor$/m);
  assert.doesNotMatch(blind.stdout, /\d\. board auto-adds new issues/, 'not a required step: never counted as missing');
});

test('doctor says unknown, not missing, when it cannot list secrets, and flags a run of failed triage runs', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ board: { owner: 'acme', number: 1 } }));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  // No workflow in the repo: nothing about its secrets or runs.
  assert.doesNotMatch(s.cli(['doctor']).stdout, /triage workflow (secrets|runs)/);

  mkdirSync(join(s.repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(s.repo, '.github/workflows/triage-on-new-issue.yml'), '');
  // Newest first: one still running, three failures, then a success.
  writeFileSync(join(s.tmp, 'runs'), '\nfailure\nstartup_failure\nfailure\nsuccess\n');
  const failing = s.cli(['doctor']);
  assert.match(failing.stdout, /^needs you\s+triage workflow runs\s+— its last 3 runs failed$/m);
  assert.match(failing.stdout, /\d\. triage workflow runs\n   Why: Failed runs mean new issues are not being triaged, and nothing else reports it\.\n   Fix:\n     installed, but its last 3 runs failed\. See why: gh run list --workflow triage-on-new-issue\.yml --limit 1/);
  assert.match(s.calls(), /^run list --workflow triage-on-new-issue\.yml --limit 5 --json conclusion/m);

  writeFileSync(join(s.tmp, 'runs'), 'success\nfailure\nfailure\n');
  const fine = s.cli(['doctor']);
  assert.match(fine.stdout, /^done\s+triage workflow runs\s+— last run: success$/m);
  writeFileSync(join(s.tmp, 'runs'), 'cancelled\nsuccess\n');
  assert.match(s.cli(['doctor']).stdout, /^off\s+triage workflow runs\s+— last run: cancelled$/m);
  assert.doesNotMatch(fine.stdout, /\d\. triage workflow runs/);
  writeFileSync(join(s.tmp, 'runs'), '');
  assert.match(s.cli(['doctor']).stdout, /^off\s+triage workflow runs\s+— no finished runs yet$/m);

  // gh cannot list secrets (403) or runs: unknown, and not called a problem.
  writeFileSync(join(s.tmp, 'secrets-denied'), '');
  rmSync(join(s.tmp, 'runs'));
  const blind = s.cli(['doctor']);
  assert.match(blind.stdout, /^could not check\s+triage workflow secrets\s+— this account cannot list the repo's secrets$/m);
  assert.match(blind.stdout, /^could not check\s+triage workflow runs/m);
  assert.doesNotMatch(blind.stdout, /\d\. triage workflow|needs you\s+triage workflow|403/);
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
  assert.match(plan.stdout, /Secrets the triage workflow needs \(the owner's to do[^]*Not set on acme\/thing: GH_PAT\./);
  // The prefilled link first, then every field by name for when the link fills nothing in.
  assert.match(plan.stdout, /1\. Open this link while signed in to GitHub; it opens the form, and should tick the two scopes \(acme is a user account, and a fine-grained token cannot reach a user's projects, so this is a classic token\): https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo,project\n/);
  assert.match(plan.stdout, /2\. Check the form: Note is empty, so type a name[^\n]*"repo" and "project" must be ticked: tick them if the link did not[^\n]*\n\s+3\. If the form came up empty: [^\n]*Tokens \(classic\), "Generate new token \(classic\)"[^\n]*\n\s+4\. Click "Generate token" yourself and copy the token[^\n]*\n\s+5\. In your own terminal: gh secret set GH_PAT --repo acme\/thing /);
  assert.match(plan.stdout, /6\. gh workflow run triage-on-new-issue\.yml --repo acme\/thing -f issue=<[^\n]*\n\s+7\. gh run list --workflow triage-on-new-issue\.yml --repo acme\/thing --limit 1/);
  assert.doesNotMatch(plan.stdout, /claude setup-token/, 'a secret that exists is not walked through');
  assert.match(s.calls(), /^secret list --repo acme\/thing --json name/m);

  // After applying, the same step; an organization's board takes a fine-grained token.
  writeFileSync(join(s.tmp, 'owner-type'), 'Organization\n');
  writeFileSync(join(s.tmp, 'secrets'), '');
  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.match(made.stdout, /Not set on acme\/thing: GH_PAT, CLAUDE_CODE_OAUTH_TOKEN\./);
  assert.match(made.stdout, /1\. Open this link while signed in to GitHub; it fills in the form \(acme is an organization, so this is a fine-grained token\): https:\/\/github\.com\/settings\/personal-access-tokens\/new\?name=winston\+triage\+thing&description=[^ &]+&target_name=acme&expires_in=90&issues=write&organization_projects=write\n/);
  assert.match(made.stdout, /2\. Check the form: Token name \(filled in\), Resource owner acme, Expiration 90 days[^\n]*"Only select repositories" and pick acme\/thing; the link cannot fill that in[^\n]*"Issues: Read and write"[^\n]*"Projects: Read and write"\n\s+3\. If the form came up empty: [^\n]*Fine-grained tokens[^\n]*\n\s+4\. Click "Generate token" yourself/);
  assert.match(made.stdout, /6\. In your own terminal: claude setup-token[^\n]*\n\s+7\. In your own terminal: gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo acme\/thing /);

  // Set up already, secrets still missing: init says so rather than "Nothing to do".
  const again = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.match(again.stdout, /^Every required check passes\. Nothing was changed\. Safe to run again\.\n\nSecrets the triage workflow needs[^]*\n\nPermission rules \(the owner's to do, in one step\):\n[^]*Run it yourself, once: winston permissions --apply/);
  // A board under another owner than the repo, or an owner gh cannot look up: classic.
  const config = JSON.parse(readFileSync(join(s.repo, '.winston/config.json'), 'utf8'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ ...config, board: { ...config.board, owner: 'other-org' } }));
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /1\. Open this link[^\n]*\(the board is other-org's and the repository is not, and a fine-grained token covers one owner, so this is a classic token\): https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo,project\n/);
  writeFileSync(join(s.tmp, 'owner-type'), '');
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /1\. Open this link[^\n]*\(gh could not tell whether other-org is a user or an organization, so this is a classic token, which reaches the projects of either\): https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo,project\n/);

  // Secrets this account cannot list: check first, then both, never "missing".
  writeFileSync(join(s.tmp, 'secrets-denied'), '');
  const blind = s.cli(['init', '--mode', 'adopt']);
  assert.match(blind.stdout, /This account cannot list the secrets of acme\/thing, so see which exist first: gh secret list --repo acme\/thing\./);
  assert.doesNotMatch(blind.stdout, /Not set on/);
  rmSync(join(s.tmp, 'secrets-denied'));
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  assert.doesNotMatch(s.cli(['init', '--mode', 'adopt']).stdout, /Secrets the triage workflow needs|Nothing to do/);
  assert.equal(s.cli(['permissions', '--apply']).status, 0);
  const done = s.cli(['init', '--mode', 'adopt']);
  assert.match(done.stdout, /^Nothing to do: every required check passes\. Nothing was changed\. Safe to run again\.\n$/);
  assert.doesNotMatch(s.calls(), /^(secret set|workflow run|secret list(?!.*--json name))/m, 'winston lists secret names and nothing else');
});

test('the triage workflow template skips, rather than fails, without its secrets', () => {
  const yml = readFileSync(join(ROOT, 'templates/triage-on-new-issue.yml'), 'utf8');
  const steps = yml.slice(yml.indexOf('    steps:'));
  assert.match(steps, /id: secrets/);
  const gated = steps.split(/\n      - /).filter((step) => /^uses: /.test(step));
  assert.equal(gated.length, 2);
  for (const step of gated) assert.match(step, /if: steps\.secrets\.outputs\.ready == 'true'/);
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
  assert.match(old.stdout, /\d\. Winston version\n   Why: [^\n]+\n   Fix:\n     To update, follow the line for the app you use Winston in:\n       Claude Code: run `claude plugin marketplace update winston && claude plugin update winston@winston`, then restart Claude Code[^\n]*\n       Codex: run `codex plugin marketplace upgrade winston`, then `codex plugin add winston@winston`, and start a new Codex session\.\n     Winston never updates itself/);
  assert.doesNotMatch(s.calls(), /plugin update/, 'doctor never updates');
  assert.equal(s.cli(['doctor', '--fix']).status, 1, 'an unknown flag is refused');
  // GitHub is asked at most once a day: a new answer there is not seen until the cache ages out.
  writeFileSync(join(s.tmp, 'latest.json'), JSON.stringify({ version: have }));
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+Winston version\s+— .* installed, 99\.0\.0 available$/m);
  writeFileSync(cache, JSON.stringify({ ...JSON.parse(readFileSync(cache, 'utf8')), checkedAt: Date.now() - 25 * 60 * 60 * 1000 }));
  assert.match(s.cli(['doctor']).stdout, /^done\s+Winston version/m, 'a day later it asks again');
  assert.equal(old.status, unknown.status, 'an old Winston is reported, never a failed check');

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
  assert.match(doc.stdout, /^needs you\s+triage policy\s+— AGENTS\.md has no triage rules \(no heading that names triage, no risk: low\/medium\/high tier\): a triage pass under it changes nothing$/m);
  assert.match(doc.stdout, /\nNext step: triage policy – run: winston init --mode adopt\. Then run winston doctor again\.\n$/);
  const plan = s.cli(['init', '--mode', 'adopt']);
  assert.match(plan.stdout, /write .*TRIAGE\.md, a starter triage policy filled in from the config, and set triage\.policy to it in .*config\.json \(AGENTS\.md is left as it is\)\. Its three \(per-repo\) sections are generic/);
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
  assert.equal(readFileSync(join(s.repo, 'AGENTS.md'), 'utf8'), '# Rules\n');
  const after = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(after.triage, { policy: 'TRIAGE.md', workflow: 'triage-on-new-issue.yml' });
  assert.equal(after.owner, 'Dana', 'the rest of the config is kept');
  const ok = s.cli(['doctor']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^done\s+triage policy\s+— TRIAGE\.md$/m);

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
  assert.match(sparse.stdout, /\nValues to fill in \(the owner's to do\): .*TRIAGE\.md has \d+ lines that say "fill this in"[^\n]*\n  line \d+: [^\n]*fill this in: /);
  const flagged = s.cli(['doctor']);
  assert.match(flagged.stdout, new RegExp(`^needs you\\s+triage policy blanks\\s+— TRIAGE\\.md has ${policyBlanks(join(s.repo, 'TRIAGE.md')).length} lines still to fill in$`, 'm'));
  assert.match(flagged.stdout, /TRIAGE\.md has \d+ lines still to fill in \(open the file and replace each "fill this in" or \{\{placeholder\}\} with the real value\): line \d+: /);
  writeFileSync(join(s.repo, 'TRIAGE.md'), '# Triage\n\nOwner: {{owner}}\n');
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+triage policy blanks\s+— TRIAGE\.md has 1 line still to fill in$/m);
  writeFileSync(join(s.repo, 'TRIAGE.md'), '# Triage\n\nOwner: Dana\n');
  assert.doesNotMatch(s.cli(['doctor']).stdout, /triage policy blanks/);

  // A policy file that is not there at all.
  write('docs/POLICY.md');
  rmSync(join(s.repo, 'TRIAGE.md'));
  write('../outside.md');
  writeFileSync(join(s.tmp, 'outside.md'), '# Triage\n');
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+triage policy\s+— triage\.policy must be a file inside the repository/m);
  write('docs/POLICY.md');
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+triage policy\s+— docs\/POLICY\.md not found: \/winston:triage does not run without a policy$/m);

  // A TRIAGE.md with rules already in the repo is pointed at, not rewritten.
  writeFileSync(join(s.repo, 'TRIAGE.md'), '## Triage\n\nmine\n');
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /set triage\.policy to TRIAGE\.md, which has triage rules/);
  assert.equal(s.cli(['init', '--mode', 'adopt', '--yes']).status, 0);
  assert.equal(readFileSync(join(s.repo, 'TRIAGE.md'), 'utf8'), '## Triage\n\nmine\n');
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).triage.policy, 'TRIAGE.md');

  // An existing TRIAGE.md without rules is the owner's to fill in: never overwritten.
  writeFileSync(join(s.repo, 'TRIAGE.md'), 'notes to self\n');
  const kept = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.match(kept.stdout, /By hand:\n\s+- triage policy: .*TRIAGE\.md exists and has no triage rules, and Winston does not overwrite it/);
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
  assert.match(listed.stdout, /^Allow \(these stop prompting\):\n  missing  Bash\(git status\*\)$/m);
  assert.match(listed.stdout, /^  missing  Bash\(gh project item-list 2\*\)$/m);
  assert.match(listed.stdout, /^Deny \([^\n]*deny wins over allow\):\n  missing  Bash\(git push\*--force\*\)$/m);
  assert.match(listed.stdout, /^  missing  Bash\(git push\* main\)$/m);
  assert.match(listed.stdout, /\nThe deny list blocks every force push, --force-with-lease included\. To update a branch that is already pushed, merge its base branch into it and push normally; do not rebase it\.\n/);
  assert.match(listed.stdout, /winston permissions --apply\nAn allow rule only removes a prompt, and deny wins over allow: deny and ask rules, hooks, production approval and secret grants still apply\./);
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
  assert.match(s.cli(['doctor']).stdout, /^done\s+project permission rules/m);
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
  assert.match(s.cli(['doctor']).stdout, /^could not check\s+project permission rules\s+— .*settings\.json is not/m);
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
  mkdirSync(join(s.repo, '.claude'));
  writeFileSync(join(s.repo, '.claude/settings.json'), JSON.stringify({ permissions: { allow: allow.filter((r) => r !== 'Bash(gh pr comment *)'), deny: deny.slice(1) } }));
  assert.match(s.cli(['doctor']).stdout, /^needs you\s+project permission rules\s+— 1 allow and 1 deny rules Winston runs use are not in .*settings\.json: Bash\(gh pr comment \*\), Bash\(git push\*--force\*\) \(winston permissions --apply adds them\)$/m);
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
  for (const name of ['triage policy', 'triage workflow secrets', 'project permission rules']) {
    assert.match(first.stdout, new RegExp(`^needs you\\s+${name}`, 'm'), name);
    assert.match(first.stdout, new RegExp(`\\d\\. ${name}\\n   Why: [^\\n]+\\n   Fix:\\n     \\S`), name);
  }
  assert.match(first.stdout, /Needs you \(3\):/);
  assert.equal(lastLine(first.stdout), 'Next step: triage policy – run: winston init --mode adopt. Then run winston doctor again.');

  // Fix the policy: that item is done, a new one asks for the repo's own risk tiers.
  assert.equal(s.cli(['init', '--mode', 'adopt', '--yes']).status, 0);
  const second = s.cli(['doctor']);
  assert.match(second.stdout, /^done\s+triage policy\s+— TRIAGE\.md$/m);
  assert.match(second.stdout, /^needs you\s+triage risk tiers\s+— TRIAGE\.md still has the starter's example risk tiers$/m);
  assert.match(lastLine(second.stdout), /^Next step: triage risk tiers – follow the steps under 1 above\./);
  const policy = join(s.repo, 'TRIAGE.md');
  writeFileSync(policy, readFileSync(policy, 'utf8').replace('is docs, copy or tooling only — nothing a user runs behaves differently', 'touches only docs/'));
  assert.equal(second.status, 0, 'an example tier is flagged, not a failed setup');

  // Then the secrets, then the permission rules.
  // A missing secret: the next step is the link that fills in the token form.
  assert.equal(lastLine(s.cli(['doctor']).stdout), 'Next step: triage workflow secrets – open https://github.com/settings/tokens/new?scopes=repo,project and follow the steps under 1 above. Then run winston doctor again.');
  // With GH_PAT in place, it is the one command that makes the other token.
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\n');
  assert.equal(lastLine(s.cli(['doctor']).stdout), 'Next step: triage workflow secrets – run: claude setup-token. Then run winston doctor again.');
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  const third = s.cli(['doctor']);
  assert.match(third.stdout, /^done\s+triage workflow secrets/m);
  assert.equal(lastLine(third.stdout), 'Next step: project permission rules – run: winston permissions --apply. Then run winston doctor again.');
  assert.equal(s.cli(['permissions', '--apply']).status, 0);
  const complete = s.cli(['doctor']);
  assert.equal(complete.status, 0, complete.stdout);
  assert.doesNotMatch(complete.stdout, /^needs you/m);
  assert.match(lastLine(complete.stdout), /^Setup is complete: nothing needs you\./);
  assert.match(s.cli(['doctor', '--copy']).stdout, /\nNothing was copied: there is no next step\.\n/);

  // init on the finished repo changes nothing and says so.
  const before = s.git('status', '--porcelain');
  const again = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(again.stdout, 'Nothing to do: every required check passes. Nothing was changed. Safe to run again.\n');
  assert.equal(s.git('status', '--porcelain'), before);
});

test('doctor --copy puts the next step\'s command on the clipboard', { skip: process.platform !== 'darwin' }, (t) => {
  const s = sandbox(t);
  s.fake('gh', 'exit 1');
  s.fake('pbcopy', `cat > "${s.tmp}/clipboard"`);
  assert.match(lastLine(s.cli(['doctor', '--copy']).stdout), /^Next step: gh auth with project scope – run: gh auth login   \(copied to the clipboard\)\./);
  assert.equal(readFileSync(join(s.tmp, 'clipboard'), 'utf8'), 'gh auth login');
  rmSync(join(s.tmp, 'clipboard'));
  s.cli(['doctor']);
  assert.ok(!existsSync(join(s.tmp, 'clipboard')), 'only when asked');
  // When nothing reaches the clipboard it says so, and the next step is still the last line.
  s.fake('pbcopy', 'exit 1');
  const failed = s.cli(['doctor', '--copy']).stdout;
  assert.match(failed, /\nNothing was copied: pbcopy did not run\.\n/);
  assert.match(lastLine(failed), /^Next step: gh auth with project scope – run: gh auth login\. Then/);
});

test('every stop on a missing prerequisite points at /winston:doctor', (t) => {
  assert.equal(DOCTOR_POINTER, 'Run /winston:doctor to see what is missing and how to fix it.');
  const flat = (f) => readFileSync(join(ROOT, 'skills', f, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  for (const skill of ['codex', 'gemini', 'radar', 'rex', 'verdict', 'triage', 'winston']) assert.ok(flat(skill).includes(DOCTOR_POINTER.replace(/\s+/g, ' ')) || flat(skill).includes('Run /winston:doctor to see what is missing and how to fix it.'), skill);
  assert.equal(flat('triage').split('to see what is missing and how to fix it').length - 1, 2, 'no policy, and no board');

  const s = sandbox(t);
  s.fake('gh', 'exit 1');
  const noGh = s.cli(['init', '--mode', 'new']);
  assert.equal(noGh.status, 1);
  assert.match(noGh.stderr, /gh is not logged in\.[^\n]*\nRun \/winston:doctor to see what is missing and how to fix it\.\n$/);
  assert.match(s.cli(['init', '--mode', 'join']).stdout, /Run \/winston:doctor to see what is missing and how to fix it\.\n$/);
  assert.match(s.cli(['permissions'], s.tmp).stderr, /is not inside a git repository\nRun \/winston:doctor to see what is missing and how to fix it\.\n$/);
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
