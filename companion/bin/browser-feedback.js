#!/usr/bin/env node
import { VERSION, HOST_NAME } from '../src/constants.js';

const [command = 'help', ...rest] = process.argv.slice(2);

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (v !== undefined) out[key] = v;
    else if (args[i + 1] && !args[i + 1].startsWith('--')) out[key] = args[++i];
    else out[key] = true;
  }
  return out;
}

async function main() {
  switch (command) {
    case 'host': {
      const { runHost } = await import('../src/host.js');
      await runHost();
      break;
    }
    case 'mcp': {
      const { runMcp } = await import('../src/mcp.js');
      await runMcp();
      break;
    }
    case 'setup': {
      const f = flags(rest);
      const { setup } = await import('../src/setup.js');
      await setup({
        yes: !!f.yes,
        skipAgent: !!f.skipAgent,
        wait: f.wait,
        extensionIds: f.extensionId ? String(f.extensionId).split(',') : [],
        browserDirs: f.browserDir ? String(f.browserDir).split(',') : [],
      });
      break;
    }
    case 'connect': {
      const f = flags(rest);
      const { connect } = await import('../src/connect.js');
      await connect({
        yes: !!f.yes,
        origin: f.origin,
        name: f.name,
        skipAgent: !!f.skipAgent,
        extensionIds: f.extensionId ? String(f.extensionId).split(',') : [],
        browserDirs: f.browserDir ? String(f.browserDir).split(',') : [],
      });
      break;
    }
    case 'disconnect': {
      const { disconnect } = await import('../src/connect.js');
      console.log(`Removed ${disconnect()} project mapping(s) for ${process.cwd()}`);
      break;
    }
    case 'status': {
      const { loadProjects } = await import('../src/store.js');
      const { canConnect } = await import('../src/host.js');
      const { dataDir, socketPath } = await import('../src/paths.js');
      console.log(`browser-feedback ${VERSION}`);
      console.log(`Data directory: ${dataDir()}`);
      console.log(`Browser connected: ${(await canConnect(socketPath())) ? 'yes' : 'no'}`);
      const projects = loadProjects();
      if (!projects.length) console.log('No projects connected. Run `browser-feedback connect` in a project directory.');
      for (const p of projects) console.log(`• ${p.name}  ${p.origins.join(', ')}  ${p.workingDirectory}`);
      break;
    }
    case 'stats': {
      const { readStats } = await import('../src/stats.js');
      console.log(JSON.stringify(readStats(), null, 2));
      break;
    }
    case 'version':
    case '--version':
      console.log(VERSION);
      break;
    default:
      console.log(`browser-feedback ${VERSION} — local companion for Browser Feedback for Coding Agents

Usage:
  browser-feedback setup [--yes] [--extension-id ID] [--wait SECONDS]
                                 One-time install on this machine (see INSTALL.md)
  browser-feedback connect [--origin URL] [--name NAME] [--yes] [--extension-id ID]
                                 Connect the project in the current directory
  browser-feedback disconnect    Remove the mapping for the current directory
  browser-feedback status        Show connected projects and browser state
  browser-feedback stats         Local review metrics (no content)
  browser-feedback mcp           MCP server (started by your coding agent)
  browser-feedback host          Native messaging host (${HOST_NAME}, started by Chrome)`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
