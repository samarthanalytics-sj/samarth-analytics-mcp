/** Element signals: Cloudflare email decoding, maps/address links, non-link contact blocks. */
import assert from 'node:assert/strict';
import {
  cfEmailHexFromHref,
  contactKindOf,
  decodeCfEmail,
  isContactClass,
  isMapsUrl,
  looksLikeAddress,
  resolveEmailHref,
} from '../element-signals.js';
import { classifyElement, type RawElement } from '../collect.js';

let passed = 0;
let failed = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('element-signals');

/** Encode the way Cloudflare does, so the decoder is tested against a real round trip. */
function cfEncode(addr: string, key: number): string {
  let out = key.toString(16).padStart(2, '0');
  for (const ch of addr) out += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0');
  return out;
}

// ── Cloudflare email obfuscation ─────────────────────────────────────────────
t('decodeCfEmail round-trips a real payload', () => {
  for (const addr of ['paulandjenny@ramsden.net.au', 'nqequipment@augertorque.com.au', 'a@b.co']) {
    for (const key of [0x1f, 0x7a, 0x01, 0xd4]) {
      assert.equal(decodeCfEmail(cfEncode(addr, key)), addr, `${addr} key ${key}`);
    }
  }
});

t('decodeCfEmail rejects junk rather than returning a broken address', () => {
  assert.equal(decodeCfEmail(''), null);
  assert.equal(decodeCfEmail('zz'), null);
  assert.equal(decodeCfEmail('1f2b3'), null, 'odd length');
  assert.equal(decodeCfEmail('1f1f1f1f'), null, 'decodes to control chars / not an address');
  assert.equal(decodeCfEmail(cfEncode('not-an-email', 0x1f)), null, 'no @ or dot');
});

t('cfEmailHexFromHref pulls the payload off the protection URL', () => {
  assert.equal(cfEmailHexFromHref('/cdn-cgi/l/email-protection#1f7a2b'), '1f7a2b');
  assert.equal(cfEmailHexFromHref('https://x.com/cdn-cgi/l/email-protection#ABCDEF'), 'ABCDEF');
  assert.equal(cfEmailHexFromHref('/contact'), null);
});

t('resolveEmailHref sees through obfuscation, from either source', () => {
  const hex = cfEncode('hello@example.com', 0x2c);
  assert.equal(resolveEmailHref('mailto:a@b.com'), 'mailto:a@b.com', 'a plain mailto passes through');
  assert.equal(resolveEmailHref('/cdn-cgi/l/email-protection#' + hex), 'mailto:hello@example.com');
  assert.equal(resolveEmailHref('/cdn-cgi/l/email-protection', hex), 'mailto:hello@example.com', 'data-cfemail attribute');
  assert.equal(resolveEmailHref('/about'), null);
  assert.equal(resolveEmailHref(undefined), null);
});

// ── maps / address links ─────────────────────────────────────────────────────
t('isMapsUrl recognises the major providers', () => {
  for (const u of [
    'https://www.google.com/maps/search/?api=1&query=86%20Conway%20Street',
    'https://maps.google.com/?q=x',
    'https://maps.app.goo.gl/abc123',
    'https://maps.apple.com/?address=1+Infinite+Loop',
    'https://www.waze.com/ul?ll=1,2',
    'https://www.bing.com/maps?where1=x',
    'https://www.openstreetmap.org/#map=17/1/2',
    'https://www.google.co.uk/maps/place/x',
  ]) {
    assert.equal(isMapsUrl(u), true, u);
  }
});

t('isMapsUrl does not swallow ordinary google or other links', () => {
  for (const u of ['https://www.google.com/search?q=x', 'https://mail.google.com/', 'https://example.com/maps-of-the-world', 'mailto:a@b.com', 'not a url', '']) {
    assert.equal(isMapsUrl(u), false, u);
  }
});

// ── non-link contact blocks ──────────────────────────────────────────────────
t('contactKindOf names the purpose from the class', () => {
  assert.equal(contactKindOf('wpgb-block-4 dealer-address'), 'address');
  assert.equal(contactKindOf('dealer-phone'), 'phone');
  assert.equal(contactKindOf('footer-email'), 'email');
  assert.equal(contactKindOf('opening-hours'), 'hours');
  assert.equal(contactKindOf('btn btn-primary'), null);
  assert.equal(contactKindOf(undefined), null);
});

t('isContactClass gates the collector pass', () => {
  assert.equal(isContactClass('dealer-address'), true);
  assert.equal(isContactClass('store-locator'), true);
  assert.equal(isContactClass('hero-banner'), false);
  assert.equal(isContactClass(''), false);
});

t('looksLikeAddress rejects a heading that merely sits in a location block', () => {
  assert.equal(looksLikeAddress('86 Conway Street, Lismore NSW 2480, Australia'), true);
  assert.equal(looksLikeAddress('Unit 1/18 Precision Place, Mulgrave NSW 2756'), true);
  assert.equal(looksLikeAddress('Our Locations'), false);
  assert.equal(looksLikeAddress('Find a dealer near you'), false);
  assert.equal(looksLikeAddress(''), false);
});

// ── classifyElement end to end ───────────────────────────────────────────────
const raw = (o: Partial<RawElement>): RawElement => ({ tag: 'a', href: '', text: '', hasDownload: false, region: '', ...o });

t('a Cloudflare-obfuscated email link classifies as email with a real mailto', () => {
  const hex = cfEncode('paulandjenny@ramsden.net.au', 0x3d);
  const el = classifyElement(raw({ tag: 'a', href: `https://augertorque.com.au/cdn-cgi/l/email-protection#${hex}`, text: '[email protected]', className: 'wpgb-block-4 dealer-email' }), 'augertorque.com.au');
  assert.equal(el?.kind, 'email');
  assert.equal(el?.href, 'mailto:paulandjenny@ramsden.net.au');
});

t('the same link with the data-cfemail attribute also decodes', () => {
  const hex = cfEncode('nqequipment@augertorque.com.au', 0x11);
  const el = classifyElement(raw({ tag: 'a', href: '/cdn-cgi/l/email-protection', cfEmail: hex, className: 'dealer-email' }), 'augertorque.com.au');
  assert.equal(el?.kind, 'email');
  assert.equal(el?.href, 'mailto:nqequipment@augertorque.com.au');
});

t('a Google Maps link is an ADDRESS click, not a generic outbound', () => {
  const el = classifyElement(raw({
    tag: 'a',
    href: 'https://www.google.com/maps/search/?api=1&query=86%20Conway%20Street%2C%20Lismore%20NSW%202480',
    text: '86 Conway Street, Lismore NSW 2480, Australia',
    className: 'wpgb-block-5 dealer-address',
  }), 'augertorque.com.au');
  assert.equal(el?.kind, 'address');
  assert.equal(el?.className, 'wpgb-block-5 dealer-address');
});

t('an ordinary third-party link is still outbound', () => {
  const el = classifyElement(raw({ tag: 'a', href: 'https://www.planetskidsteers.com/', text: 'planetskidsteers.com', className: 'dealer-website' }), 'augertorque.com.au');
  assert.equal(el?.kind, 'outbound');
});

t('a non-link address block classifies as address', () => {
  const el = classifyElement(raw({ tag: 'button', href: '', text: '9 Rovan Place, Bairnsdale VIC 3875', className: 'dealer-address', nonLink: true }), 'x.com');
  assert.equal(el?.kind, 'address');
  assert.equal(el?.href, undefined, 'no href to trigger on - the class carries it');
});

t('a non-link phone/email block classifies by its class', () => {
  assert.equal(classifyElement(raw({ tag: 'button', text: '03 9999 1234', className: 'dealer-phone', nonLink: true }), 'x.com')?.kind, 'phone');
  assert.equal(classifyElement(raw({ tag: 'button', text: 'sales@x.com', className: 'footer-email', nonLink: true }), 'x.com')?.kind, 'email');
});

t('a non-link block whose class names nothing is DROPPED, not guessed at', () => {
  assert.equal(classifyElement(raw({ tag: 'button', text: 'Some heading', className: 'wrapper', nonLink: true }), 'x.com'), null);
  // "Our Locations" carries a location-ish class but is not an address.
  assert.equal(classifyElement(raw({ tag: 'button', text: 'Our Locations', className: 'location-heading', nonLink: true }), 'x.com'), null);
});

console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
