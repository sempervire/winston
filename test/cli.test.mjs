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
  assert.match(doc.stdout, /^ok\s+claude on PATH/m);
  assert.match(doc.stdout, /^ok\s+gh auth with project scope/m);
  assert.match(doc.stdout, /^missing\s+repo config/m);
  assert.match(doc.stdout, /^missing\s+triage labels\s+— missing: risk: low/m);
  assert.match(doc.stdout, /^missing\s+triage-on-new-issue workflow/m);
  assert.match(doc.stdout, /^(on|off)\s+codex CLI/m);
  assert.match(doc.stdout, /Not set up for Winston here\. winston init asks which setup fits: join, new or adopt\.\n$/);
});

test('doctor finds a missing kanban view and starting milestone; init creates them', (t) => {
  const s = sandbox(t);
  mkdirSync(join(s.repo, '.winston'));
  writeFileSync(join(s.repo, '.winston/config.json'), JSON.stringify({ board: { owner: 'acme', number: 1 } }));
  const board = {
    data: { repositoryOwner: { projectV2: {
      id: 'PROJECT1', title: 'Acme board',
      fields: { nodes: [
        { name: 'Status', options: [{ name: 'New' }, { name: 'Ready' }, { name: 'Verify' }, { name: 'Verified' }] },
        { name: 'Priority' },
      ] },
      views: { nodes: [] },
    } } } };
  writeFileSync(join(s.tmp, 'board.json'), JSON.stringify(board));
  s.fake('gh', `case "$1 $2" in
    "auth status") echo "project, repo";;
    "label list") printf "risk: low\\nrisk: medium\\nrisk: high\\nauto-merge\\nauto-verify\\nhuman-verify\\n";;
    "label create") exit 0;;
    "api graphql") case "$*" in
      *createProjectV2View*) echo "$*" >> "${s.tmp}/view-create-calls"; echo '{"data":{"createProjectV2View":{"view":{"id":"VIEW1"}}}}';;
      *updateProjectV2View*) echo "$*" >> "${s.tmp}/view-filter-calls"; echo '{"data":{"updateProjectV2View":{"view":{"id":"VIEW1"}}}}';;
      *) cat "${s.tmp}/board.json";;
      esac;;
    "api --method") cat "${s.tmp}/milestones" 2>/dev/null; true;;
    "api repos/{owner}/{repo}/milestones") echo "$*" >> "${s.tmp}/milestone-create-calls"; echo "Phase 1.0" >> "${s.tmp}/milestones";;
    *) exit 1;;
  esac`);

  const doc = s.cli(['doctor']);
  assert.match(doc.stdout, /^ok\s+board reachable/m);
  assert.match(doc.stdout, /^missing\s+board kanban view\s+— no BOARD_LAYOUT view grouped by Status/m);
  assert.match(doc.stdout, /^missing\s+starting milestone\s+— no open milestone/m);
  // Neither new check needs the owner's input, so init can create both on its own.
    assert.match(doc.stdout, /Fix: winston init/);

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout);
  assert.match(made.stdout, /done\s+create milestone "Phase 1\.0" on the repo/);
  assert.match(made.stdout, /done\s+create a BOARD_LAYOUT view on the board, filtered to a milestone/);
  assert.equal(readFileSync(join(s.tmp, 'milestone-create-calls'), 'utf8').trim().split('\n').length, 1, 'the milestone is created exactly once, not once per check');
  assert.match(readFileSync(join(s.tmp, 'view-filter-calls'), 'utf8'), /filter=milestone:"Phase 1\.0"/);
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
        { name: 'Status', options: [{ name: 'New' }, { name: 'Ready' }, { name: 'Verify' }, { name: 'Verified' }] },
        { name: 'Priority' },
      ] },
      views: { nodes: [] },
    } } } };
  writeFileSync(join(s.tmp, 'board.json'), JSON.stringify(board));
  s.fake('gh', `case "$1 $2" in
    "auth status") echo "project, repo";;
    "label list") printf "risk: low\\nrisk: medium\\nrisk: high\\nauto-merge\\nauto-verify\\nhuman-verify\\n";;
    "label create") exit 0;;
    "api graphql") case "$*" in
      *createProjectV2View*) echo "$*" >> "${s.tmp}/view-create-calls"; echo '{"data":{"createProjectV2View":{"view":{"id":"VIEW1"}}}}';;
      *updateProjectV2View*) echo "$*" >> "${s.tmp}/view-filter-calls"; echo '{"data":{"updateProjectV2View":{"view":{"id":"VIEW1"}}}}';;
      *) cat "${s.tmp}/board.json";;
      esac;;
    "api --method") cat "${s.tmp}/milestones" 2>/dev/null; true;;
    "api repos/{owner}/{repo}/milestones") echo "$*" >> "${s.tmp}/milestone-create-calls"; echo "Phase 1.0" >> "${s.tmp}/milestones";;
    *) exit 1;;
  esac`);

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout);
  assert.match(readFileSync(join(s.tmp, 'view-filter-calls'), 'utf8'), /filter=milestone:"Pilot"/);
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
    "api users/"*) echo "User";;
    "repo view") echo "acme/thing";;
    "repo create") git init -q --bare "${s.tmp}/origin.git" && git -C "${s.repo}" remote add origin "${s.tmp}/origin.git" && git -C "${s.repo}" push -q origin HEAD;;
    "project create") echo '{"number":7,"id":"P7"}'; cp "${s.tmp}/new-board.json" "${s.tmp}/board.json";;
    "project field-create"|"project link") ;;
    "label list") cat "${s.tmp}/labels" 2>/dev/null; true;;
    "label create") echo "$3" >> "${s.tmp}/labels";;
    "secret list") cat "${s.tmp}/secrets" 2>/dev/null; true;;
    "api graphql") case "$*" in
      *createProjectV2View*) echo '{"data":{"createProjectV2View":{"view":{"id":"VIEW1"}}}}';;
      *updateProjectV2View*) echo '{}';;
      *updateProjectV2Field*) echo '{}'; if [ -f "${s.tmp}/board-after.json" ]; then cp "${s.tmp}/board-after.json" "${s.tmp}/board.json"; fi;;
      *projectsV2*) cat "${s.tmp}/linked.json";;
      *) cat "${s.tmp}/board.json" 2>/dev/null || exit 1;;
      esac;;
    "api --method") cat "${s.tmp}/milestones" 2>/dev/null; true;;
    "api repos/{owner}/{repo}/milestones") echo "Phase 1.0" >> "${s.tmp}/milestones";;
    *) exit 1;;
  esac`);
  s.fake('claude', 'exit 0');
  s.calls = () => (existsSync(join(s.tmp, 'gh-calls')) ? readFileSync(join(s.tmp, 'gh-calls'), 'utf8') : '');
  s.git = (...args) => execFileSync('git', ['-C', s.repo, ...args], { env: s.env, encoding: 'utf8' }).trim();
}

const boardJson = ({ options = ['New', 'Ready', 'Verify', 'Verified'], priority = true, workflows = [], views = [] } = {}) => JSON.stringify({
  data: { repositoryOwner: { projectV2: {
    id: 'PROJECT1', title: 'Acme board',
    fields: { nodes: [
      { id: 'STATUS1', name: 'Status', options: options.map((name, i) => ({ id: `opt${i}`, name, color: 'GRAY', description: '' })) },
      ...(priority ? [{ id: 'PRIO1', name: 'Priority' }] : []),
    ] },
    workflows: { nodes: workflows.map((name) => ({ name, enabled: true })) },
    views: { nodes: views },
  } } } });
const KANBAN = [{ layout: 'BOARD_LAYOUT', groupByFields: { nodes: [{ name: 'Status' }] } }];
const INTAKE = ['Auto-add to project', 'Item added to project'];
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
  writeFileSync(join(s.tmp, 'board-after.json'), boardJson({ options: ['New', 'Ready', 'Verify', 'Verified', 'Done'], workflows: ['Item added to project'] }));
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
  assert.match(calls, /updateProjectV2Field[^\n]*\{id:"opt0",name:"New",color:GRAY[^\n]*name:"Verified",color:GREEN[^\n]*id:"opt2",name:"Done"/, 'Todo is renamed in place so the board\'s own workflow sets New');
  assert.doesNotMatch(calls, /In Progress/);
  assert.equal(calls.match(/updateProjectV2Field/g).length, 1);
  assert.match(calls, /project field-create 7 --owner pat --name Priority/);
  assert.match(calls, /project link 7 --owner pat --repo repo$/m);
  assert.ok(calls.indexOf('project create') < calls.indexOf('repo create') && calls.indexOf('repo create') < calls.indexOf('project link'));
  assert.match(readFileSync(join(s.tmp, 'labels'), 'utf8'), /^risk: high$/m);
  assert.match(made.stdout, /done\s+create a BOARD_LAYOUT view/);
  assert.match(made.stdout, /In the browser[^]*open https:\/\/github\.com\/users\/pat\/projects\/7\/workflows, choose "Auto-add to project", click Edit, pick this repository and set the filter to is:issue/);
});

test('init --mode adopt fits the config to the repo and adds to its board without replacing anything', (t) => {
  const s = sandbox(t);
  fakeGh(s);
  existingRepo(s);
  writeFileSync(join(s.tmp, 'linked.json'), linkedJson([['acme', 3, 'Roadmap']]));
  writeFileSync(join(s.tmp, 'board.json'), boardJson({ options: ['Todo', 'Ready'], priority: false, workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'milestones'), 'Pilot\n');

  const plan = s.cli(['init', '--mode', 'adopt']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /production main, integration staging, board acme project 3, process docs AGENTS\.md/);
  assert.match(plan.stdout, /add Status options to the board: New, Verify, Verified \(its existing options are kept\)/);
  assert.match(plan.stdout, /add a single-select Priority field/);
  assert.match(plan.stdout, /Note: Commit .*config\.json and .*triage-on-new-issue\.yml to main/);
  assert.match(plan.stdout, /Note: There is no TRIAGE\.md/);
  assert.doesNotMatch(plan.stdout, /In the browser|By hand/, 'both intake workflows are on');
  assert.ok(!existsSync(join(s.repo, '.winston')));

  const made = s.cli(['init', '--mode', 'adopt', '--yes']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const config = JSON.parse(readFileSync(join(s.repo, '.winston/config.json'), 'utf8'));
  assert.deepEqual(config.board, { owner: 'acme', number: 3, statuses: ['New', 'Ready', 'Verify', 'Verified'], priorityField: 'Priority' });
  assert.deepEqual(config.processDocs, ['AGENTS.md']);
  assert.deepEqual(originHeads(s), ['main', 'staging']);
  const calls = s.calls();
  assert.doesNotMatch(calls, /project create|repo create/);
  assert.match(calls, /updateProjectV2Field[^\n]*id:"opt0",name:"Todo"[^\n]*id:"opt1",name:"Ready"[^\n]*\{name:"New",color:GRAY/, 'existing options are passed back with their ids');
  assert.match(calls, /project field-create 3 --owner acme --name Priority/);
  assert.equal(s.git('rev-list', '--count', 'HEAD'), '1', 'an existing repo is not committed to');

  // An existing staging-like branch is used, not a new one made.
  rmSync(join(s.repo, '.winston'), { recursive: true });
  s.git('push', '-q', 'origin', 'main:develop');
  assert.match(s.cli(['init', '--mode', 'adopt']).stdout, /integration staging/, 'staging exists now and wins');
  assert.match(s.cli(['init', '--mode', 'adopt', '--integration', 'develop']).stdout, /integration develop/);
  assert.doesNotMatch(s.cli(['init', '--mode', 'adopt', '--integration', 'develop']).stdout, /create branch/);
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
  assert.match(gone.stderr, /--board acme\/99: no such project/);
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
  const repoConfig = JSON.stringify({ owner: 'Dana', branches: { integration: 'staging', production: 'main' }, board: { owner: 'acme', number: 1 } });
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
  const off = s.cli(['doctor']);
  assert.equal(off.status, 1);
  assert.match(off.stdout, /^missing\s+board auto-adds new issues\s+— the board's "Auto-add to project" workflow is off/m);
  assert.match(off.stdout, /^ok\s+board sets Inbox on added items\s+— on; GitHub's API does not show which Status it sets$/m);
  assert.match(off.stdout, /^off\s+triage workflow secrets\s+— not set: CLAUDE_CODE_OAUTH_TOKEN/m);
  assert.match(off.stdout, /In the browser \(GitHub has no API for these[^\n]*\n\s+- board auto-adds new issues: open https:\/\/github\.com\/users\/acme\/projects\/1\/workflows/);
  assert.doesNotMatch(off.stdout, /By hand/, 'browser steps are not listed twice');

  writeFileSync(join(s.tmp, 'board.json'), boardJson({ options: ['Inbox', 'Ready', 'Verify', 'Verified'], workflows: INTAKE, views: KANBAN }));
  writeFileSync(join(s.tmp, 'secrets'), 'GH_PAT\nCLAUDE_CODE_OAUTH_TOKEN\n');
  const on = s.cli(['doctor']);
  assert.match(on.stdout, /^ok\s+board auto-adds new issues$/m);
  assert.match(on.stdout, /^on\s+triage workflow secrets/m);
  assert.doesNotMatch(on.stdout, /In the browser|By hand/);
});

test('the triage workflow template skips, rather than fails, without its secrets', () => {
  const yml = readFileSync(join(ROOT, 'templates/triage-on-new-issue.yml'), 'utf8');
  const steps = yml.slice(yml.indexOf('    steps:'));
  assert.match(steps, /id: secrets/);
  const gated = steps.split(/\n      - /).filter((step) => /^uses: /.test(step));
  assert.equal(gated.length, 2);
  for (const step of gated) assert.match(step, /if: steps\.secrets\.outputs\.ready == 'true'/);
});
