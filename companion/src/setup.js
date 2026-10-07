// `browser-feedback setup`: one-time, machine-level install. Usually run by
// the user's coding agent following INSTALL.md. Touches no project: projects
// are connected later from the browser when an agent runs inside one.
import { MCP_SERVER_NAME, VERSION } from './constants.js';
import { dataDir, socketPath } from './paths.js';
import { findAgents } from './detect.js';
import { canConnect } from './host.js';
import { installMachine, registerClaude, printManualSetup, createPrompter } from './connect.js';

export async function setup(opts = {}) {
  const io = createPrompter(opts);
  try {
    if (Number(process.versions.node.split('.')[0]) < 18) throw new Error(`Node ${process.versions.node} is too old — Node 18 or newer is required.`);
    io.print(`Browser Feedback companion ${VERSION} — setup`);
    const { manifestPaths, mcpCommand } = installMachine(opts);
    io.print(`✓ Installed         ${dataDir()}`);
    for (const m of manifestPaths) io.print(`✓ Native host       ${m}`);

    const agents = findAgents();
    const claude = agents.find((a) => a.bin === 'claude');
    if (claude && !opts.skipAgent) await registerClaude(io, claude.path, mcpCommand, { hooks: !opts.noHooks });
    else if (!claude) io.print('! Claude Code not found on PATH — register the MCP server with your agent manually (below).');
    printManualSetup(io, mcpCommand, { hasClaude: !!claude });

    const waitSeconds = opts.wait === undefined ? 20 : Number(opts.wait);
    let browser = await canConnect(socketPath());
    if (!browser && waitSeconds > 0) {
      io.print('');
      io.print(`Waiting up to ${waitSeconds}s for Chrome to connect (the extension retries while its setup page or a localhost tab is open)…`);
      const end = Date.now() + waitSeconds * 1000;
      while (!browser && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 1000));
        browser = await canConnect(socketPath());
      }
    }
    io.print('');
    io.print(`Browser connected: ${browser ? 'yes' : 'no'}`);
    if (!browser) {
      io.print('  The Chrome extension has not connected yet. Make sure it is installed, then click its toolbar icon');
      io.print('  or open any http://localhost page. Check again with:');
      io.print(`  ${mcpCommand[0]} ${mcpCommand[1]} status`);
    }
    io.print('');
    io.print('Next steps for the user:');
    io.print('  1. Restart Claude Code once, in the project folder (new MCP servers and hooks load at session start).');
    io.print('  2. Open the app (e.g. http://localhost:5173). The review panel offers to connect the page to that project.');
    io.print('  3. Alt+click an element, write a comment, press Enter. Then press Fix all: the review goes to that');
    io.print('     Claude Code session by itself. /ui-review in a session pins Fix all to it.');
    return { browser, manifestPaths, mcpServer: MCP_SERVER_NAME };
  } finally {
    io.close();
  }
}
