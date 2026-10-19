import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsentPreview, anonymousEvent } from '../public/privacy.mjs';
import { accountPages } from '../src/account-page.mjs';

// SYNTHETIC CONTRACT TESTS: no photos, health data, storage, collector or provider.
test('no-save overrides all three proposed choices and keeps no image or derived values', () => {
  const preview = createConsentPreview();
  const defaults = { noSave: true, progressImages: false, derivedMeasurements: false, improvement: false, image: null, derived: null };
  assert.deepEqual(preview.snapshot(), defaults);
  preview.choose({ progressImages: true, derivedMeasurements: true, improvement: true });
  assert.deepEqual(preview.snapshot(), defaults);
  preview.choose({ noSave: false });
  assert.equal(preview.snapshot().progressImages, false); assert.equal(preview.snapshot().derivedMeasurements, false); assert.equal(preview.snapshot().improvement, false);
  preview.choose({ progressImages: true });
  assert.equal(preview.snapshot().progressImages, true); assert.equal(preview.snapshot().derivedMeasurements, false); assert.equal(preview.snapshot().improvement, false);
  preview.choose({ derivedMeasurements: true, progressImages: false });
  assert.equal(preview.snapshot().progressImages, false); assert.equal(preview.snapshot().derivedMeasurements, true); assert.equal(preview.snapshot().improvement, false);
  preview.choose({ improvement: true, derivedMeasurements: false });
  assert.equal(preview.snapshot().progressImages, false); assert.equal(preview.snapshot().derivedMeasurements, false); assert.equal(preview.snapshot().improvement, true);
  preview.choose({ noSave: true }); assert.deepEqual(preview.snapshot(), defaults);
  preview.choose({ noSave: false, progressImages: true, derivedMeasurements: true, improvement: true });
  assert.equal(preview.snapshot().image, null); assert.equal(preview.snapshot().derived, null);
  assert.deepEqual(preview.clear(), defaults);
});

test('invalid choice cannot alter prior ephemeral state', () => {
  const preview = createConsentPreview();
  for (const key of ['noSave', 'progressImages', 'derivedMeasurements', 'improvement']) {
    const before = preview.snapshot(); assert.throws(() => preview.choose({ [key]: 'true' }), TypeError);
    assert.equal(preview.snapshot(), before);
  }
  assert.equal(Object.isFrozen(preview.snapshot()), true);
});

test('tracking is off by default and allows names only with no payload fields', () => {
  for (const config of [undefined, {}, { trackingEnabled: false }, { trackingEnabled: 'true' }]) assert.equal(anonymousEvent(config, 'preview_open'), null);
  for (const name of ['navigation_open', 'journal_open', 'preview_open']) assert.deepEqual(anonymousEvent({ trackingEnabled: true }, name), { event: name });
  for (const name of ['photo_upload', 'injury', 'account', 'signin', 'entitlement', '/campaigns/injury/?email=x', 'preview_open?accountId=x']) assert.equal(anonymousEvent({ trackingEnabled: true }, name), null);
  for (const details of [{}, { accountId: 'synthetic' }, { email: 'synthetic@example.invalid' }, { injury: 'synthetic' }, { query: 'x' }, { measurements: [] }, null]) assert.equal(anonymousEvent({ trackingEnabled: true }, 'preview_open', details), null);
});

test('privacy route has no image/file/camera input and presents all choices as unsaved proposals', () => {
  const html = accountPages().find(x => x.path === 'privacy/index.html').html;
  assert.doesNotMatch(html, /type=["']file|capture=|<img\b|<video\b|<canvas\b/);
  for (const name of ['progressImages', 'derivedMeasurements', 'improvement']) assert.match(html, new RegExp(`name="${name}" disabled`));
  assert.match(html, /name="noSave" checked/); assert.match(html, /not submitted/); assert.match(html, /No-save overrides all three/);
  assert.match(html, /href="\/body-preview\/"/);
});
