// Winston's bundled chattr hooks stand down while a separate chattr would run the same hooks,
// and the shared-checkout guard has an off switch in .winston/config.json. Temp HOMEs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexPluginsEnabled, kindOf, pluginPresent, standDownReason } from '../standdown.mjs';
import { compose } from '../install.mjs';
import { open } from '../../chattr.mjs';

const CHATTR = fileURLToPath(new URL('../../chattr.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('../../hooks/worktree-guard.mjs', import.meta.url));
const SESSION_START = fileURLToPath(new URL('../../hooks/worktree-session-start.mjs', import.meta.url));

function home(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'chattr-standdown-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.claude'));
  mkdirSync(path.join(dir, '.codex'));
  // The separate plugin's files, as an install leaves them; a test removes them to model a delisted plugin.
  mkdirSync(path.join(dir, '.codex', 'plugins', 'cache', 'winston', 'chattr'), { recursive: true });
  mkdirSync(path.join(dir, '.claude', 'plugins', 'cache', 'winston', 'chattr'), { recursive: true });
  const env = { HOME: dir, PATH: process.env.PATH, WINSTON_HOME: path.join(dir, '.winston'), CHATTR_DB: path.join(dir, 'bridge.db') };
  const write = (rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
  return { dir, env, write };
}

test('codexPluginsEnabled reads [plugins."chattr@…"] tables and honours enabled = false', () => {
  assert.deepEqual(codexPluginsEnabled('[plugins."winston@winston"]\nenabled = true\n\n[plugins."chattr@winston"]\nenabled = true\n'), ['chattr@winston']);
  assert.deepEqual(codexPluginsEnabled('[plugins."chattr@winston"]\nenabled = false\n[features]\n'), []);
  assert.deepEqual(codexPluginsEnabled("[plugins.'chattr@other']\n"), ['chattr@other']);
  assert.deepEqual(codexPluginsEnabled('# [plugins."chattr@winston"]\n[plugins."winston@winston"]\n'), []);
  assert.deepEqual(codexPluginsEnabled(null), []);
  // Dotted keys and inline tables, at the top level and under [plugins].
  assert.deepEqual(codexPluginsEnabled('plugins."chattr@winston".enabled = true\n'), ['chattr@winston']);
  assert.deepEqual(codexPluginsEnabled('plugins."chattr@winston".enabled = false\n'), []);
  assert.deepEqual(codexPluginsEnabled('plugins = { "winston@winston" = { enabled = true }, "chattr@winston" = { enabled = true } }\n'), ['chattr@winston']);
  assert.deepEqual(codexPluginsEnabled('plugins = { "chattr@winston" = { enabled = false } }\n'), []);
  assert.deepEqual(codexPluginsEnabled('[plugins]\n"chattr@winston" = { enabled = true }\n'), ['chattr@winston']);
  assert.deepEqual(codexPluginsEnabled('[plugins]\n"chattr@winston".enabled = false\n'), []);
  assert.deepEqual(codexPluginsEnabled('[ plugins . "chattr@winston" ]\nenabled = true\n'), ['chattr@winston']);
  assert.deepEqual(codexPluginsEnabled('[features]\nplugins = true\n[plugins."winston@winston"]\nenabled = true\n'), []);
});

test('kindOf: turn_id, a rollout transcript or a Codex tool name is Codex; anything else Claude', () => {
  assert.equal(kindOf({ turn_id: 't' }), 'codex');
  assert.equal(kindOf({ transcript_path: '/x/rollout-2026.jsonl' }), 'codex');
  assert.equal(kindOf({ tool_name: 'apply_patch' }), 'codex');
  assert.equal(kindOf({ tool_name: 'Edit', transcript_path: '/x/abc.jsonl' }), 'claude');
  assert.equal(kindOf({}), 'claude');
});

test('standDownReason: Claude reads enabledPlugins and old hooks in settings.json, honouring CLAUDE_CONFIG_DIR', (t) => {
  const h = home(t);
  assert.equal(standDownReason('claude', h.env), null, 'no settings file');
  h.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'winston@winston': true, 'chattr@winston': false } }));
  assert.equal(standDownReason('claude', h.env), null, 'disabled plugin');
  h.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  assert.match(standDownReason('claude', h.env), /separate chattr@winston plugin is enabled/);
  assert.equal(standDownReason('codex', h.env), null, 'Claude settings do not affect Codex');
  h.write('.claude/settings.json', JSON.stringify(compose({}, 'claude', '/old/chattr')));
  assert.match(standDownReason('claude', h.env), /old chattr install\.sh hooks/);
  h.write('.claude/settings.json', '{ broken');
  assert.equal(standDownReason('claude', h.env), null, 'an unparseable file is not another chattr');
  h.write('alt/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  mkdirSync(path.join(h.dir, 'alt', 'plugins', 'cache', 'winston', 'chattr'), { recursive: true });
  assert.match(standDownReason('claude', { ...h.env, CLAUDE_CONFIG_DIR: path.join(h.dir, 'alt') }), /alt\/settings\.json/);
});

test('standDownReason: Codex reads config.toml plugins and old hooks.json, honouring CODEX_HOME', (t) => {
  const h = home(t);
  assert.equal(standDownReason('codex', h.env), null);
  h.write('.codex/config.toml', '[plugins."winston@winston"]\nenabled = true\n');
  assert.equal(standDownReason('codex', h.env), null);
  h.write('.codex/config.toml', '[plugins."chattr@winston"]\nenabled = true\n');
  assert.match(standDownReason('codex', h.env), /separate chattr@winston plugin is enabled/);
  assert.equal(standDownReason('claude', h.env), null);
  h.write('.codex/config.toml', '');
  h.write('.codex/hooks.json', JSON.stringify(compose({}, 'codex', '/old/chattr')));
  assert.match(standDownReason('codex', h.env), /old chattr install\.sh hooks/);
  h.write('ch/config.toml', '[plugins."chattr@winston"]\n');
  mkdirSync(path.join(h.dir, 'ch', 'plugins', 'cache', 'winston', 'chattr'), { recursive: true });
  assert.match(standDownReason('codex', { ...h.env, CODEX_HOME: path.join(h.dir, 'ch') }), /ch\/config\.toml/);
});

test('an enabled plugin whose files are gone does not stand Winston down', (t) => {
  const h = home(t);
  h.write('.codex/config.toml', '[plugins."chattr@winston"]\nenabled = true\n');
  rmSync(path.join(h.dir, '.codex', 'plugins', 'cache', 'winston', 'chattr'), { recursive: true });
  assert.equal(pluginPresent('codex', 'chattr@winston', h.env), false);
  assert.equal(standDownReason('codex', h.env), null);

  h.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  rmSync(path.join(h.dir, '.claude', 'plugins', 'cache'), { recursive: true });
  assert.equal(standDownReason('claude', h.env), null, 'no record and no cache folder: not present');
  mkdirSync(path.join(h.dir, '.claude', 'plugins', 'cache', 'winston', 'chattr'), { recursive: true });
  assert.ok(standDownReason('claude', h.env), 'no record, cache folder on disk: present');
  const kept = path.join(h.dir, 'cache', 'chattr', '0.1.0');
  mkdirSync(kept, { recursive: true });
  h.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'chattr@winston': [{ scope: 'user', installPath: kept }] } }));
  assert.ok(standDownReason('claude', h.env), 'files on disk');
  rmSync(kept, { recursive: true });
  assert.equal(standDownReason('claude', h.env), null, 'record names a path that is gone');
  h.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {} }));
  assert.equal(standDownReason('claude', h.env), null, 'not installed at all');
});

const hook = (env, event, payload, extra = []) => spawnSync(process.execPath, [CHATTR, 'hook', event, ...extra], { input: JSON.stringify(payload), env, encoding: 'utf8' });

test('chattr hook --bundled stands down (no output, no enrollment) while the separate plugin is enabled', (t) => {
  const h = home(t);
  const payload = { hook_event_name: 'SessionStart', session_id: 'bundled-1', source: 'startup', cwd: h.dir };
  h.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  const quiet = hook(h.env, 'SessionStart', payload, ['--bundled']);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '');
  assert.equal(existsSync(h.env.CHATTR_DB), false, 'nothing opened the store');

  const unbundled = hook(h.env, 'SessionStart', payload);
  assert.match(unbundled.stdout, /AGENT-RULES\.md/, 'without --bundled the hook always runs');

  h.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': false } }));
  const ran = hook(h.env, 'SessionStart', { ...payload, session_id: 'bundled-2' }, ['--bundled']);
  assert.match(JSON.parse(ran.stdout).hookSpecificOutput.additionalContext, /bin\/chattr if it is not on PATH/);
  const db = open(h.env.CHATTR_DB);
  try {
    assert.ok(db.prepare('SELECT id FROM sessions WHERE id = ?').get('bundled-2'));
  } finally {
    db.close();
  }
});

// A guard that cannot reach chattr fails closed, which makes stand-down and the off switch visible
// without faking ps: standing down or switched off, the same call allows.
function guard(env, payload, extra = []) {
  const r = spawnSync(process.execPath, [GUARD, ...extra], { input: JSON.stringify(payload), env: { ...env, CHATTR_BIN: '/nonexistent/chattr' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

function repo(h) {
  const dir = path.join(h.dir, 'repo');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('worktree-guard --bundled stands down per CLI; unbundled it still fails closed', (t) => {
  const h = home(t);
  const cwd = repo(h);
  const edit = { session_id: 's', cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'a.txt') } };
  assert.equal(guard(h.env, edit, ['--bundled']).permissionDecision, 'deny');
  h.write('.codex/config.toml', '[plugins."chattr@winston"]\nenabled = true\n');
  assert.equal(guard(h.env, edit, ['--bundled']).permissionDecision, 'deny', 'a Codex install does not stand down a Claude session');
  assert.equal(guard(h.env, { ...edit, turn_id: 't', tool_name: 'apply_patch' }, ['--bundled']), null, 'Codex stands down');
  assert.equal(guard(h.env, { ...edit, turn_id: 't', tool_name: 'apply_patch' })?.permissionDecision, 'deny', 'only --bundled stands down');
});

test('worktree-guard: "sharedCheckoutGuard": false turns it off; a broken config leaves it on; the block names the switch', (t) => {
  const h = home(t);
  const cwd = repo(h);
  const edit = { session_id: 's', cwd, tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'a.txt') } };
  const denied = guard(h.env, edit);
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /"sharedCheckoutGuard": false in \.winston\/config\.json/);
  assert.match(denied.permissionDecisionReason, /CLAUDE_ALLOW_SHARED_CWD=1/);

  h.write('repo/.winston/config.json', JSON.stringify({ sharedCheckoutGuard: false }));
  assert.equal(guard(h.env, edit), null, 'repo switch');
  h.write('repo/.winston/config.json', '{ broken');
  assert.equal(guard(h.env, edit).permissionDecision, 'deny', 'broken config fails closed');
  rmSync(path.join(cwd, '.winston'), { recursive: true });
  h.write('.winston/config.json', JSON.stringify({ sharedCheckoutGuard: false }));
  assert.equal(guard(h.env, edit), null, 'user switch');
  h.write('repo/.winston/config.json', JSON.stringify({ sharedCheckoutGuard: true }));
  assert.equal(guard(h.env, edit).permissionDecision, 'deny', 'the repo layer wins');
});

test('worktree-session-start --bundled is silent while standing down', (t) => {
  const h = home(t);
  const cwd = repo(h);
  const start = (extra) => spawnSync(process.execPath, [SESSION_START, ...extra], { input: JSON.stringify({ session_id: 's', cwd }), env: { ...h.env, CHATTR_BIN: '/nonexistent/chattr' }, encoding: 'utf8' });
  assert.match(start(['--bundled']).stdout, /Could not enumerate live sessions/);
  h.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  assert.equal(start(['--bundled']).stdout, '');
  assert.match(start([]).stdout, /Could not enumerate live sessions/);
});

test('Claude: a project\'s own settings and project-scope installs count, for sessions in that project only', (t) => {
  const h = home(t);
  const repo = path.join(h.dir, 'proj');
  const other = path.join(h.dir, 'other');
  for (const d of [repo, other]) { mkdirSync(path.join(d, 'sub'), { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: d }); }
  const files = path.join(h.dir, 'cache-chattr');
  mkdirSync(files);
  const record = (entries) => h.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'chattr@winston': entries } }));
  record([{ scope: 'project', projectPath: repo, installPath: files }]);
  h.write('proj/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  assert.match(standDownReason('claude', h.env, path.join(repo, 'sub')), /proj\/\.claude\/settings\.json/, 'a subfolder resolves to the project');
  assert.equal(standDownReason('claude', h.env, other), null, 'another repository runs Winston\'s copy');
  assert.equal(standDownReason('claude', h.env), null, 'no cwd: user settings only');

  h.write('proj/.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': false } }));
  assert.equal(standDownReason('claude', h.env, repo), null, 'local false wins over project true');
  rmSync(path.join(repo, '.claude', 'settings.local.json'));

  h.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': true } }));
  h.write('other/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'chattr@winston': false } }));
  record([{ scope: 'user', installPath: files }]);
  assert.match(standDownReason('claude', h.env, repo), /chattr@winston/, 'user install, enabled by the project');
  assert.equal(standDownReason('claude', h.env, other), null, 'project false wins over user true');
  record([{ scope: 'project', projectPath: other, installPath: files }]);
  rmSync(path.join(other, '.claude', 'settings.json'));
  assert.equal(standDownReason('claude', h.env, repo), null, 'enabled, but installed only for another project');
  assert.ok(standDownReason('claude', h.env, other));
});
