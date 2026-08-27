/**
 * The tag `type` for a custom template.
 *
 * This is worth a test out of proportion to its size, because getting it wrong is invisible: GTM
 * accepts a tag carrying a bogus cvt_ type without complaint, and the mistake only shows up later
 * as an unrecognised tag in the UI. The two shapes also look interchangeable, and the wrong one
 * (the workspace templateId) is the one that looks right.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { customTemplateType } from '../tools/serverSide.js';

test('a gallery template uses the GALLERY id, not the workspace templateId', () => {
  const template = {
    containerId: '1234567',
    templateId: '12',
    galleryReference: {
      owner: 'facebook',
      repository: 'GoogleTagManager-WebTemplate-For-FacebookPixel',
      galleryTemplateId: 'MRQN8',
    },
  };
  // The trap: '12' is present, plausible, and wrong.
  assert.equal(customTemplateType(template, '1234567'), 'cvt_MRQN8');
});

test('a locally authored template is container-scoped', () => {
  const template = { containerId: '1234567', templateId: '12' };
  assert.equal(customTemplateType(template, '1234567'), 'cvt_1234567_12');
});

test('the container id falls back to the caller when the resource omits it', () => {
  assert.equal(customTemplateType({ templateId: '7' }, '999'), 'cvt_999_7');
});

test('the resource own containerId wins over the caller fallback', () => {
  // A template read from one container must never be labelled with another's id.
  assert.equal(customTemplateType({ containerId: '111', templateId: '7' }, '999'), 'cvt_111_7');
});

test('an empty galleryReference does not masquerade as a gallery template', () => {
  // galleryReference is present on some locally-authored templates with no galleryTemplateId;
  // treating "has the key" as "is from the gallery" would emit `cvt_undefined`.
  const template = { containerId: '1234567', templateId: '12', galleryReference: {} };
  assert.equal(customTemplateType(template, '1234567'), 'cvt_1234567_12');
});

test('a missing templateId still yields a parseable type rather than throwing', () => {
  assert.equal(customTemplateType({ containerId: '5' }, '5'), 'cvt_5_');
});
