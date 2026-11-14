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
import { doctorResultPath } from '../lib/config.mjs';
import { lastOpenAndClose } from '../hooks/browser-tab-guard.mjs';

const HOOKS = resolve(import.meta.dirname, '../hooks');

function sandbox(t) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'winston-hooks-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = join(tmp, 'winston');
  const env = { ...process.env, WINSTON_HOME: home, CLAUDE_CONFIG_DIR: join(tmp, 'claude'), WINSTON_UPDATE_URL: `file://${join(tmp, 'latest.json')}` };
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

// ---- doctor-nudge

test('doctor-nudge: one line per session when the last doctor run left open items, silent otherwise', (t) => {
  const s = sandbox(t);
  const repo = join(s.tmp, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const result = (data) => {
    const file = doctorResultPath(repo);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  };
  process.env.WINSTON_HOME = s.home;
  t.after(() => delete process.env.WINSTON_HOME);
  mkdirSync(join(repo, 'src/deep'), { recursive: true });
  const start = (id, cwd = repo) => s.run('doctor-nudge.mjs', { hook_event_name: 'SessionStart', cwd, session_id: id });

  result({ root: repo, open: 3 });
  assert.equal(start('aaaaaaaa-1'), '', 'no Winston config in the repo: silent');
  mkdirSync(join(repo, '.winston'));
  writeFileSync(join(repo, '.winston/config.json'), '{}');
  const out = start('aaaaaaaa-1');
  assert.equal(out.systemMessage, 'Winston setup has 3 open items – run /winston:doctor.');
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'SessionStart', additionalContext: out.systemMessage });
  assert.equal(start('aaaaaaaa-1'), '', 'a resume or compaction in the same session does not repeat it');
  result({ root: repo, open: 1 });
  assert.equal(start('bbbbbbbb-2', join(repo, 'src/deep')).systemMessage, 'Winston setup has 1 open item – run /winston:doctor.', 'from a subdirectory too');

  // Nothing open, doctor never run, or a result that does not parse: no output, exit 0.
  result({ root: repo, open: 0 });
  assert.equal(start('cccccccc-3'), '');
  result('{ nope');
  assert.equal(start('dddddddd-4'), '');
  rmSync(doctorResultPath(repo));
  assert.equal(start('eeeeeeee-5'), '');
  assert.equal(s.run('doctor-nudge.mjs', undefined), '', 'no payload at all');

  // It is registered at session start, and reads nothing but local files.
  const hooks = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8')).hooks;
  assert.ok(hooks.SessionStart[0].hooks.some((h) => h.command.includes('doctor-nudge.mjs')));
  assert.doesNotMatch(readFileSync(join(HOOKS, 'doctor-nudge.mjs'), 'utf8'), /child_process|repoRoot|fetch\(|https?:/, 'no process to wait on, no network');
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
  assert.match(out.hookSpecificOutput.additionalContext, /prep list.*item \| state \| prep running \| blocker/s);
  assert.match(out.hookSpecificOutput.additionalContext, /token or model cost never holds startable work/);
  writeFileSync(transcript, [prompt, toolResult, JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [out.hookSpecificOutput.additionalContext] } }), toolResult].join('\n'));
  assert.equal(stop(), '', 'already asked this turn');
  writeFileSync(transcript, [readFileSync(transcript, 'utf8'), prompt].join('\n'));
  assert.ok(stop().hookSpecificOutput, 'a new prompt is a new turn');

  assert.equal(stop({ stop_hook_active: true }), '');
  assert.equal(stop({ agent_id: 'lane-1', turn_id: 'x' }), '', 'a subagent is not the orchestrator');
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'resume brief: Parallelism check (Winston), ...' } }));
  assert.ok(stop().hookSpecificOutput, 'a prompt quoting the ask is still a new turn');
  assert.equal(stop({ session_id: 'other' }), '', 'not a Winston session');
  assert.equal(stop({}, { PATH: '/nonexistent' }), '', 'no chattr fails open');
  assert.equal(stop({ transcript_path: join(s.tmp, 'missing') }), '', 'unreadable transcript fails open');
  assert.equal(stop({ turn_id: 'x' }).decision, 'block', 'Codex gets a block');
  assert.equal(stop({}, { ...env, WINSTON_SKIP_PARALLELISM_CHECK: '1' }), '');
});

// ---- start-branch

function repoWithOrigin(t, config = { branches: { integration: 'staging', production: 'main' } }) {
  const r = repoWithWorktree(t, config);
  const origin = join(r.tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  r.git(r.main, 'remote', 'add', 'origin', origin);
  r.git(r.main, 'push', '-q', 'origin', 'main', 'main:staging');
  r.git(r.main, 'fetch', '-q', 'origin');
  r.git(r.main, 'branch', '-q', '--track', 'staging', 'origin/staging');
  // A commit that reaches origin/staging from elsewhere, as a merged pull request does.
  r.advance = () => {
    r.git(r.wt, 'commit', '-q', '--allow-empty', '-m', 'merged elsewhere');
    r.git(r.wt, 'push', '-q', 'origin', 'HEAD:staging');
    return r.git(r.wt, 'rev-parse', 'HEAD');
  };
  r.start = (cwd = r.main, extra = {}, input = {}) => {
    const out = r.run('start-branch.mjs', { hook_event_name: 'SessionStart', source: 'startup', cwd, ...input }, { CI: '', GITHUB_ACTIONS: '', ...extra });
    return out ? out.hookSpecificOutput.additionalContext : '';
  };
  return r;
}

test('start-branch: a clean main checkout on production moves to integration and fast-forwards', (t) => {
  const r = repoWithOrigin(t);
  const tip = r.advance();
  assert.match(r.start(), /switched this checkout from main to staging \(fast-forwarded to [0-9a-f]{7}\)/);
  assert.equal(r.git(r.main, 'symbolic-ref', '--short', 'HEAD'), 'staging');
  assert.equal(r.git(r.main, 'rev-parse', 'HEAD'), tip);
  assert.equal(r.start(), '', 'already on integration and current: silent');
  const next = r.advance();
  assert.match(r.start(), /^start-branch: staging fast-forwarded to/);
  assert.equal(r.git(r.main, 'rev-parse', 'HEAD'), next);
});

test('start-branch: leaves uncommitted changes, other branches, worktrees and opted-out repos alone', (t) => {
  const r = repoWithOrigin(t);
  writeFileSync(join(r.main, '.gitignore'), 'edited\n');
  assert.match(r.start(), /on main with uncommitted changes, so it was left there/);
  assert.equal(r.git(r.main, 'symbolic-ref', '--short', 'HEAD'), 'main');
  r.git(r.main, 'checkout', '-q', '--', '.gitignore');

  r.git(r.main, 'switch', '-q', '-c', 'feature');
  assert.equal(r.start(), '', 'a branch someone chose is not second-guessed');
  assert.equal(r.git(r.main, 'symbolic-ref', '--short', 'HEAD'), 'feature');
  r.git(r.main, 'switch', '-q', 'main');

  assert.equal(r.start(r.main, { GITHUB_ACTIONS: 'true' }), '', 'a CI checkout is the ref the workflow chose');
  assert.equal(r.git(r.main, 'symbolic-ref', '--short', 'HEAD'), 'main');

  for (const source of ['resume', 'clear', 'compact']) assert.equal(r.start(r.main, {}, { source }), '', `${source} is the same session going on`);
  assert.equal(r.git(r.main, 'symbolic-ref', '--short', 'HEAD'), 'main');

  // A linked worktree that is itself on production, clean: still never switched.
  r.git(r.main, 'switch', '-q', '--detach');
  r.git(r.wt, 'switch', '-q', 'main');
  assert.equal(r.start(r.wt), '', 'a linked worktree is never switched');
  assert.equal(r.git(r.wt, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(r.start(), '', 'a detached HEAD is left alone');
  r.git(r.wt, 'switch', '-q', 'worktree-thing');
  r.git(r.main, 'switch', '-q', 'main');

  // Staged-only changes count as uncommitted; an untracked file in the way stops the switch and survives.
  writeFileSync(join(r.main, '.gitignore'), 'staged\n');
  r.git(r.main, 'add', '.gitignore');
  assert.match(r.start(), /uncommitted changes, so it was left there/);
  r.git(r.main, 'reset', '-q', '--hard');

  writeFileSync(join(r.main, '.winston/config.json'), JSON.stringify({ branches: { integration: 'staging', production: 'main' }, startBranch: false }));
  r.git(r.main, 'commit', '-qam', 'opt out');
  assert.equal(r.start(), '');
  assert.equal(r.git(r.main, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('start-branch: a branch name from config never reaches git as an option', (t) => {
  for (const integration of ['--upload-pack=touch PWNED;', '--detach', '-f', 'a..b', 7]) {
    const r = repoWithOrigin(t, { branches: { integration, production: 'main' } });
    assert.match(r.start(), /not a plain branch name, so nothing was done/, String(integration));
    assert.equal(r.git(r.main, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.ok(!existsSync(join(r.main, 'PWNED')));
  }
});

test('start-branch: says what it could not do, and why', (t) => {
  const r = repoWithOrigin(t);
  r.git(r.main, 'remote', 'set-url', 'origin', join(r.tmp, 'gone.git'));
  assert.match(r.start(), /switched this checkout from main to staging \(origin could not be reached, so it may be behind\)/);
  r.git(r.main, 'remote', 'set-url', 'origin', join(r.tmp, 'origin.git'));

  // An untracked file where an incoming commit adds one: not "diverged", and the file survives.
  r.git(r.wt, 'switch', '-q', '--detach', 'origin/staging');
  writeFileSync(join(r.wt, 'incoming.txt'), 'theirs\n');
  r.git(r.wt, 'add', 'incoming.txt');
  r.git(r.wt, 'commit', '-qm', 'adds a file');
  r.git(r.wt, 'push', '-q', 'origin', 'HEAD:staging');
  writeFileSync(join(r.main, 'incoming.txt'), 'mine\n');
  const blocked = r.start();
  assert.match(blocked, /behind origin and could not be fast-forwarded: /);
  assert.doesNotMatch(blocked, /diverged/);
  assert.equal(readFileSync(join(r.main, 'incoming.txt'), 'utf8'), 'mine\n');
});

test('start-branch: local commits on integration are never rewritten', (t) => {
  const r = repoWithOrigin(t);
  r.git(r.main, 'switch', '-q', 'staging');
  r.git(r.main, 'commit', '-q', '--allow-empty', '-m', 'local only');
  const local = r.git(r.main, 'rev-parse', 'HEAD');
  assert.match(r.start(), /^start-branch: staging ahead of origin, with commits not pushed\.$/);
  assert.equal(r.git(r.main, 'rev-parse', 'HEAD'), local);
  r.advance();
  assert.match(r.start(), /staging diverged from origin\/staging, left as is/);
  assert.equal(r.git(r.main, 'rev-parse', 'HEAD'), local);
});

// ---- update-check

function updates(t) {
  const s = sandbox(t);
  const have = JSON.parse(readFileSync(resolve(HOOKS, '../.claude-plugin/plugin.json'), 'utf8')).version;
  const latest = (v) => writeFileSync(join(s.tmp, 'latest.json'), JSON.stringify({ version: v }));
  const start = (input = {}, extra = {}) => s.run('update-check.mjs', { hook_event_name: 'SessionStart', source: 'startup', cwd: s.tmp, ...input }, { CI: '', GITHUB_ACTIONS: '', ...extra });
  const cache = join(s.home, 'state/update-check/latest.json');
  return { ...s, have, latest, start, cache };
}

test('update-check: a new session is told a newer Winston is out and how to get it', (t) => {
  const u = updates(t);
  u.latest('99.0.0');
  const out = u.start();
  assert.equal(out.systemMessage, `Winston 99.0.0 is available; ${u.have} is installed. To update, run \`claude plugin marketplace update winston && claude plugin update winston@winston\`, then restart Claude Code (inside a session, type it after \`!\`, or use /plugin).`);
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(out.systemMessage));
  assert.match(out.hookSpecificOutput.additionalContext, /Tell the user this, with the exact update steps/);
  assert.match(u.start({ turn_id: 't1' }).systemMessage, /run `codex plugin marketplace upgrade winston`, then `codex plugin add winston@winston`/, 'Codex gets Codex\'s commands');
});

test('update-check: this project\'s own install is updated at project scope', (t) => {
  const u = updates(t);
  u.latest('99.0.0');
  mkdirSync(join(u.tmp, 'claude/plugins'), { recursive: true });
  const entry = (scope, projectPath) => ({ scope, projectPath, installPath: resolve(HOOKS, '..') });
  writeFileSync(join(u.tmp, 'claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'winston@winston': [entry('user'), entry('project', join(u.tmp, 'proj'))] } }));
  assert.doesNotMatch(u.start().systemMessage, /--scope project/, 'another project\'s install does not count');
  assert.match(u.start({ cwd: join(u.tmp, 'proj/sub') }).systemMessage, /claude plugin update winston@winston --scope project` from this project's directory/);
});

test('update-check: silent when current, unknown, not a new session, in CI or turned off', (t) => {
  const u = updates(t);
  assert.equal(u.start(), '', 'latest unknown');
  rmSync(u.cache);
  u.latest(u.have);
  assert.equal(u.start(), '', 'current');
  rmSync(u.cache);
  u.latest('99.0.0');
  for (const source of ['resume', 'clear', 'compact']) assert.equal(u.start({ source }), '', source);
  assert.equal(u.start({}, { GITHUB_ACTIONS: 'true' }), '', 'CI');
  u.userConfig({ updateCheck: false });
  assert.equal(u.start(), '', 'updateCheck: false');
  assert.ok(!existsSync(u.cache), 'none of those asked for the latest version');
});

test('update-check: asks for the latest version once, then answers from the cache', (t) => {
  const u = updates(t);
  u.latest('99.0.0');
  assert.match(u.start().systemMessage, /99\.0\.0/);
  u.latest('100.0.0');
  assert.match(u.start().systemMessage, /99\.0\.0/, 'under a day old: the cached answer');
  const stale = (latest, ageMs) => writeFileSync(u.cache, JSON.stringify({ checkedAt: Date.now() - ageMs, latest }));
  stale('99.0.0', 25 * 60 * 60 * 1000);
  assert.match(u.start().systemMessage, /100\.0\.0/, 'over a day old: asked again');
  // A failed lookup is remembered for an hour, so an offline machine is not asked every session.
  stale(null, 10 * 60 * 1000);
  assert.equal(u.start(), '');
  stale(null, 61 * 60 * 1000);
  assert.match(u.start().systemMessage, /100\.0\.0/);
});
