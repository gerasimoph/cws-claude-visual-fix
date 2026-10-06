import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function dataDir() {
  return process.env.BROWSER_FEEDBACK_HOME || path.join(os.homedir(), '.browser-feedback');
}

// Local IPC endpoint between the native host and MCP processes. Never a TCP port.
export function socketPath() {
  if (process.platform === 'win32') {
    const tag = createHash('sha1').update(`${os.userInfo().username}:${dataDir()}`).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\browser-feedback-${tag}`;
  }
  return path.join(dataDir(), 'companion.sock');
}

export const files = {
  projects: () => path.join(dataDir(), 'projects.json'),
  reviews: () => path.join(dataDir(), 'reviews'),
  screenshots: () => path.join(dataDir(), 'screenshots'),
  metrics: () => path.join(dataDir(), 'metrics.jsonl'),
  log: () => path.join(dataDir(), 'companion.log'),
  app: () => path.join(dataDir(), 'app'),
  hostLauncher: () => path.join(dataDir(), process.platform === 'win32' ? 'native-host.cmd' : 'native-host.sh'),
  hostManifest: () => path.join(dataDir(), 'native-host.json'),
};
