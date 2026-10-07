// User-level Claude Code configuration written by `setup`: the doorbell hooks
// in settings.json and the /ui-review command. Always merged, never replaced,
// with a backup of settings.json next to it.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = 'browser-feedback.js';
const WAKE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
export const HOOK_TIMEOUT_SECONDS = 86_400;

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function hookCommands(nodePath, entry) {
  const base = `${shq(nodePath)} ${shq(entry)} doorbell`;
  return { wake: base, end: `${base} --end` };
}

function isOurs(group) {
  return (group?.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARK));
}

export function installHooks({ nodePath, entry, settingsPath = path.join(claudeDir(), 'settings.json') }) {
  let settings = {};
  if (existsSync(settingsPath)) {
    const text = readFileSync(settingsPath, 'utf8');
    try { settings = text.trim() ? JSON.parse(text) : {}; }
    catch { throw new Error(`${settingsPath} is not valid JSON — hooks not installed`); }
    copyFileSync(settingsPath, `${settingsPath}.bak-browser-feedback`);
  }
  const cmd = hookCommands(nodePath, entry);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const event of [...WAKE_EVENTS, 'SessionEnd']) {
    const kept = (settings.hooks[event] || []).filter((g) => !isOurs(g));
    const ours = event === 'SessionEnd'
      ? { hooks: [{ type: 'command', command: cmd.end, timeout: 10 }] }
      : { hooks: [{ type: 'command', command: cmd.wake, asyncRewake: true, timeout: HOOK_TIMEOUT_SECONDS }] };
    settings.hooks[event] = [...kept, ours];
  }
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, settingsPath);
  return settingsPath;
}

export function uninstallHooks({ settingsPath = path.join(claudeDir(), 'settings.json') } = {}) {
  if (!existsSync(settingsPath)) return false;
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (!settings.hooks) return false;
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter((g) => !isOurs(g));
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

export function writeSlashCommand(body, file = path.join(claudeDir(), 'commands', 'ui-review.md')) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}
