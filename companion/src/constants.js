export const VERSION = '0.2.1';
export const PRODUCT = 'browser-feedback';
export const HOST_NAME = 'com.browser_feedback.companion';
export const MCP_SERVER_NAME = 'browser-feedback';

// Derived from the "key" in extension/manifest.json (see scripts/extension-id.mjs).
// A Chrome Web Store build gets its own ID; pass --extension-id to `connect` for it.
export const DEFAULT_EXTENSION_IDS = ['diidngfppbepogdmihpnfhfekeemedme'];

// Statuses of an annotation (PRD §25). `open` lives only in the extension.
export const STATUS = Object.freeze({
  OPEN: 'open',
  QUEUED: 'queued',
  WORKING: 'working',
  VERIFYING: 'verifying',
  FIXED: 'fixed',
  CHANGED_CHECK: 'changed_check',
  NO_CHANGE: 'no_change',
  FAILED: 'failed',
  ACCEPTED: 'accepted',
});

export const FINAL_STATUSES = new Set([STATUS.FIXED, STATUS.CHANGED_CHECK, STATUS.NO_CHANGE, STATUS.FAILED, STATUS.ACCEPTED]);
