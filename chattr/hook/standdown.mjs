// Winston registers chattr's hooks itself. A machine that still has the separate chattr plugin
// enabled, or the old install.sh registrations, would run every one of them twice, so Winston's
// copies stand down until `winston doctor`'s removal steps are done. Hook commands in Winston's
// hooks/hooks.json pass `--bundled`; nothing else calls this.
//
// Read per CLI, because each CLI loads only its own config:
//   Claude Code  <CLAUDE_CONFIG_DIR or ~/.claude>/settings.json  enabledPlugins["chattr@…"] true, or old hooks
//   Codex        <CODEX_HOME or ~/.codex>/config.toml             [plugins."chattr@…"] not enabled = false
//                <CODEX_HOME or ~/.codex>/hooks.json              old hooks
// A file that is missing or does not parse counts as "no other chattr": running twice is the
// lesser fault next to a shared-checkout guard that never runs. For the same reason an enabled
// plugin counts only while its files are still on disk: Winston's marketplace no longer lists
// chattr, and a plugin left enabled after its copy is gone runs nothing, so Winston's must.
//   Claude Code  <config dir>/plugins/installed_plugins.json  an entry whose installPath exists
//                (no readable record: <config dir>/plugins/cache/<marketplace>/<plugin>/)
//   Codex        <CODEX_HOME>/plugins/cache/<marketplace>/chattr/
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { harness } from '../../lib/harness.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { legacyCommands } from './install.mjs';

/** Which CLI sent a hook payload: Codex sends turn_id, a rollout-*.jsonl transcript, or its own tool names. */
export function kindOf(input) {
  const transcript = path.basename(String(input?.transcript_path ?? ''));
  return harness(input) === 'codex' || transcript.startsWith('rollout-') ? 'codex' : 'claude';
}

/**
 * True when the owner turned the shared-checkout guard off: "sharedCheckoutGuard": false in the
 * repository's or the user's .winston/config.json (repo wins). A config that does not parse leaves it on.
 */
export function guardOff(cwd) {
  try {
    return loadConfig(cwd).sharedCheckoutGuard === false;
  } catch {
    return false;
  }
}

function read(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

function json(file) {
  const text = read(file);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const CHATTR_KEY = /^plugins\.(?:"(chattr@[^"]+)"|'(chattr@[^']+)')(?:\.enabled\s*=\s*(true|false)\b|\s*=\s*\{([^}]*)\}|$)/;

/**
 * Names of chattr plugins enabled in Codex config.toml text. A plugin is declared by a
 * [plugins."chattr@…"] table, a dotted key (plugins."chattr@…".enabled = …, at the top level or
 * under [plugins]), or an inline table (plugins = { "chattr@…" = { … } }, or under [plugins]);
 * a declared plugin is enabled unless it says enabled = false.
 */
export function codexPluginsEnabled(toml) {
  const state = new Map();
  let table = '';
  for (const raw of String(toml ?? '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[\s*([^\[\]]+?)\s*\]$/);
    if (header) {
      table = header[1].replace(/\s*\.\s*/g, '.');
      const m = table.match(CHATTR_KEY);
      if (m) state.set(m[1] ?? m[2], state.get(m[1] ?? m[2]) ?? true);
      continue;
    }
    const full = (table ? `${table}.${line}` : line).replace(/\s*\.\s*(?=["'\w])/g, '.');
    const m = full.match(CHATTR_KEY);
    if (m) {
      const name = m[1] ?? m[2];
      if (m[3]) state.set(name, m[3] === 'true');
      else if (m[4] !== undefined) state.set(name, !/\benabled\s*=\s*false\b/.test(m[4]));
      continue;
    }
    if (/^plugins\s*=\s*\{/.test(full)) {
      for (const x of full.matchAll(/(?:"(chattr@[^"]+)"|'(chattr@[^']+)')\s*=\s*\{([^}]*)\}/g)) state.set(x[1] ?? x[2], !/\benabled\s*=\s*false\b/.test(x[3]));
    }
  }
  return [...state].filter(([, on]) => on).map(([name]) => name);
}

/** Where each CLI keeps the files read here. */
export function configPaths(env = process.env) {
  const home = env.HOME || homedir();
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  return {
    claudeSettings: path.join(claude, 'settings.json'),
    claudeInstalled: path.join(claude, 'plugins', 'installed_plugins.json'),
    codexCache: path.join(codex, 'plugins', 'cache'),
    codexConfig: path.join(codex, 'config.toml'),
    codexHooks: path.join(codex, 'hooks.json'),
  };
}

/**
 * True while an enabled plugin's files are still on disk. Claude Code: an installed_plugins.json
 * entry whose installPath exists; without a readable record, its cache folder
 * (<config dir>/plugins/cache/<marketplace>/<plugin>). Codex: its cache folder.
 */
export function pluginPresent(kind, name, env = process.env) {
  const paths = configPaths(env);
  const [plugin, marketplace] = name.split('@');
  if (kind === 'codex') return existsSync(path.join(paths.codexCache, marketplace ?? '', plugin));
  const record = json(paths.claudeInstalled);
  if (!record?.plugins) return existsSync(path.join(paths.claudeInstalled, '..', 'cache', marketplace ?? '', plugin));
  return (record.plugins[name] ?? []).some((e) => typeof e?.installPath === 'string' && existsSync(e.installPath));
}

/** Enabled chattr plugins whose files are still on disk, for this CLI. */
export function separatePlugins(kind, env = process.env) {
  const paths = configPaths(env);
  const enabled = kind === 'codex'
    ? codexPluginsEnabled(read(paths.codexConfig))
    : Object.entries(json(paths.claudeSettings)?.enabledPlugins ?? {}).filter(([name, on]) => on === true && name.startsWith('chattr@')).map(([name]) => name);
  return enabled.filter((name) => pluginPresent(kind, name, env));
}

/** Why the bundled chattr hooks must not run for this CLI, or null when they should. */
export function standDownReason(kind, env = process.env) {
  const paths = configPaths(env);
  if (kind === 'codex') {
    const enabled = separatePlugins('codex', env);
    if (enabled.length) return `the separate ${enabled[0]} plugin is enabled in ${paths.codexConfig}`;
    if (legacyCommands(json(paths.codexHooks)).length) return `old chattr install.sh hooks are registered in ${paths.codexHooks}`;
    return null;
  }
  const settings = json(paths.claudeSettings);
  const enabled = separatePlugins('claude', env);
  if (enabled.length) return `the separate ${enabled[0]} plugin is enabled in ${paths.claudeSettings}`;
  if (legacyCommands(settings).length) return `old chattr install.sh hooks are registered in ${paths.claudeSettings}`;
  return null;
}
