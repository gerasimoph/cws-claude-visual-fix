const prompt = globalThis.BFOnboarding.installPrompt(chrome.runtime.id);
const $ = (id) => document.getElementById(id);
$('prompt').textContent = prompt;
$('copy').onclick = async () => {
  await navigator.clipboard.writeText(prompt);
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
};

function show(companion) {
  const ok = companion?.state === 'connected';
  $('step-companion').className = `step${ok ? ' done' : ''}`;
  $('step-companion').querySelector('.mark').textContent = ok ? '✓' : '+';
  $('status').className = `status${ok ? ' ok' : ''}`;
  $('status').textContent = ok ? 'Local helper connected — Fix all is available.' : 'Not installed — copy mode works without it. This page updates by itself once it is.';
}

// Keep trying while the page is open: once `setup` has run, the next
// attempt connects to the freshly installed native host.
async function tick() {
  const res = await chrome.runtime.sendMessage({ type: 'companion.ensure' }).catch(() => null);
  const { companion } = await chrome.storage.local.get('companion');
  show(companion);
  if (!res?.ok) setTimeout(tick, 2000);
}
chrome.storage.onChanged.addListener((changes) => { if (changes.companion) show(changes.companion.newValue); });
tick();
