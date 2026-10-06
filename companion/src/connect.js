// `browser-feedback connect` (PRD §14.2): maps the current project to its
// localhost origin, installs the native messaging host and offers to register
// the MCP server with the user's agent. Writes nothing into the project.
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_NAME, MCP_SERVER_NAME, DEFAULT_EXTENSION_IDS, VERSION } from './constants.js';
import { dataDir, files } from './paths.js';
import { ensureDataDir, loadProjects, saveProjects, normalizeOrigin } from './store.js';
import { describeProject, runningPorts, COMMON_PORTS, findAgents } from './detect.js';
import { slashCommandBody } from './format.js';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

export async function connect(opts) {
  const io = createPrompter(opts);
  try {
    ensureDataDir();
    const facts = describeProject(opts.cwd || process.cwd());
    const { localPath, workingDirectory, id } = facts;
    const name = opts.name || facts.name;
    const hinted = facts.defaultPort;
    const candidates = [...new Set([hinted, ...COMMON_PORTS].filter(Boolean))];
    const running = await runningPorts(candidates);
    let origin = opts.origin ? normalizeOrigin(opts.origin) : null;
    if (opts.origin && !origin) throw new Error(`Invalid --origin ${opts.origin}`);
    if (!origin) {
      const guess = running.includes(hinted) ? hinted : running.length === 1 ? running[0] : hinted || running[0] || 3000;
      const answer = await io.ask(`App URL${running.length ? ` (running: ${running.map((p) => `localhost:${p}`).join(', ')})` : ''}`, `http://localhost:${guess}`);
      origin = normalizeOrigin(answer);
      if (!origin) throw new Error(`Invalid URL ${answer}`);
    }
    const agents = findAgents();

    io.print('');
    io.print(`Project detected:   ${name}`);
    io.print(`Path:               ${localPath}`);
    if (workingDirectory !== localPath) io.print(`Working directory:  ${workingDirectory}`);
    io.print(`Framework:          ${facts.framework || 'unknown'}`);
    io.print(`App:                ${origin}${running.includes(Number(new URL(origin).port)) ? '' : '  (not running right now)'}`);
    io.print(`Agents found:       ${agents.map((a) => a.name).join(', ') || 'none on PATH'}`);
    io.print(`Mode:               Attach — use your own agent session (any MCP agent)`);
    io.print('');
    if (!(await io.confirm('Connect this project?', true, { nonInteractive: true }))) { io.print('Cancelled.'); return { cancelled: true }; }

    // 1. Runtime + native messaging host
    const { app, manifestPaths } = installMachine(opts);

    // 2. Project mapping (stored in the data directory, never in the project)
    const projects = loadProjects();
    for (const p of projects) if (p.id !== id) p.origins = (p.origins || []).filter((o) => o !== origin);
    const existing = projects.find((p) => p.id === id);
    const project = {
      ...(existing || {}),
      id,
      name,
      localPath,
      workingDirectory,
      origins: [...new Set([origin, ...(existing?.origins || [])])],
      framework: facts.framework,
      agentMode: 'attach',
      devCommandHint: facts.devCommandHint,
      connectedAt: existing?.connectedAt || new Date().toISOString(),
    };
    saveProjects([...projects.filter((p) => p.id !== id), project]);

    io.print('');
    io.print(`✓ Project saved     ${files.projects()}`);
    for (const m of manifestPaths) io.print(`✓ Native host       ${m}`);

    // 3. Agent registration (user-level, with confirmation)
    const mcpCommand = [process.execPath, path.join(app, 'bin', 'browser-feedback.js'), 'mcp'];
    const claude = agents.find((a) => a.bin === 'claude');
    if (claude && !opts.skipAgent) await registerClaude(io, claude.path, mcpCommand);
    printManualSetup(io, mcpCommand, { hasClaude: !!claude });

    io.print('');
    io.print('Next:');
    io.print(`  1. Load the extension in Chrome (chrome://extensions → Load unpacked) and open ${origin}`);
    io.print('  2. In your agent session run /ui-review (or ask it to call wait_for_review)');
    io.print('  3. Alt+click elements, write comments, press Fix all');
    return { project, manifestPaths };
  } finally {
    io.close();
  }
}

// Machine-level install shared by `setup` and `connect`.
export function installMachine({ extensionIds = [], browserDirs = [] } = {}) {
  ensureDataDir();
  const app = installRuntime();
  const launcher = writeLauncher(app);
  const ids = [...new Set([...extensionIds, ...DEFAULT_EXTENSION_IDS])];
  const manifestPaths = installNativeHost(launcher, ids, browserDirs);
  return { app, launcher, manifestPaths, mcpCommand: [process.execPath, path.join(app, 'bin', 'browser-feedback.js'), 'mcp'] };
}

export function installRuntime() {
  const app = files.app();
  if (path.resolve(app) === PACKAGE_ROOT) return app;
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true, mode: 0o700 });
  for (const part of ['bin', 'src', 'package.json']) cpSync(path.join(PACKAGE_ROOT, part), path.join(app, part), { recursive: true });
  if (process.platform !== 'win32') chmodSync(path.join(app, 'bin', 'browser-feedback.js'), 0o755);
  writeFileSync(path.join(app, 'VERSION'), `${VERSION}\n`);
  return app;
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Chrome starts the host without the user's shell environment, so the launcher
// pins the absolute node path and a snapshot of PATH (PRD §10.2).
export function writeLauncher(app) {
  const file = files.hostLauncher();
  const entry = path.join(app, 'bin', 'browser-feedback.js');
  if (process.platform === 'win32') {
    const home = process.env.BROWSER_FEEDBACK_HOME ? `set "BROWSER_FEEDBACK_HOME=${process.env.BROWSER_FEEDBACK_HOME}"\r\n` : '';
    writeFileSync(file, `@echo off\r\n${home}"${process.execPath}" "${entry}" host %*\r\n`);
  } else {
    const lines = [
      '#!/bin/sh',
      '# Generated by `browser-feedback connect`. Chrome starts this as the native messaging host.',
      `export PATH=${shq(process.env.PATH || '/usr/bin:/bin')}`,
      process.env.BROWSER_FEEDBACK_HOME ? `export BROWSER_FEEDBACK_HOME=${shq(process.env.BROWSER_FEEDBACK_HOME)}` : null,
      `exec ${shq(process.execPath)} ${shq(entry)} host "$@"`,
    ].filter(Boolean);
    writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  return file;
}

export function nativeHostDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Arc/User Data']
      .map((d) => ({ dir: path.join(base, d, 'NativeMessagingHosts'), required: d === 'Google/Chrome' }));
  }
  if (process.platform === 'linux') {
    const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge']
      .map((d) => ({ dir: path.join(base, d, 'NativeMessagingHosts'), required: d === 'google-chrome' }));
  }
  return [];
}

export function installNativeHost(launcher, extensionIds, extraDirs = []) {
  const manifest = {
    name: HOST_NAME,
    description: 'Browser Feedback companion',
    path: launcher,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(files.hostManifest(), body, { mode: 0o644 });
  const written = [];
  if (process.platform === 'win32') {
    for (const key of ['Google\\Chrome', 'Chromium', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser']) {
      try {
        execFileSync('reg', ['add', `HKCU\\Software\\${key}\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', files.hostManifest(), '/f'], { stdio: 'ignore' });
        written.push(`HKCU\\Software\\${key}\\NativeMessagingHosts\\${HOST_NAME}`);
      } catch {}
    }
  }
  const dirs = [...nativeHostDirs(), ...extraDirs.map((dir) => ({ dir, required: true }))];
  for (const { dir, required } of dirs) {
    if (!required && !existsSync(path.dirname(dir))) continue;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${HOST_NAME}.json`);
    writeFileSync(file, body, { mode: 0o644 });
    written.push(file);
  }
  return written;
}

export async function registerClaude(io, claudePath, mcpCommand) {
  let registered = false;
  try { execFileSync(claudePath, ['mcp', 'get', MCP_SERVER_NAME], { stdio: 'ignore', timeout: 15_000 }); registered = true; } catch {}
  if (registered) {
    io.print(`✓ Claude Code       MCP server "${MCP_SERVER_NAME}" already registered`);
  } else if (await io.confirm(`Register the MCP server with Claude Code (user scope: claude mcp add --scope user ${MCP_SERVER_NAME})?`, true)) {
    try {
      execFileSync(claudePath, ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', ...mcpCommand], { stdio: 'ignore', timeout: 30_000 });
      io.print(`✓ Claude Code       MCP server "${MCP_SERVER_NAME}" registered`);
    } catch (err) {
      io.print(`! Could not run claude mcp add: ${err.message}`);
    }
  }
  const commandFile = path.join(os.homedir(), '.claude', 'commands', 'ui-review.md');
  if (!existsSync(commandFile) && await io.confirm(`Add the /ui-review command to Claude Code (${commandFile})?`, true)) {
    mkdirSync(path.dirname(commandFile), { recursive: true });
    writeFileSync(commandFile, slashCommandBody());
    io.print(`✓ Claude Code       /ui-review command added`);
  }
}

export function printManualSetup(io, mcpCommand, { hasClaude }) {
  const [command, ...args] = mcpCommand;
  io.print('');
  io.print('Other MCP agents — add this server to their config:');
  io.print(`  command: ${command}`);
  io.print(`  args:    ${JSON.stringify(args)}`);
  io.print('  Codex (~/.codex/config.toml):');
  io.print(`    [mcp_servers.${MCP_SERVER_NAME}]`);
  io.print(`    command = ${JSON.stringify(command)}`);
  io.print(`    args = ${JSON.stringify(args)}`);
  io.print('    tool_timeout_sec = 3600   # wait_for_review blocks until you press Fix all');
  if (!hasClaude) io.print(`  Claude Code: claude mcp add --scope user ${MCP_SERVER_NAME} -- ${mcpCommand.map((s) => (/\s/.test(s) ? JSON.stringify(s) : s)).join(' ')}`);
}

export function createPrompter({ yes = false, input = process.stdin, output = process.stdout } = {}) {
  const interactive = !yes && input.isTTY;
  const rl = interactive ? createInterface({ input, output }) : null;
  return {
    print: (s) => output.write(`${s}\n`),
    async ask(question, fallback) {
      if (!rl) return fallback;
      const a = (await rl.question(`${question} [${fallback}]: `)).trim();
      return a || fallback;
    },
    // Without a TTY only essential steps proceed; config changes need --yes.
    async confirm(question, fallback, { nonInteractive = false } = {}) {
      if (yes) return true;
      if (!rl) return nonInteractive;
      const a = (await rl.question(`${question} ${fallback ? 'Y/n' : 'y/N'} `)).trim().toLowerCase();
      return a ? a.startsWith('y') : fallback;
    },
    close: () => rl?.close(),
  };
}

export function disconnect({ cwd = process.cwd() } = {}) {
  const projects = loadProjects();
  const dir = path.resolve(cwd);
  const keep = projects.filter((p) => p.workingDirectory !== dir && p.localPath !== dir);
  saveProjects(keep);
  return projects.length - keep.length;
}

export { dataDir };
