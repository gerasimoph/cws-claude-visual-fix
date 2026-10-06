// The one line a user pastes into Claude Code to finish setup. Plain script
// shared by content scripts, the popup and the welcome page.
(function (root) {
  'use strict';
  const REPO = 'gerasimoph/cws-claude-visual-fix';
  function installPrompt(extensionId) {
    return `Set up Browser Feedback for Coding Agents on this machine by following https://github.com/${REPO}/blob/HEAD/INSTALL.md (Chrome extension id: ${extensionId}). If you can't open that link, run: npx -y github:${REPO} setup --yes --extension-id ${extensionId}`;
  }
  root.BFOnboarding = { installPrompt, REPO };
})(globalThis);
