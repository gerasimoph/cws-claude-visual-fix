const CONNECT_CMD = 'npx github:gerasimoph/cws-claude-visual-fix connect';
const DEFAULT_ORIGINS = ['http://localhost', 'http://127.0.0.1', 'https://localhost'];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let origin = null;
try { origin = /^https?:/.test(tab?.url) ? new URL(tab.url).origin : null; } catch {}
const hostOnly = origin ? `${new URL(origin).protocol}//${new URL(origin).hostname}` : null;

async function enabledHere() {
  if (!origin) return false;
  if (DEFAULT_ORIGINS.includes(hostOnly)) return true;
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

async function devServerUp(o) {
  try {
    await fetch(o, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(1500) });
    return true;
  } catch { return false; }
}

function copyButton(text) {
  const b = document.createElement('button');
  b.className = 'link';
  b.textContent = 'Copy';
  b.onclick = async () => { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; };
  return b;
}

async function render() {
  const companion = await chrome.runtime.sendMessage({ type: 'companion.status' });
  const enabled = await enabledHere();
  const project = (companion.projects || []).find((p) => (p.origins || []).includes(origin));

  $('dot').className = `dot ${companion.state === 'connected' ? 'ok' : companion.state === 'not_installed' ? 'warn' : 'error'}`;
  $('version').textContent = companion.version ? `companion ${companion.version}` : '';

  // This tab
  const tabEl = $('tab');
  if (!origin) {
    tabEl.innerHTML = '<span class="muted">Open your app (e.g. localhost:3000) to leave comments.</span>';
  } else if (!enabled) {
    tabEl.innerHTML = `<div>${esc(origin)}</div><div class="muted">Comments are enabled on localhost by default.</div><button id="enable">Enable on this site</button>`;
    $('enable').onclick = async () => {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (granted) await chrome.runtime.sendMessage({ type: 'site.enable', tabId: tab.id });
      render();
    };
  } else if (project) {
    const agent = companion.agents?.[project.id];
    tabEl.innerHTML = `<div><strong>${esc(project.name)}</strong> <span class="muted">${esc(origin)}</span></div><div class="muted">${agent === 'waiting' ? 'Agent waiting for Fix all' : agent === 'working' ? 'Agent working' : 'No agent attached — run /ui-review in your agent'}</div>`;
  } else {
    tabEl.innerHTML = `<div><strong>Project not connected</strong> <span class="muted">${esc(origin)}</span></div><div class="muted">Connect to let your agent fix comments:</div><code>${esc(CONNECT_CMD)}</code>`;
    tabEl.querySelector('code').after(copyButton(CONNECT_CMD));
  }
  $('select').disabled = !enabled;
  $('panel').disabled = !enabled;

  // Companion
  const comp = $('companion');
  if (companion.state === 'connected') comp.innerHTML = '';
  else if (companion.state === 'not_installed') {
    comp.innerHTML = `<div>Local companion isn't installed.</div><div class="muted">Comments and Copy as Markdown work without it. To let your agent fix comments, run in your project:</div><code>${esc(CONNECT_CMD)}</code><button id="retry">Retry</button>`;
  } else {
    comp.innerHTML = `<div>Local companion isn't connected.</div><div class="muted">${esc(companion.error || '')}</div><button id="retry">Reconnect</button>`;
  }
  $('retry')?.addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'companion.reconnect' }); render(); });

  // Projects + dev server status (PRD §15) — the extension only detects it.
  const projEl = $('projects');
  const projects = companion.projects || [];
  if (!projects.length) { projEl.innerHTML = ''; return; }
  projEl.innerHTML = '<h3>Projects</h3>';
  for (const p of projects) {
    const o = p.origins?.[0];
    const row = document.createElement('div');
    row.className = 'project';
    row.innerHTML = `<span class="dot" data-o="${esc(o)}"></span><span class="name" title="${esc(p.workingDirectory)}">${esc(p.name)} <span class="muted">${esc(o ? new URL(o).host : '')}</span></span>`;
    projEl.appendChild(row);
    devServerUp(o).then((up) => {
      row.querySelector('.dot').className = `dot ${up ? 'ok' : ''}`;
      if (!up && p.devCommandHint) {
        const hint = document.createElement('div');
        hint.className = 'muted';
        hint.innerHTML = `${esc(p.name)} isn't running. <code>${esc(p.devCommandHint)}</code>`;
        hint.querySelector('code').after(copyButton(p.devCommandHint));
        row.after(hint);
      }
    });
  }
}

async function tabCommand(name) {
  const res = await chrome.runtime.sendMessage({ type: 'tab.command', tabId: tab.id, name });
  if (res?.ok === false) { $('tab').insertAdjacentHTML('beforeend', `<div class="muted">${esc(res.error)}</div>`); return; }
  window.close();
}

$('select').onclick = () => tabCommand('start-selecting');
$('panel').onclick = () => tabCommand('show-panel');
chrome.storage.onChanged.addListener((changes) => { if (changes.companion) render(); });
render();
