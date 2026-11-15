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
// lesser fault next to a shared-checkout guard that never runs.
import { readFileSync } from 'node:fs';
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

/** Names of chattr plugins enabled in Codex config.toml text. */
export function codexPluginsEnabled(toml) {
  const names = [];
  let current = null;
  for (const raw of String(toml ?? '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      if (current) names.push(current.name);
      const m = header[1].trim().match(/^plugins\.(?:"(chattr@[^"]+)"|'(chattr@[^']+)')$/);
      current = m ? { name: m[1] ?? m[2] } : null;
      continue;
    }
    if (current && /^enabled\s*=\s*false$/.test(line)) current = null;
  }
  if (current) names.push(current.name);
  return names;
}

/** Where each CLI keeps the files read here. */
export function configPaths(env = process.env) {
  const home = env.HOME || homedir();
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  return {
    claudeSettings: path.join(claude, 'settings.json'),
    codexConfig: path.join(codex, 'config.toml'),
    codexHooks: path.join(codex, 'hooks.json'),
  };
}

/** Why the bundled chattr hooks must not run for this CLI, or null when they should. */
export function standDownReason(kind, env = process.env) {
  const paths = configPaths(env);
  if (kind === 'codex') {
    const enabled = codexPluginsEnabled(read(paths.codexConfig));
    if (enabled.length) return `the separate ${enabled[0]} plugin is enabled in ${paths.codexConfig}`;
    if (legacyCommands(json(paths.codexHooks)).length) return `old chattr install.sh hooks are registered in ${paths.codexHooks}`;
    return null;
  }
  const settings = json(paths.claudeSettings);
  const enabled = Object.entries(settings?.enabledPlugins ?? {}).filter(([name, on]) => on === true && name.startsWith('chattr@'));
  if (enabled.length) return `the separate ${enabled[0][0]} plugin is enabled in ${paths.claudeSettings}`;
  if (legacyCommands(settings).length) return `old chattr install.sh hooks are registered in ${paths.claudeSettings}`;
  return null;
}
