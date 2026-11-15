// Doctor's chattr rows against fixture homes: what makes chattr's hooks run twice, the exact removal
// step for each, the Codex sandbox root, the guard switch and the Node version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chattrChecks, mainCheckout, nodeMajor, worktreeMain, writableRoots } from '../lib/chattr-checks.mjs';
import { compose } from '../chattr/hook/install.mjs';
import { loadLayers } from '../lib/config.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function fixture(t) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'winston-chattr-checks-')));
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, WINSTON_HOME: process.env.WINSTON_HOME };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(tmp, { recursive: true, force: true });
  });
  const home = join(tmp, 'home');
  mkdirSync(home);
  process.env.HOME = home;
  process.env.WINSTON_HOME = join(home, '.winston');
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  const write = (rel, text) => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), text); };
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const rows = (node = { major: 24, version: 'v24.22.3' }) => Object.fromEntries(chattrChecks({ root: ROOT, layers: loadLayers(repo), node }).map((c) => [c.name, c]));
  return { tmp, home, repo, write, rows };
}

test('writableRoots reads the sandbox table only', () => {
  assert.deepEqual(writableRoots('[sandbox_workspace_write]\nwritable_roots = ["/a", "/h/.agent-bridge"]\n[x]\nwritable_roots = ["/no"]\n'), ['/a', '/h/.agent-bridge']);
  assert.deepEqual(writableRoots('writable_roots = ["/top"]\n[sandbox_workspace_write]\nnetwork_access = true\n'), []);
  assert.deepEqual(writableRoots(null), []);
  assert.deepEqual(writableRoots('[sandbox_workspace_write]\nwritable_roots = [\n  "/a",  # first\n  "~/.agent-bridge",\n]\n[x]\n'), ['/a', '~/.agent-bridge']);
});

test('nodeMajor reads `node --version`; a missing node is null', () => {
  assert.deepEqual(nodeMajor(() => ({ status: 0, stdout: 'v24.1.0\n' })), { major: 24, version: 'v24.1.0' });
  assert.equal(nodeMajor(() => ({ status: null, stdout: '' })), null);
});

test('a clean machine: every chattr row done, the guard on, nothing for Codex when it is not set up', (t) => {
  const f = fixture(t);
  const r = f.rows();
  for (const name of ['Node.js version', 'separate chattr plugin', 'old chattr install.sh hooks', 'stray chattr command']) assert.equal(r[name].state, 'ok', name);
  assert.equal(r['Codex can write the chattr store'], undefined);
  assert.equal(r['chattr plugin left enabled'], undefined);
  assert.equal(r['shared-checkout guard'].state, 'on');
  assert.match(r['shared-checkout guard'].detail, /"sharedCheckoutGuard": false in \.winston\/config\.json/);
  assert.equal(f.rows({ major: 22, version: 'v22.9.0' })['Node.js version'].state, 'missing');
  assert.equal(f.rows(null)['Node.js version'].detail, 'node is not on PATH');
});

test('the separate plugin in either app gives the exact uninstall command for each', (t) => {
  const f = fixture(t);
  f.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'winston@winston': true, 'chattr@winston': true } }));
  mkdirSync(join(f.home, '.claude/plugins/cache/winston/chattr'), { recursive: true });
  let c = f.rows()['separate chattr plugin'];
  assert.equal(c.state, 'off');
  assert.equal(c.command, 'claude plugin uninstall chattr@winston');
  f.write('.codex/config.toml', '[plugins."chattr@winston"]\nenabled = true\n');
  assert.equal(f.rows()['separate chattr plugin'].command, 'claude plugin uninstall chattr@winston', 'Codex entry without its files: nothing to remove there');
  mkdirSync(join(f.home, '.codex/plugins/cache/winston/chattr'), { recursive: true });
  c = f.rows()['separate chattr plugin'];
  assert.equal(c.command, 'claude plugin uninstall chattr@winston && codex plugin remove chattr@winston');
  assert.match(c.fixLines.join('\n'), /Codex: codex plugin remove chattr@winston {3}\(if that fails, delete the "chattr@winston" entry[^\n]*\n.*restart every Claude Code and Codex session/);
  f.write('.claude/settings.json', '{}');
  f.write('.codex/config.toml', '[plugins."chattr@winston"]\nenabled = false\n');
  assert.equal(f.rows()['separate chattr plugin'].state, 'ok');
});

test('a plugin left enabled after its files are gone is its own needs-you, with the command and the by-hand edit', (t) => {
  const f = fixture(t);
  f.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  f.write('.codex/config.toml', 'plugins."chattr@winston".enabled = true\n');
  const r = f.rows();
  assert.equal(r['separate chattr plugin'].state, 'ok', 'nothing on disk stands Winston down');
  const c = r['chattr plugin left enabled'];
  assert.equal(c.state, 'off');
  assert.equal(c.command, 'claude plugin uninstall chattr@winston && codex plugin remove chattr@winston');
  assert.match(c.fixLines.join('\n'), /delete the line "chattr@winston": true under enabledPlugins in ~\/\.claude\/settings\.json/);
  assert.match(c.fixLines.join('\n'), /delete the "chattr@winston" entry from ~\/\.codex\/config\.toml: its \[plugins\."chattr@winston"\] table, or the line that names it/);
  mkdirSync(join(f.home, '.claude/plugins/cache/winston/chattr'), { recursive: true });
  assert.equal(f.rows()['separate chattr plugin'].command, 'claude plugin uninstall chattr@winston');
  assert.match(f.rows()['chattr plugin left enabled'].command, /^codex plugin remove chattr@winston$/);
});

test('old install.sh hooks: dry run first, then uninstall-hooks with a snapshot, through Winston\'s own chattr', (t) => {
  const f = fixture(t);
  f.write('.codex/hooks.json', JSON.stringify(compose({}, 'codex', '/old/chattr')));
  const c = f.rows()['old chattr install.sh hooks'];
  assert.equal(c.state, 'off');
  assert.match(c.detail, /~\/\.codex\/hooks\.json/);
  assert.equal(c.command, `node "${ROOT}/chattr/chattr.mjs" uninstall-hooks --snapshot ~/chattr-hooks-backup`);
  assert.match(c.fixLines.join('\n'), /uninstall-hooks --dry-run/);
  // The command it gives really removes them, and nothing else.
  const run = spawnSync(process.execPath, [join(ROOT, 'chattr/chattr.mjs'), 'uninstall-hooks', '--snapshot', join(f.tmp, 'snap')], { env: { ...process.env, HOME: f.home }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(f.rows()['old chattr install.sh hooks'].state, 'ok');
});

test('uninstall-hooks honours CLAUDE_CONFIG_DIR and CODEX_HOME, as doctor\'s detection does', (t) => {
  const f = fixture(t);
  const claude = join(f.tmp, 'claude-alt');
  const codex = join(f.tmp, 'codex-alt');
  mkdirSync(claude);
  mkdirSync(codex);
  writeFileSync(join(claude, 'settings.json'), JSON.stringify(compose({}, 'claude', '/old/chattr')));
  writeFileSync(join(codex, 'hooks.json'), JSON.stringify(compose({}, 'codex', '/old/chattr')));
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.CODEX_HOME = codex;
  assert.match(f.rows()['old chattr install.sh hooks'].detail, /claude-alt\/settings\.json and .*codex-alt\/hooks\.json/);
  const run = spawnSync(process.execPath, [join(ROOT, 'chattr/chattr.mjs'), 'uninstall-hooks', '--snapshot', join(f.tmp, 'snap')], { env: { ...process.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /removed chattr hook registrations from 2 file/);
  assert.equal(f.rows()['old chattr install.sh hooks'].state, 'ok');
});

test('a ~/.local/bin/chattr link: a separate copy needs removing; one to this Winston does not', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.local/bin'), { recursive: true });
  symlinkSync('/Users/x/Developer/chattr/chattr.mjs', join(f.home, '.local/bin/chattr'));
  const c = f.rows()['stray chattr command'];
  assert.equal(c.state, 'off');
  assert.equal(c.command, 'rm ~/.local/bin/chattr');
  assert.match(c.detail, /runs \/Users\/x\/Developer\/chattr\/chattr\.mjs, a separate copy/);
  rmSync(join(f.home, '.local/bin/chattr'));
  symlinkSync(join(ROOT, 'bin/chattr'), join(f.home, '.local/bin/chattr'));
  assert.equal(f.rows()['stray chattr command'].state, 'ok');
});

test('Codex set up: the store must be a writable root, tilde or absolute', (t) => {
  const f = fixture(t);
  f.write('.codex/config.toml', 'model = "x"\n');
  const c = f.rows()['Codex can write the chattr store'];
  assert.equal(c.state, 'off');
  assert.match(c.fixLines.join('\n'), new RegExp(`writable_roots = \\["${f.home}/\\.agent-bridge"\\]`));
  f.write('.codex/config.toml', `[sandbox_workspace_write]\nwritable_roots = ["/a", "${f.home}/.agent-bridge"]\n`);
  assert.equal(f.rows()['Codex can write the chattr store'].state, 'ok');
  f.write('.codex/config.toml', '[sandbox_workspace_write]\nwritable_roots = ["~/.agent-bridge"]\n');
  assert.equal(f.rows()['Codex can write the chattr store'].state, 'ok');
});

test('the guard row names the layer that turned it off', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo, '.winston'));
  writeFileSync(join(f.repo, '.winston/config.json'), JSON.stringify({ sharedCheckoutGuard: false }));
  const c = f.rows()['shared-checkout guard'];
  assert.equal(c.state, 'off');
  assert.match(c.detail, /turned off in .*repo\/\.winston\/config\.json/);
  writeFileSync(join(f.repo, '.winston/config.json'), JSON.stringify({ sharedCheckoutGuard: true }));
  f.write('.winston/config.json', JSON.stringify({ sharedCheckoutGuard: false }));
  assert.equal(f.rows()['shared-checkout guard'].state, 'on', 'the repo layer wins');
});

test('mainCheckout groups Claude and plain worktrees under their main checkout', () => {
  assert.equal(mainCheckout('/d/ShareView/.claude/worktrees/claude-1'), '/d/ShareView');
  assert.equal(mainCheckout('/d/app/.worktrees/lane'), '/d/app');
  assert.equal(mainCheckout('/d/app'), '/d/app');
});

test('project-scope installs: one row, one committed change in the main checkout, never edits fanned out across worktrees', (t) => {
  const f = fixture(t);
  const other = join(f.tmp, 'Other');
  const files = join(f.tmp, 'cache-chattr');
  mkdirSync(files);
  mkdirSync(join(other, '.claude/worktrees/w1'), { recursive: true });
  writeFileSync(join(other, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  const entries = [other, join(other, '.claude/worktrees/w1'), join(other, '.claude/worktrees/gone')].map((projectPath) => ({ scope: 'project', projectPath, installPath: files }));
  entries.push({ scope: 'project', projectPath: f.repo, installPath: files });
  f.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'chattr@winston': entries } }));
  const c = f.rows()['chattr plugin installed in repositories'];
  assert.equal(c.state, 'off');
  assert.equal(c.command, undefined, 'a change for the repository owner, not one command');
  const text = c.fixLines.join('\n');
  assert.match(c.detail, /turned on in .*Other$/);
  assert.match(text, /Other {2}\(install records for 2 of its worktrees, 1 still on disk\)/);
  assert.match(text, /One change, by whoever owns that repository: in .*Other\/\.claude\/settings\.json, delete the line "chattr@winston": true under enabledPlugins \(if it is there\), and commit it\./);
  assert.match(text, /does the same edit to that committed file/);
  assert.match(text, /Change nothing in the worktrees\. Each picks the change up when it next merges or pulls/);
  assert.doesNotMatch(text, /worktree list|while read/, 'no loop over worktrees');
  assert.doesNotMatch(text, /repo {2}\(/, 'this checkout is the separate-plugin row\'s business');

  // Once the committed setting is gone the records are leftovers: listed, not a needs-you.
  writeFileSync(join(other, '.claude/settings.json'), JSON.stringify({ enabledPlugins: {} }));
  const after = f.rows()['chattr plugin installed in repositories'];
  assert.equal(after.problem, false);
  assert.match(after.detail, /3 leftover install records, harmless/);
});

test('doctor inside a repository still lists that repository\'s worktree records', (t) => {
  const f = fixture(t);
  const files = join(f.tmp, 'cache-chattr');
  mkdirSync(files);
  mkdirSync(join(f.repo, '.claude'));
  writeFileSync(join(f.repo, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  f.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'chattr@winston': [
    { scope: 'project', projectPath: f.repo, installPath: files },
    { scope: 'project', projectPath: join(f.repo, '.claude/worktrees/lane'), installPath: files },
  ] } }));
  const r = f.rows();
  assert.match(r['separate chattr plugin'].fixLines.join('\n'), /"-s project" also deletes the line from .*repo\/\.claude\/settings\.json, a committed file: commit that change\./);
  assert.match(r['chattr plugin installed in repositories'].fixLines.join('\n'), /repo {2}\(install records for 1 of its worktrees, 0 still on disk\)/);
});

test('this repository\'s project-scope install is the separate-plugin row, with -s project and the by-hand fallback', (t) => {
  const f = fixture(t);
  const files = join(f.tmp, 'cache-chattr');
  mkdirSync(files);
  f.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'chattr@winston': [{ scope: 'project', projectPath: f.repo, installPath: files }] } }));
  mkdirSync(join(f.repo, '.claude'));
  writeFileSync(join(f.repo, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  const c = f.rows()['separate chattr plugin'];
  assert.equal(c.state, 'off');
  assert.match(c.command, /^cd .*repo && claude plugin uninstall chattr@winston -s project$/);
  assert.match(c.fixLines.join('\n'), /if that fails, delete the line "chattr@winston": true under enabledPlugins in .*repo\/\.claude\/settings\.json \(a committed file/);
});

test('installed for the user but turned off: flagged, since turning it on would switch Winston\'s copy off', (t) => {
  const f = fixture(t);
  const files = join(f.tmp, 'cache-chattr');
  mkdirSync(files);
  f.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'chattr@winston': [{ scope: 'user', installPath: files }] } }));
  f.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': false } }));
  const r = f.rows();
  assert.equal(r['separate chattr plugin'].state, 'ok');
  assert.equal(r['chattr plugin installed but off'].command, 'claude plugin uninstall chattr@winston');
});

test('a project install turned on in user settings still gets -s project; stale records elsewhere are not reported', (t) => {
  const f = fixture(t);
  const files = join(f.tmp, 'cache-chattr');
  mkdirSync(files);
  const elsewhere = join(f.tmp, 'Elsewhere');
  mkdirSync(elsewhere);
  f.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'chattr@winston': [
    { scope: 'project', projectPath: f.repo, installPath: files },
    { scope: 'project', projectPath: elsewhere, installPath: join(f.tmp, 'gone') },
  ] } }));
  f.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  assert.match(f.rows()['separate chattr plugin'].command, /^cd .*repo && claude plugin uninstall chattr@winston -s project$/);
  assert.equal(f.rows()['chattr plugin installed in repositories'], undefined);
});

test('records are leftovers only when no layer turns the plugin on: user settings and worktree settings count', (t) => {
  const f = fixture(t);
  const other = join(f.tmp, 'Other');
  const wt = join(other, '.claude/worktrees/w1');
  const files = join(f.tmp, 'cache-chattr');
  mkdirSync(files);
  mkdirSync(join(wt, '.claude'), { recursive: true });
  f.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'chattr@winston': [other, wt].map((projectPath) => ({ scope: 'project', projectPath, installPath: files })) } }));
  assert.match(f.rows()['chattr plugin installed in repositories'].detail, /leftover/);

  writeFileSync(join(wt, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  let c = f.rows()['chattr plugin installed in repositories'];
  assert.match(c.detail, /turned on in .*Other$/);
  assert.match(c.fixLines.join('\n'), /One worktree still has the line in its committed \.claude\/settings\.json/);

  rmSync(join(wt, '.claude/settings.json'));
  f.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  c = f.rows()['chattr plugin installed in repositories'];
  assert.match(c.detail, /turned on in/);
  assert.match(c.fixLines.join('\n'), /Your user settings \(~\/\.claude\/settings\.json\) turn it on/);
});

test('inside a worktree whose committed settings turn chattr on, no -s project command: point at the main checkout', (t) => {
  const f = fixture(t);
  const git = (...a) => execFileSync('git', ['-C', f.repo, ...a], { stdio: 'ignore' });
  mkdirSync(join(f.repo, '.claude'));
  writeFileSync(join(f.repo, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'on');
  const wt = join(f.repo, '.claude/worktrees/lane');
  git('worktree', 'add', '-q', wt, '-b', 'lane');
  assert.equal(worktreeMain(wt), f.repo);
  assert.equal(worktreeMain(f.repo), null);
  const files = join(f.tmp, 'cache-chattr');
  mkdirSync(files);
  f.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'chattr@winston': [{ scope: 'project', projectPath: wt, installPath: files }] } }));
  const rowsAt = (dir) => Object.fromEntries(chattrChecks({ root: ROOT, layers: loadLayers(dir), node: { major: 24, version: 'v24' } }).map((c) => [c.name, c]));

  let c = rowsAt(wt)['separate chattr plugin'];
  assert.equal(c.state, 'off');
  assert.equal(c.command, undefined, 'nothing paste-ready that would rewrite the worktree\'s tracked file');
  const text = c.fixLines.join('\n');
  assert.doesNotMatch(text, /cd [^\n]*lane && claude plugin uninstall/);
  assert.match(text, /this is a worktree of .*repo, and its committed \.claude\/settings\.json turns chattr@winston on\. Run nothing for it here/);

  // After the worktree merges the main checkout's change, the command only clears its record.
  writeFileSync(join(wt, '.claude/settings.json'), JSON.stringify({ enabledPlugins: {} }));
  f.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  c = rowsAt(wt)['separate chattr plugin'];
  assert.match(c.command, /^cd .*lane && claude plugin uninstall chattr@winston -s project$/);
  assert.doesNotMatch(c.fixLines.join('\n'), /Run nothing for it here|a committed file: commit that change/);
});
