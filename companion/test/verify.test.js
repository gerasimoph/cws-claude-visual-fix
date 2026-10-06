import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSignatures, runChecks, decideStatus, hasRemovalIntent } from '../src/verify.js';
import { signature } from './helpers.js';

test('compareSignatures reports geometry and style diffs', () => {
  const before = signature();
  const after = signature({ rect: { ...before.rect, height: 480 }, styles: { ...before.styles, height: '480px' } });
  const cmp = compareSignatures(before, after);
  assert.equal(cmp.changed, true);
  assert.deepEqual(cmp.diffs.map((d) => d.prop).sort(), ['height', 'height'].sort());
});

test('identical signatures are unchanged; subtree-only change is detected', () => {
  assert.equal(compareSignatures(signature(), signature()).changed, false);
  const cmp = compareSignatures(signature(), signature({ subtreeHash: 'zzz' }));
  assert.equal(cmp.changed, true);
  assert.equal(cmp.diffs[0].prop, 'content');
});

test('removal intent', () => {
  assert.ok(hasRemovalIntent('Remove this icon'));
  assert.ok(hasRemovalIntent('убери эту иконку'));
  assert.ok(!hasRemovalIntent('Make this button full width'));
  const r = runChecks({ instruction: 'Remove this icon', baseline: signature(), after: { found: false } });
  assert.ok(r.checks.every((c) => c.pass));
});

test('missing page or element fails checks', () => {
  assert.equal(runChecks({ instruction: 'x', baseline: signature(), after: null }).checks[0].pass, false);
  const r = runChecks({ instruction: 'Make it red', baseline: signature(), after: { found: false } });
  assert.equal(r.checks.find((c) => c.name === 'exists').pass, false);
});

test('Fixed requires passing checks AND the agent observing the change', () => {
  const pass = [{ name: 'exists', pass: true }, { name: 'changed', pass: true }];
  assert.equal(decideStatus({ agentStatus: 'fixed', checks: pass, agentObservedChange: true }), 'fixed');
  assert.equal(decideStatus({ agentStatus: 'fixed', checks: pass, agentObservedChange: false }), 'changed_check');
  assert.equal(decideStatus({ agentStatus: 'fixed', checks: [{ name: 'changed', pass: false }], agentObservedChange: true }), 'changed_check');
  assert.equal(decideStatus({ agentStatus: 'no_change', checks: [] }), 'no_change');
  assert.equal(decideStatus({ agentStatus: 'failed', checks: [] }), 'failed');
});
