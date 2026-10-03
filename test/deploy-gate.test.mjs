import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cdTargets, gatedCommands, phraseMatcher } from '../hooks/deploy-gate.mjs';

const hook = resolve(import.meta.dirname, '../hooks/deploy-gate.mjs');
const GUARDED = [
  { kind: 'pr-merge', base: 'release' },
  { kind: 'workflow-run', workflow: 'db-migrate(\\.ya?ml)?|database migrations|123456789' },
];
const kinds = (cmd) => gatedCommands(cmd, GUARDED).map((g) => g.kind).join(',');

test('workflow dispatch is caught in every shape', () => {
  for (const cmd of [
    'gh workflow run db-migrate.yml --ref release',
    'gh workflow run db-migrate.yml --ref=release',
    'gh workflow run --ref release --ref main db-migrate.yml',
    'gh workflow run -R acme/app db-migrate.yml',
    'gh --repo=acme/app workflow run db-migrate',
    'gh workflow run .github/workflows/db-migrate.yml -f allow_out_of_order=true',
    'gh workflow run "Database migrations"',
    'gh workflow run 123456789',
    'git fetch && gh workflow run db-migrate.yml',
    'echo hi; GH_REPO=acme/app gh workflow run db-migrate.yml',
    'true || /opt/homebrew/bin/gh workflow run db-migrate.yml | cat',
    'bash -c "gh workflow run db-migrate.yml --ref release"',
    'echo $(gh workflow run db-migrate.yml)',
    'gh workflow run db-migrate.yml\ngh run list',
    'gh api repos/acme/app/actions/workflows/db-migrate.yml/dispatches -f ref=release',
    'gh api repos/acme/app/actions/workflows/Database%20migrations/dispatches',
  ]) assert.equal(kinds(cmd), 'workflow-run', cmd);
});

test('merges are caught with their selector and repo', () => {
  const merge = (cmd) => gatedCommands(cmd, GUARDED).map(({ kind, selector, repo }) => ({ kind, selector, repo }));
  assert.deepEqual(merge('gh pr merge 412 --merge'), [{ kind: 'pr-merge', selector: '412', repo: null }]);
  assert.deepEqual(merge('cd x && gh pr merge --squash -R acme/app 9'), [{ kind: 'pr-merge', selector: '9', repo: 'acme/app' }]);
  assert.deepEqual(merge('gh pr merge --repo=a/b --subject "x y" 7 -d'), [{ kind: 'pr-merge', selector: '7', repo: 'a/b' }]);
  assert.deepEqual(merge('gh pr merge --auto'), [{ kind: 'pr-merge', selector: null, repo: null }]);
});

test('text handed to a shell is rescanned, so wrapping never hides a call', () => {
  for (const cmd of [
    'bash -c "gh pr merge 5"',
    'sh -lc \'cd x && gh pr merge 5\'',
    '/bin/zsh -c "gh pr merge 5"',
    'eval "gh pr merge 5"',
    'sudo -u me bash -c "gh pr merge 5"',
    'bash <<EOF\ngh pr merge 5\nEOF',
    'gh pr merge 5 <<EOF\ny\nEOF',
  ]) assert.equal(kinds(cmd), 'pr-merge', cmd);
});

test('quoted and heredoc data is not a command', () => {
  for (const cmd of [
    'echo "gh pr merge is gated"',
    "grep -o 'denied `gh pr merge [0-9]* --merge` with reason' log",
    'gh issue comment 5 --body "then run gh pr merge 12"',
    "gh issue comment 5 --body-file - <<'EOF'\nrun `gh pr merge 12`; then gh workflow run db-migrate.yml\nEOF",
    'cat > notes.md <<EOF\ngh pr merge 12\nEOF\ngit status',
  ]) assert.equal(kinds(cmd), '', cmd);
});

test('ordinary commands pass', () => {
  for (const cmd of [
    'gh workflow list',
    'gh workflow run ci.yml --ref main',
    'gh workflow run not-db-migrate.yml',
    'gh run list --workflow db-migrate.yml',
    'gh workflow view db-migrate.yml',
    'gh pr view 412 --json baseRefName',
    'gh pr create --base release',
    'grep -r db-migrate.yml .',
    '',
  ]) assert.equal(kinds(cmd), '', cmd);
});

test('a gate with no pr-merge entry does not judge merges', () => {
  assert.equal(gatedCommands('gh pr merge 5', [{ kind: 'workflow-run', workflow: 'x' }]).length, 0);
});

test('cd targets resolve against the cwd and home', () => {
  assert.deepEqual(cdTargets('cd sub && gh pr merge 1; cd /abs', '/base'), ['/base/sub', '/abs']);
});

test('the phrase matcher takes the configured phrase', () => {
  assert.ok(phraseMatcher('ship it now').test('ship it now!'));
  assert.ok(!phraseMatcher('ship it now').test('ship it now please'));
  assert.ok(phraseMatcher('a.b').test('a.b') && !phraseMatcher('a.b').test('axb'), 'phrase is literal, not a regex');
});

// End to end: temp repos for the scope, a fake gh for the base lookup.
function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'deploy-gate-'));
  const repo = (name, config) => {
    const dir = join(tmp, name);
    mkdirSync(dir);
    execFileSync('git', ['init', '-q', dir]);
    if (config !== undefined) {
      mkdirSync(join(dir, '.winston'));
      writeFileSync(join(dir, '.winston', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    }
    return dir;
  };
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  // base = release for PR 1 (main when asked about another repo), main for PR 2, failure otherwise.
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\ncase "$*" in *other/repo*) echo main;; *" 1 "*) echo release;; *" 2 "*) echo main;; *) exit 1;; esac\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WINSTON_HOME: join(tmp, 'home') };
  const run = (input) => {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(input), env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  return {
    tmp, run,
    gated: repo('gated', { owner: 'Pat', deployGate: { phrase: 'approve production deploy', repo: 'acme/app', guarded: GUARDED } }),
    other: repo('other'),
    broken: repo('broken', '{ not json'),
    marker: (id) => join(tmp, 'home', 'state', 'deploy-approvals', id),
  };
}

const decision = (out) => out?.hookSpecificOutput?.permissionDecision ?? 'allow';

test('hook denies without approval, allows after the owner types the phrase', () => {
  const f = fixture();
  try {
    const bash = (command, cwd = f.gated, session_id = 's1', extra = {}) =>
      decision(f.run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id, cwd, tool_input: { command }, ...extra }));

    assert.equal(bash('gh workflow run db-migrate.yml --ref release'), 'deny');
    assert.equal(bash('gh pr merge 1 --merge'), 'deny');
    assert.equal(bash('gh pr merge 3 --merge'), 'deny', 'unknown base fails closed');
    assert.equal(bash('gh pr merge 2 --merge'), 'allow', 'unguarded base passes');
    assert.equal(bash('gh pr list'), 'allow');
    assert.equal(bash('gh pr merge 1 -R other/repo'), 'allow', '-R aimed away from the gate repo passes');
    assert.equal(bash('gh pr merge 1 -R acme/app'), 'deny');
    assert.equal(bash('gh pr merge 1 --merge', f.other), 'allow', 'a repo without a deployGate is out of scope');
    assert.equal(bash(`cd ${f.gated} && gh pr merge 1`, f.other), 'deny', 'cd into a gated repo brings it into scope');
    assert.equal(bash('gh pr merge 1', f.broken), 'deny', 'unreadable config fails closed on a gated command');
    assert.equal(bash('gh pr list', f.broken), 'allow', 'unreadable config still passes ordinary commands');
    // Codex: shell argv and exec_command shapes.
    assert.equal(bash('', f.gated, 's1', { tool_name: 'shell', turn_id: 't', tool_input: { command: ['bash', '-lc', 'gh pr merge 1'] } }), 'deny');
    assert.equal(bash('', f.gated, 's1', { tool_name: 'exec_command', turn_id: 't', tool_input: { cmd: 'gh pr merge 1' } }), 'deny');
    const reason = f.run({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: f.gated, tool_input: { command: 'gh pr merge 1' } })
      .hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /approve production deploy/);
    assert.match(reason, /Pat's approval/);

    assert.equal(f.run({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: f.gated, prompt: 'ok, go' }), null);
    assert.ok(!existsSync(f.marker('s1')));
    assert.equal(f.run({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: f.other, prompt: 'approve production deploy' }), null, 'no gate, no marker');
    assert.ok(!existsSync(f.marker('s1')));
    const ack = f.run({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: f.gated, prompt: '  Approve Production Deploy\n' });
    assert.match(ack.hookSpecificOutput.additionalContext, /approved production deploys/);
    assert.ok(existsSync(f.marker('s1')));

    assert.equal(bash('gh workflow run db-migrate.yml --ref release'), 'allow');
    assert.equal(bash('gh pr merge 1 --merge'), 'allow');
    assert.equal(bash('gh pr merge 1 --merge', f.gated, 's2'), 'deny', 'approval is per session');
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test('only the whole prompt approves; the phrase inside anything else does not', () => {
  const f = fixture();
  try {
    const submit = (prompt) => f.run({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: f.gated, prompt });
    const denial = f.run({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: f.gated, tool_input: { command: 'gh pr merge 1' } })
      .hookSpecificOutput.permissionDecisionReason;
    for (const prompt of [
      'approve production deploy, thanks',
      'please approve production deploy',
      'approve production deploy now and merge',
      denial,
      `it said:\n${denial}`,
      '> approve production deploy',
      '```\napprove production deploy\n```',
      'approve production deploy\nand also do more',
      'approve production deploy?',
      '',
    ]) {
      assert.equal(submit(prompt), null, prompt);
      assert.ok(!existsSync(f.marker('s1')), prompt);
    }
    for (const prompt of ['approve production deploy', '  APPROVE Production Deploy \n', '"approve production deploy"', "'approve production deploy.'", 'approve production deploy!']) {
      rmSync(f.marker('s1'), { force: true });
      assert.ok(submit(prompt), prompt);
      assert.ok(existsSync(f.marker('s1')), prompt);
    }
  } finally {
    rmSync(f.tmp, { recursive: true, force: true });
  }
});
