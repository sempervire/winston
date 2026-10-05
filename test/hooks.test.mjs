// Decision logic of secret-grant, session-title, browser-tab-guard and worktree-setup,
// driven end to end through stdin the way a CLI calls them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { armMatcher, CREDENTIAL_URL, urlsIn } from '../hooks/secret-grant.mjs';
import { normalize } from '../hooks/session-title.mjs';
import { lastOpenAndClose } from '../hooks/browser-tab-guard.mjs';

const HOOKS = resolve(import.meta.dirname, '../hooks');

function sandbox(t) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'winston-hooks-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = join(tmp, 'winston');
  const env = { ...process.env, WINSTON_HOME: home };
  delete env.CLAUDE_SKIP_TAB_GUARD;
  const run = (hook, input, extra = {}, args = []) => {
    const r = spawnSync(process.execPath, [join(HOOKS, hook), ...args], { input: input === undefined ? '' : JSON.stringify(input), env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : r.stdout;
  };
  const userConfig = (c) => { mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'config.json'), JSON.stringify(c)); };
  return { tmp, home, run, userConfig };
}

// ---- secret-grant

test('secret-grant: credential URLs are found anywhere in a tool input', () => {
  assert.deepEqual(urlsIn({ actions: [{ url: 'https://dash.example.com/api-tokens' }, { x: 'no' }] }), ['https://dash.example.com/api-tokens']);
  for (const u of ['https://console.aws.amazon.com/iam/home', 'https://github.com/settings/tokens', 'https://x.com/project/environment-variables'])
    assert.ok(CREDENTIAL_URL.test(u), u);
  assert.ok(!CREDENTIAL_URL.test('https://github.com/acme/app/pulls'));
});

test('secret-grant: the default phrase is loose, a configured one keeps that looseness', () => {
  assert.ok(armMatcher().test('ok, I authorized secrets for this'));
  assert.ok(armMatcher('authorize secrets').test('Authorize-secret'));
  const custom = armMatcher('open the vault');
  assert.ok(custom.test('please OPEN the-vault now'));
  assert.ok(!custom.test('authorize secrets'));
});

test('secret-grant: denies credential pages until armed, per session; revoke wins', (t) => {
  const s = sandbox(t);
  s.userConfig({ owner: 'Pat' });
  const nav = (session_id) => s.run('secret-grant.mjs', { hook_event_name: 'PreToolUse', session_id, tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url: 'https://dash.example.com/r2/api-tokens' } });
  const prompt = (session_id, p) => s.run('secret-grant.mjs', { hook_event_name: 'UserPromptSubmit', session_id, prompt: p });

  const denied = nav('aaaa-1111');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Pat's explicit authorization/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /"authorize secrets"/);
  assert.equal(s.run('secret-grant.mjs', { hook_event_name: 'PreToolUse', session_id: 'aaaa-1111', tool_input: { url: 'https://example.com/docs' } }), '');

  assert.equal(prompt('aaaa-1111', 'hello'), '');
  assert.match(prompt('aaaa-1111', 'authorize secrets').hookSpecificOutput.additionalContext, /AUTHORIZED/);
  assert.equal(nav('aaaa-1111'), '', 'armed session passes');
  assert.equal(nav('bbbb-2222').hookSpecificOutput.permissionDecision, 'deny', 'grant is per session');
  assert.match(prompt('aaaa-1111', 'revoke secrets authorization').hookSpecificOutput.additionalContext, /REVOKED/);
  assert.equal(nav('aaaa-1111').hookSpecificOutput.permissionDecision, 'deny');
});

test('secret-grant: the configured phrase arms, and a broken config falls back to the default', (t) => {
  const s = sandbox(t);
  s.userConfig({ secretGrant: { phrase: 'open the vault' } });
  assert.equal(s.run('secret-grant.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'authorize secrets' }), '');
  assert.ok(s.run('secret-grant.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'open the vault' }));
  writeFileSync(join(s.home, 'config.json'), '{ broken');
  const out = s.run('secret-grant.mjs', { hook_event_name: 'PreToolUse', session_id: 's2', tool_input: { url: 'https://x.com/api-keys' } });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', 'still fails closed on the narrow matcher');
});

// ---- session-title

test('session-title: whitespace collapses before control characters are stripped', () => {
  assert.equal(normalize('Fix\tthis\nnow\x07'), 'Fix this now');
  assert.equal([...normalize('x'.repeat(500))].length, 200);
});

test('session-title: each distinct title is emitted once; Codex is left alone', (t) => {
  const s = sandbox(t);
  const env = { CLAUDE_CODE_SESSION_ID: 'abcd-1234-ef' };
  s.run('session-title.mjs', undefined, env, ['Fix', 'the', 'login']);
  const prompt = (extra = {}) => s.run('session-title.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 'abcd-1234-ef', ...extra });
  assert.equal(prompt({ turn_id: 't1' }), '', 'Codex names its own threads');
  assert.equal(prompt().hookSpecificOutput.sessionTitle, 'Fix the login');
  assert.equal(prompt(), '', 'not re-emitted, so a manual rename survives');
  s.run('session-title.mjs', undefined, env, ['Second task']);
  const start = s.run('session-title.mjs', { hook_event_name: 'SessionStart', session_id: 'abcd-1234-ef' });
  assert.deepEqual(start.hookSpecificOutput, { hookEventName: 'SessionStart', sessionTitle: 'Second task' });
});

// ---- browser-tab-guard

const use = (name, input = {}) => JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } });
const OPEN = 'mcp__claude-in-chrome__tabs_create_mcp';
const CLOSE = 'mcp__claude-in-chrome__tabs_close_mcp';

test('browser-tab-guard: order of the last open and close decides, not counts', () => {
  assert.deepEqual(lastOpenAndClose([use(OPEN), use(OPEN), use(CLOSE)]), { lastOpen: 1, lastClose: 2 });
  assert.deepEqual(lastOpenAndClose([use('mcp__claude-in-chrome__tabs_context_mcp')]).lastOpen, -1, 'context without createIfEmpty opens nothing');
  assert.deepEqual(lastOpenAndClose([use('mcp__claude-in-chrome__tabs_context_mcp', { createIfEmpty: true })]).lastOpen, 0);
  const codex = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__claude-in-chrome', name: 'tabs_create_mcp', arguments: '{}' } });
  assert.equal(lastOpenAndClose(['garbage', codex]).lastOpen, 1, 'Codex rollout calls count too');
});

test('browser-tab-guard: asks once per open, in each CLI\'s Stop shape', (t) => {
  const s = sandbox(t);
  const transcript = join(s.tmp, 't.jsonl');
  writeFileSync(transcript, [use(OPEN)].join('\n'));
  const stop = (extra = {}) => s.run('browser-tab-guard.mjs', { hook_event_name: 'Stop', session_id: 'sess-0001', transcript_path: transcript, ...extra });

  assert.match(stop().hookSpecificOutput.additionalContext, /never closed it/);
  assert.equal(stop(), '', 'same open: stands down');
  writeFileSync(transcript, [use(OPEN), use(CLOSE), use(OPEN)].join('\n'));
  const codex = stop({ turn_id: 'x' });
  assert.equal(codex.decision, 'block');
  assert.match(codex.reason, /never closed it/);
  writeFileSync(transcript, [use(OPEN), use(CLOSE)].join('\n'));
  assert.equal(stop(), '');
  assert.equal(s.run('browser-tab-guard.mjs', { hook_event_name: 'Stop', session_id: 'x', transcript_path: join(s.tmp, 'missing') }), '', 'fails open');
  writeFileSync(transcript, use(OPEN));
  assert.equal(s.run('browser-tab-guard.mjs', { session_id: 'sess-0002', transcript_path: transcript }, { CLAUDE_SKIP_TAB_GUARD: '1' }), '');
});

// ---- worktree-setup

function repoWithWorktree(t, config) {
  const s = sandbox(t);
  const main = join(s.tmp, 'main');
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 't');
  git(main, 'config', 'user.email', 't@example.invalid');
  mkdirSync(join(main, '.winston'));
  writeFileSync(join(main, '.winston/config.json'), JSON.stringify(config));
  writeFileSync(join(main, '.gitignore'), '.env.local\nnode_modules/\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');
  writeFileSync(join(main, '.env.local'), 'X=1\n');
  mkdirSync(join(main, 'node_modules'));
  const wt = join(s.tmp, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'worktree-thing', wt);
  return { ...s, main, wt, git };
}

test('worktree-setup: copies and links what config lists, never overwrites, no-op on main', (t) => {
  const r = repoWithWorktree(t, { worktree: { copy: ['.env.local', 'absent.txt'], link: ['node_modules'] } });
  assert.equal(r.run('worktree-setup.mjs', { hook_event_name: 'PostToolUse', tool_name: 'EnterWorktree', cwd: r.main, tool_response: { worktreePath: r.wt } }), 'worktree-setup: wt: .env.local node_modules -> main (symlink)\n');
  assert.equal(readFileSync(join(r.wt, '.env.local'), 'utf8'), 'X=1\n');
  assert.ok(lstatSync(join(r.wt, 'node_modules')).isSymbolicLink());
  assert.equal(readlinkSync(join(r.wt, 'node_modules')), join(r.main, 'node_modules'));
  writeFileSync(join(r.wt, '.env.local'), 'mine\n');
  assert.equal(r.run('worktree-setup.mjs', { hook_event_name: 'SessionStart', cwd: r.wt }), '', 'nothing left to do');
  assert.equal(readFileSync(join(r.wt, '.env.local'), 'utf8'), 'mine\n');
  assert.equal(r.run('worktree-setup.mjs', { hook_event_name: 'SessionStart', cwd: r.main }), '');
  assert.ok(!existsSync(join(r.main, 'absent.txt')));
});

test('worktree-setup: SessionStart reports as JSON; branch pattern and detached HEAD warn', (t) => {
  const r = repoWithWorktree(t, { worktree: { copy: ['.env.local'], branchPattern: '^(feat|fix)/\\d+-' } });
  const out = r.run('worktree-setup.mjs', { hook_event_name: 'SessionStart', cwd: r.wt });
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /\.env\.local/);
  assert.match(out.systemMessage, /does not match this repo's branch pattern/);
  r.git(r.wt, 'switch', '-q', '-c', 'session/claude-x');
  assert.doesNotMatch(r.run('worktree-setup.mjs', { hook_event_name: 'SessionStart', cwd: r.wt }).systemMessage ?? '', /branch pattern/);
  r.git(r.wt, 'switch', '-q', '--detach');
  assert.match(r.run('worktree-setup.mjs', { hook_event_name: 'PostToolUse', cwd: r.wt }).systemMessage, /detached HEAD/);
});

test('worktree-setup: without worktree config it copies nothing', (t) => {
  const r = repoWithWorktree(t, {});
  assert.equal(r.run('worktree-setup.mjs', { hook_event_name: 'SessionStart', cwd: r.wt }), '');
  assert.ok(!existsSync(join(r.wt, '.env.local')));
});

// ---- parallelism-check

test('parallelism-check: asks once per turn, only in a session holding resource:orchestrator', (t) => {
  const s = sandbox(t);
  const bin = join(s.tmp, 'bin');
  mkdirSync(bin);
  // Fake chattr: the orchestrator claim belongs to session "win"; "other" is not enrolled.
  writeFileSync(join(bin, 'chattr'), `#!/bin/sh
[ "$CHATTR_SESSION" = win ] || { echo '{"ok":false}'; exit 3; }
echo '{"ok":true,"claims":[{"resource":"resource:orchestrator","session_id":"win","released_at":null}]}'
`, { mode: 0o755 });
  const transcript = join(s.tmp, 't.jsonl');
  const prompt = JSON.stringify({ type: 'user', message: { content: 'go' } });
  const toolResult = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const stop = (extra = {}, e = env) => s.run('parallelism-check.mjs', { hook_event_name: 'Stop', session_id: 'win', transcript_path: transcript, ...extra }, e);

  writeFileSync(transcript, [prompt, toolResult].join('\n'));
  const out = stop();
  assert.match(out.hookSpecificOutput.additionalContext, /unmerged code is not a blocker/);
  writeFileSync(transcript, [prompt, toolResult, JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [out.hookSpecificOutput.additionalContext] } }), toolResult].join('\n'));
  assert.equal(stop(), '', 'already asked this turn');
  writeFileSync(transcript, [readFileSync(transcript, 'utf8'), prompt].join('\n'));
  assert.ok(stop().hookSpecificOutput, 'a new prompt is a new turn');

  assert.equal(stop({ stop_hook_active: true }), '');
  assert.equal(stop({ session_id: 'other' }), '', 'not a Winston session');
  assert.equal(stop({}, { PATH: '/nonexistent' }), '', 'no chattr fails open');
  assert.equal(stop({ transcript_path: join(s.tmp, 'missing') }), '', 'unreadable transcript fails open');
  assert.equal(stop({ turn_id: 'x' }).decision, 'block', 'Codex gets a block');
  assert.equal(stop({}, { ...env, WINSTON_SKIP_PARALLELISM_CHECK: '1' }), '');
});
