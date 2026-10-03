import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LAUNCH = path.join(ROOT, 'launchers/launch-session.sh');
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const COPY = ['.env.local', '.env.development.local', '.vercel/project.json'];

function write(file, content, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
}

function fixture(t, { trackedEnv = false, launcher = { repo: '~/code/app', base: 'origin/staging' } } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'launch-session-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home with spaces');
  const repo = path.join(home, 'code/app');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'launches');
  mkdirSync(repo, { recursive: true });
  write(path.join(home, '.winston/config.json'), JSON.stringify({ launcher }));
  const git = (...args) => execFileSync(REAL_GIT, ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Launcher Test');
  git('config', 'user.email', 'launcher@example.invalid');
  write(path.join(repo, '.gitignore'), '.claude/worktrees/\n.env*\n.vercel/\nnode_modules/\n');
  write(path.join(repo, '.winston/config.json'), JSON.stringify({ branches: { integration: 'staging' }, worktree: { copy: COPY, link: ['node_modules'] } }));
  write(path.join(repo, 'file.txt'), 'staging\n');
  if (trackedEnv) {
    write(path.join(repo, '.env.local'), 'WRONG_PROJECT=tracked\n');
    git('add', '-f', '.env.local');
  }
  git('add', '.');
  git('commit', '-qm', 'staging base');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/staging', base);
  write(path.join(repo, 'file.txt'), 'main branch\n');
  git('commit', '-qam', 'different main');
  write(path.join(repo, 'file.txt'), 'staged edit\n');
  git('add', 'file.txt');
  write(path.join(repo, 'file.txt'), 'unstaged edit\n');
  write(path.join(repo, 'untracked.txt'), 'keep\n');
  write(path.join(repo, '.env.local'), 'PRIVATE_TEST_VALUE=local\n', 0o600);
  write(path.join(repo, '.env.development.local'), 'PRIVATE_TEST_VALUE=development\n', 0o600);
  write(path.join(repo, '.vercel/project.json'), '{"test":true}\n', 0o600);
  mkdirSync(path.join(repo, 'node_modules'));
  for (const agent of ['claude', 'codex']) write(path.join(bin, agent), `#!/bin/bash\necho "${agent} $(pwd -P)" >> "$LAUNCH_LOG"\n`, 0o755);
  write(path.join(bin, 'caffeinate'), '#!/bin/sh\nexit 0\n', 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, LAUNCH_LOG: log };
  delete env.WINSTON_HOME;
  const snapshot = () => ({
    head: git('rev-parse', 'HEAD'), branch: git('symbolic-ref', 'HEAD'),
    index: readFileSync(path.join(repo, '.git/index')).toString('base64'),
    tracked: readFileSync(path.join(repo, 'file.txt'), 'utf8'),
    untracked: readFileSync(path.join(repo, 'untracked.txt'), 'utf8'),
  });
  const run = (args = ['claude']) => spawnSync('bash', [LAUNCH, ...args], { env, encoding: 'utf8' });
  const launches = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => l.replace(/^\w+ /, '')) : [];
  return { root, home, repo, bin, log, git, base, env, snapshot, run, launches };
}
function successful(result) { assert.equal(result.status, 0, result.stderr || result.stdout); }

test('new launch pins the base, provisions files and preserves the dirty shared checkout', (t) => {
  const fx = fixture(t);
  const before = fx.snapshot();
  const result = fx.run();
  successful(result);
  const [wt] = fx.launches();
  assert.ok(wt && wt !== fx.repo);
  assert.equal(execFileSync(REAL_GIT, ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fx.base);
  assert.equal(readFileSync(path.join(wt, 'file.txt'), 'utf8'), 'staging\n');
  for (const file of COPY) assert.deepEqual(readFileSync(path.join(wt, file)), readFileSync(path.join(fx.repo, file)));
  assert.equal(readlinkSync(path.join(wt, 'node_modules')), fx.repo + '/node_modules');
  assert.deepEqual(fx.snapshot(), before);
  assert.ok(existsSync(wt), 'worktree survives CLI exit');
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_TEST_VALUE/);
});

test('codex launches the same way, into its own worktree', (t) => {
  const fx = fixture(t);
  successful(fx.run(['codex']));
  assert.match(readFileSync(fx.log, 'utf8'), /^codex .*\/\.claude\/worktrees\/codex-/);
});

test('base defaults to origin/<branches.integration> when launcher.base is unset', (t) => {
  const fx = fixture(t, { launcher: { repo: '~/code/app' } });
  successful(fx.run());
  assert.equal(execFileSync(REAL_GIT, ['-C', fx.launches()[0], 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fx.base);
});

test('simultaneous launches have independent worktrees, branches and indexes', async (t) => {
  const fx = fixture(t);
  const before = fx.snapshot();
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn('bash', [LAUNCH, 'claude'], { env: fx.env });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });
  (await Promise.all([launch(), launch()])).forEach(successful);
  const [a, b] = fx.launches();
  assert.equal(fx.launches().length, 2);
  assert.notEqual(a, b);
  const git = (wt, ...args) => execFileSync(REAL_GIT, ['-C', wt, ...args], { encoding: 'utf8' }).trim();
  assert.notEqual(git(a, 'symbolic-ref', 'HEAD'), git(b, 'symbolic-ref', 'HEAD'));
  assert.notEqual(git(a, 'rev-parse', '--git-path', 'index'), git(b, 'rev-parse', '--git-path', 'index'));
  git(a, 'switch', '-qc', 'test/isolated');
  write(path.join(a, 'file.txt'), 'only a\n');
  git(a, 'add', 'file.txt');
  git(a, 'commit', '-qm', 'isolated change');
  assert.equal(git(b, 'rev-parse', 'HEAD'), fx.base);
  assert.equal(readFileSync(path.join(b, 'file.txt'), 'utf8'), 'staging\n');
  assert.deepEqual(fx.snapshot(), before);
});

test('missing optional sources allow code-only launch with notice', (t) => {
  const fx = fixture(t);
  for (const file of ['.env.local', '.env.development.local', '.vercel', 'node_modules']) rmSync(path.join(fx.repo, file), { recursive: true });
  const result = fx.run();
  successful(result);
  assert.equal(fx.launches().length, 1);
  assert.match(result.stderr, /\.env\.local not available/);
  assert.match(result.stderr, /node_modules/);
});

test('missing base ref aborts instead of using shared HEAD', (t) => {
  const fx = fixture(t);
  fx.git('update-ref', '-d', 'refs/remotes/origin/staging');
  const before = fx.snapshot();
  const result = fx.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /origin\/staging/);
  assert.deepEqual(fx.launches(), []);
  assert.deepEqual(fx.snapshot(), before);
});

test('missing launcher.repo aborts with the fix', (t) => {
  const fx = fixture(t, { launcher: {} });
  const result = fx.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /launcher\.repo/);
  assert.deepEqual(fx.launches(), []);
});

for (const failing of ['creation', 'copy', 'link']) {
  test(`failed ${failing} stops launch and retains diagnostic path`, (t) => {
    const fx = fixture(t);
    const before = fx.snapshot();
    if (failing === 'creation') {
      write(path.join(fx.bin, 'git'), `#!/bin/bash\nif [[ "$*" == *"worktree add"* ]]; then exit 1; fi\nexec '${REAL_GIT}' "$@"\n`, 0o755);
    } else write(path.join(fx.bin, failing === 'copy' ? 'cp' : 'ln'), '#!/bin/sh\nexit 1\n', 0o755);
    const result = fx.run();
    assert.notEqual(result.status, 0);
    assert.deepEqual(fx.launches(), []);
    assert.match(result.stderr, /[Pp]reserved|[Rr]etained/);
    assert.deepEqual(fx.snapshot(), before);
  });
}

test('silent provisioning failure is detected', (t) => {
  const fx = fixture(t);
  write(path.join(fx.bin, 'cp'), '#!/bin/sh\nexit 0\n', 0o755);
  assert.notEqual(fx.run().status, 0);
  assert.deepEqual(fx.launches(), []);
});

test('resume arguments and unknown agents are rejected before creating a session', (t) => {
  const fx = fixture(t);
  const before = fx.git('worktree', 'list', '--porcelain');
  assert.notEqual(fx.run(['claude', '--resume', 'existing']).status, 0);
  assert.notEqual(fx.run([]).status, 0);
  assert.notEqual(fx.run(['vim']).status, 0);
  assert.equal(fx.git('worktree', 'list', '--porcelain'), before);
  assert.deepEqual(fx.launches(), []);
});

test('.command routes through the same isolated launcher', (t) => {
  const fx = fixture(t);
  const result = spawnSync('bash', [path.join(ROOT, 'launchers/LaunchClaude.command')], { env: fx.env, input: '\n', encoding: 'utf8' });
  successful(result);
  assert.equal(fx.launches().length, 1);
  assert.notEqual(fx.launches()[0], fx.repo);
});

test('application sources route through the common launcher', () => {
  for (const name of ['LaunchClaude', 'LaunchCodex']) {
    const source = readFileSync(path.join(ROOT, `launchers/${name}.applescript`), 'utf8');
    assert.match(source, /launch-session\.sh/);
    assert.doesNotMatch(source, /exec (claude|codex)/);
  }
});

test('mismatched existing environment aborts without overwriting or launching', (t) => {
  const fx = fixture(t, { trackedEnv: true });
  const before = fx.snapshot();
  const result = fx.run();
  assert.notEqual(result.status, 0);
  assert.deepEqual(fx.launches(), []);
  assert.match(result.stderr, /[Pp]reserved/);
  assert.deepEqual(fx.snapshot(), before);
  assert.equal(readFileSync(path.join(fx.repo, '.env.local'), 'utf8'), 'PRIVATE_TEST_VALUE=local\n');
});
