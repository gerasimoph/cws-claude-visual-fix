import net from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function findUp(start, name) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, name))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readPackage(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

const FRAMEWORKS = [
  ['next', 'Next.js', 3000],
  ['@remix-run/dev', 'Remix', 5173],
  ['@react-router/dev', 'React Router', 5173],
  ['astro', 'Astro', 4321],
  ['@sveltejs/kit', 'SvelteKit', 5173],
  ['nuxt', 'Nuxt', 3000],
  ['@angular/core', 'Angular', 4200],
  ['gatsby', 'Gatsby', 8000],
  ['react-scripts', 'Create React App', 3000],
  ['vite', 'Vite', 5173],
  ['webpack-dev-server', 'webpack', 8080],
  ['parcel', 'Parcel', 1234],
];

export function detectFramework(pkg) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  for (const [dep, name, port] of FRAMEWORKS) {
    if (deps[dep]) {
      const flavor = name === 'Vite' && deps.react ? 'Vite + React' : name === 'Vite' && deps.vue ? 'Vite + Vue' : name;
      return { name: flavor, defaultPort: port };
    }
  }
  return { name: null, defaultPort: null };
}

export function devCommand(pkg, dir) {
  const scripts = pkg?.scripts || {};
  const lockRoot = findUp(dir, 'package.json') && (findUp(dir, 'pnpm-lock.yaml') || findUp(dir, 'yarn.lock') || findUp(dir, 'bun.lockb') || findUp(dir, 'bun.lock'));
  const has = (name) => !!lockRoot && existsSync(path.join(lockRoot, name));
  const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun run' : 'npm run';
  for (const name of ['dev', 'start', 'serve']) if (scripts[name]) return { name, script: scripts[name], command: `${runner} ${name}` };
  return null;
}

export function portFromScript(script) {
  if (!script) return null;
  const m = /(?:--port[= ]|-p[= ]?|PORT=)(\d{2,5})/.exec(script);
  return m ? Number(m[1]) : null;
}

export const COMMON_PORTS = [3000, 3001, 5173, 5174, 4321, 8080, 8000, 4200, 4000, 5000, 1234];

export function probePort(port, timeoutMs = 300) {
  const tryHost = (host) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { clearTimeout(t); s.destroy(); resolve(ok); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  return tryHost('127.0.0.1').then((ok) => ok || tryHost('::1'));
}

export async function runningPorts(ports) {
  const results = await Promise.all(ports.map(async (p) => [p, await probePort(p)]));
  return results.filter(([, ok]) => ok).map(([p]) => p);
}

const AGENTS = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex CLI'],
  ['cursor-agent', 'Cursor CLI'],
  ['gemini', 'Gemini CLI'],
  ['opencode', 'opencode'],
];

export function findExecutable(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (statSync(file).isFile()) return file; } catch {}
    }
  }
  return null;
}

export function findAgents() {
  return AGENTS.map(([bin, name]) => ({ bin, name, path: findExecutable(bin) })).filter((a) => a.path);
}

// Project facts derived from a directory (PRD §13). Used by `connect` and to
// propose a project for an agent session started in that directory.
export function describeProject(dir) {
  const cwd = path.resolve(dir);
  const pkgDir = findUp(cwd, 'package.json');
  const pkg = pkgDir ? readPackage(pkgDir) : null;
  const gitRoot = findUp(cwd, '.git');
  const workingDirectory = pkgDir && pkgDir.startsWith(gitRoot || pkgDir) ? pkgDir : cwd;
  const framework = detectFramework(pkg);
  const dev = devCommand(pkg, pkgDir || cwd);
  return {
    id: `p_${createHash('sha1').update(workingDirectory).digest('hex').slice(0, 10)}`,
    name: pkg?.name || path.basename(workingDirectory),
    localPath: gitRoot || workingDirectory,
    workingDirectory,
    framework: framework.name,
    defaultPort: portFromScript(dev?.script) || framework.defaultPort,
    devCommandHint: dev?.command || null,
  };
}
