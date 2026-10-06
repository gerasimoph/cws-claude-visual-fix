// Deterministic verification (PRD §27). Pure functions over element
// "signatures" captured by the extension, so they are testable in Node.
import { STATUS } from './constants.js';

const REMOVAL_INTENT = /\b(remove|delete|hide|get rid of|drop|take out)\b|убер|удал|скры|спряч/i;

export function hasRemovalIntent(instruction) {
  return REMOVAL_INTENT.test(instruction || '');
}

const GEOMETRY_TOLERANCE_PX = 0.5;

// Returns { changed, diffs: [{ prop, before, after }] } between two signatures.
export function compareSignatures(before, after) {
  const diffs = [];
  if (!before || !after) return { changed: false, diffs };
  if (!!before.found !== !!after.found) {
    diffs.push({ prop: 'element', before: before.found ? 'present' : 'missing', after: after.found ? 'present' : 'missing' });
    return { changed: true, diffs };
  }
  if (!after.found) return { changed: false, diffs };

  for (const key of ['width', 'height', 'x', 'y']) {
    const b = before.rect?.[key];
    const a = after.rect?.[key];
    if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) > GEOMETRY_TOLERANCE_PX) {
      diffs.push({ prop: key, before: `${round(b)}px`, after: `${round(a)}px` });
    }
  }
  const styleKeys = new Set([...Object.keys(before.styles || {}), ...Object.keys(after.styles || {})]);
  for (const key of styleKeys) {
    const b = before.styles?.[key];
    const a = after.styles?.[key];
    if (b !== a) diffs.push({ prop: key, before: b ?? '', after: a ?? '' });
  }
  if ((before.text || '') !== (after.text || '')) diffs.push({ prop: 'text', before: before.text || '', after: after.text || '' });
  if ((before.classes || '') !== (after.classes || '')) diffs.push({ prop: 'class', before: before.classes || '', after: after.classes || '' });
  if (before.visible !== after.visible) diffs.push({ prop: 'visible', before: String(before.visible), after: String(after.visible) });
  if (before.childCount !== after.childCount) diffs.push({ prop: 'children', before: String(before.childCount), after: String(after.childCount) });
  const attrKeys = new Set([...Object.keys(before.attrs || {}), ...Object.keys(after.attrs || {})]);
  for (const key of attrKeys) {
    if ((before.attrs || {})[key] !== (after.attrs || {})[key]) {
      diffs.push({ prop: `@${key}`, before: before.attrs?.[key] ?? '', after: after.attrs?.[key] ?? '' });
    }
  }
  // Catches changes inside the element's subtree that the props above miss.
  if (before.subtreeHash && after.subtreeHash && before.subtreeHash !== after.subtreeHash && diffs.length === 0) {
    diffs.push({ prop: 'content', before: 'subtree', after: 'changed' });
  }
  return { changed: diffs.length > 0, diffs };
}

function round(n) { return Math.round(n * 10) / 10; }

function isGone(sig) {
  return !sig?.found || sig.visible === false;
}

// Runs the deterministic checks for one annotation.
//   baseline: signature captured before the agent worked on it
//   after:    signature captured after report_annotation + DOM settle
export function runChecks({ instruction, baseline, after }) {
  const checks = [];
  const removal = hasRemovalIntent(instruction);
  if (!after) {
    return { checks: [{ name: 'page', pass: false, detail: 'Page with this comment is not open in the browser' }], diffs: [], removal };
  }
  if (removal) {
    checks.push({ name: 'removed', pass: isGone(after), detail: isGone(after) ? 'Element is gone or hidden' : 'Element is still visible' });
  } else {
    checks.push({ name: 'exists', pass: !!after.found, detail: after.found ? `Element found (${after.method || 'anchor'})` : 'Element not found after the change' });
  }
  let diffs = [];
  if (!baseline) {
    checks.push({ name: 'changed', pass: false, detail: 'No baseline captured — cannot compare' });
  } else if (removal && isGone(after)) {
    checks.push({ name: 'changed', pass: !isGone(baseline), detail: isGone(baseline) ? 'Element was already gone' : 'Element removed' });
  } else {
    const cmp = compareSignatures(baseline, after);
    diffs = cmp.diffs;
    checks.push({ name: 'changed', pass: cmp.changed, detail: cmp.changed ? `${cmp.diffs.length} propert${cmp.diffs.length === 1 ? 'y' : 'ies'} changed` : 'No visible difference from before' });
  }
  return { checks, diffs, removal };
}

// PRD §27.2: Fixed only if deterministic checks pass AND the agent itself
// looked at the changed element through browser tools. Otherwise, if the
// agent claims a fix, the result is "Changed — check".
export function decideStatus({ agentStatus, checks, agentObservedChange }) {
  if (agentStatus === 'no_change') return STATUS.NO_CHANGE;
  if (agentStatus === 'failed') return STATUS.FAILED;
  const pass = Array.isArray(checks) && checks.length > 0 && checks.every((c) => c.pass);
  return pass && agentObservedChange ? STATUS.FIXED : STATUS.CHANGED_CHECK;
}

export function explainStatus({ status, checks, agentObservedChange }) {
  if (status === STATUS.FIXED) return 'Verified on the live page.';
  if (status !== STATUS.CHANGED_CHECK) return '';
  const failed = (checks || []).filter((c) => !c.pass).map((c) => c.detail);
  if (failed.length) return failed.join('; ');
  if (!agentObservedChange) return 'Agent did not inspect the changed element before reporting';
  return 'Verification inconclusive';
}
