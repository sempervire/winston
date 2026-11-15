// chattr uninstall-hooks [--dry-run|--snapshot <dir>] [--home <dir>]
// chattr is part of Winston, whose plugin hooks/hooks.json registers its hooks. Before that, chattr's
// install.sh wrote the same hooks by absolute path into ~/.claude/settings.json and ~/.codex/hooks.json;
// with Winston installed those would run a second time (Winston's bundled copies stand down while
// they exist, see standdown.mjs). This removes only chattr's own registrations from those two files
// and touches nothing else. Nothing is written without --snapshot, which receives a copy of every
// overwritten file. composedHooks/compose describe what the old installer wrote, for tests.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// worktree-setup.sh is deliberately absent: chattr does not install it, so it keeps any registration it finds.
export const OWNED = /worktree-guard\.mjs|worktree-session-start\.mjs|(agentbus|chattr)\.mjs"? hook /;
// A standalone browser-tab-guard registration is never touched: Winston registers it as its own Stop hook.
const REPLACED = new RegExp(`agent-notify\\.sh|herdr-agent-state\\.sh|${OWNED.source}`);
const GUARD_DENY = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"worktree-guard could not run, so another session sharing this checkout cannot be ruled out. Blocking by design (fail closed). Move to a worktree, or set CLAUDE_ALLOW_SHARED_CWD=1 to share deliberately."}}`;

const group = (command, extra = {}, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 10, ...extra }] });

/** The composed hook groups for one CLI, by event. */
export function composedHooks(kind, root) {
  const bus = (event) => `node "${root}/chattr.mjs" hook ${event} --agent ${kind}`;
  const hook = (event, matcher, extra) => group(bus(event), extra, matcher);
  const guard = group(`CHATTR_BIN="${root}/chattr.mjs" node "${root}/hooks/worktree-guard.mjs" || echo '${GUARD_DENY}'`,
    { statusMessage: 'Checking for other sessions in this directory' }, kind === 'claude' ? 'Edit|Write|NotebookEdit' : '^(apply_patch|Edit|Write)$');
  const sessionStart = group(`CHATTR_BIN="${root}/chattr.mjs" node "${root}/hooks/worktree-session-start.mjs"`, { statusMessage: 'Checking for another session in this directory' });
  const stop = hook('Stop', undefined, { timeout: 20, statusMessage: 'chattr: message delivery' });
  if (kind === 'claude') {
    return {
      SessionStart: [hook('SessionStart'), sessionStart],
      UserPromptSubmit: [hook('UserPromptSubmit')],
      PreToolUse: [guard, hook('PreToolUse', '^AskUserQuestion$')],
      PostToolUse: [hook('PostToolUse')],
      Stop: [stop],
      StopFailure: [hook('StopFailure')],
      Notification: [hook('Notification', 'permission_prompt|elicitation_dialog')],
    };
  }
  return {
    SessionStart: [hook('SessionStart'), sessionStart],
    UserPromptSubmit: [hook('UserPromptSubmit')],
    PreToolUse: [guard, hook('PreToolUse', '^request_user_input(_async)?$')],
    PostToolUse: [hook('PostToolUse')],
    PermissionRequest: [hook('PermissionRequest')],
    Stop: [stop],
    Interrupt: [hook('Interrupt')],
  };
}

/** Drop every hook whose command matches `pattern`, and any group or event left empty. Pure. */
export function strip(config, pattern = OWNED) {
  const hooks = {};
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    const kept = groups.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !pattern.test(h.command ?? '')) })).filter((g) => g.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  return { ...config, hooks };
}

/** Remove every replaced registration, then append the composed groups. Pure; idempotent. */
export function compose(config, kind, root) {
  const { hooks } = strip(config, REPLACED);
  for (const [event, groups] of Object.entries(composedHooks(kind, root))) hooks[event] = [...(hooks[event] ?? []), ...groups];
  return { ...config, hooks };
}

function diff(label, before, after) {
  const dir = mkdtempSync(path.join(tmpdir(), 'chattr-install-'));
  writeFileSync(path.join(dir, 'a'), before);
  writeFileSync(path.join(dir, 'b'), after);
  const out = spawnSync('diff', ['-u', '--label', `${label} (current)`, '--label', `${label} (composed)`, path.join(dir, 'a'), path.join(dir, 'b')], { encoding: 'utf8' });
  return out.stdout || `${label}: no changes\n`;
}

export async function install(argv, log = (s) => process.stdout.write(s)) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  if (!flag('uninstall')) {
    log('chattr is part of Winston: the Winston plugin registers its hooks. Only `chattr uninstall-hooks` remains, to remove the old installer\'s registrations.\n');
    return 2;
  }
  const home = path.resolve(value('home') ?? process.env.HOME ?? homedir());
  // --home names a whole fixture home; without it, CLAUDE_CONFIG_DIR and CODEX_HOME are honoured.
  const env = value('home') ? {} : process.env;
  const dryRun = flag('dry-run');
  const snapshot = value('snapshot');
  if (!dryRun && !snapshot) {
    log('chattr uninstall-hooks: pass --snapshot <dir> (receives a copy of every file it overwrites) or --dry-run\n');
    return 2;
  }
  const files = legacyHookFiles(home, env).map(({ file }) => {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '{}\n';
    const config = JSON.parse(before);
    return { file, after: `${JSON.stringify(strip(config), null, 2)}\n`, pretty: `${JSON.stringify(config, null, 2)}\n` };
  });
  const changed = files.filter((f) => existsSync(f.file) && f.after !== f.pretty);
  for (const f of files) log(diff(f.file, f.pretty, existsSync(f.file) ? f.after : f.pretty));
  if (dryRun) { log('dry run: nothing written.\n'); return 0; }
  for (const f of changed) {
    const rel = path.relative(home, f.file);
    const copy = path.join(snapshot, rel.startsWith('..') || path.isAbsolute(rel) ? f.file.replace(/^\/+/, '') : rel);
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(f.file, copy);
    writeFileSync(f.file, f.after);
  }
  log(`removed chattr hook registrations from ${changed.length} file(s)\n`);
  return 0;
}

/** The two files the old installer wrote hooks into, for `home` (CLAUDE_CONFIG_DIR and CODEX_HOME in `env` win). */
export function legacyHookFiles(home = homedir(), env = {}) {
  return [
    { kind: 'claude', file: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json') },
    { kind: 'codex', file: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json') },
  ];
}

/** Commands of the old installer's chattr registrations in one parsed hooks config. Pure. */
export function legacyCommands(config) {
  return Object.values(config?.hooks ?? {}).flat().flatMap((g) => g?.hooks ?? []).map((h) => h?.command ?? '').filter((c) => OWNED.test(c));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(`chattr uninstall-hooks: ${error.message}`); process.exitCode = 1; });
}
