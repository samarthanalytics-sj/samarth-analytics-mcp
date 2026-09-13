// Tests for attaching by paste or drop. The property that matters: these routes must obey exactly the
// same rules as the file picker, so an attachment behaves identically however it arrived.
// Run: tsx src/shared/__tests__/pasted-attachment.test.ts
import {
  checkPastedImage, checkDroppedFile, pastedImageName, multiDropNote,
  PASTE_IMAGE_MIMES, DROPPABLE_EXTS, MAX_PASTE_IMAGE_BYTES, MAX_DROP_FILE_BYTES,
} from '../pasted-attachment';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const DAY = '2026-07-22';

// ── Naming a clipboard image, which arrives with no filename ───────────────────
check('a pasted png is named by date', pastedImageName('image/png', DAY) === 'pasted-image-2026-07-22.png');
check('the extension follows the mime type', pastedImageName('image/webp', DAY).endsWith('.webp')
  && pastedImageName('image/jpeg', DAY).endsWith('.jpg'));
check('several pastes in one day stay tellable apart', (() => {
  const a = pastedImageName('image/png', DAY, 0);
  const b = pastedImageName('image/png', DAY, 1);
  return a !== b && b.includes('-2.png');
})());
check('an unknown mime still yields a usable name', pastedImageName('image/tiff', DAY).endsWith('.png'));
check('a missing date does not produce a broken name', !pastedImageName('image/png', '').includes('undefined'));

// ── Paste: same types and same 5 MB ceiling as the picker ─────────────────────
check('a normal screenshot is accepted', (() => {
  const r = checkPastedImage('image/png', 250_000, DAY);
  return r.ok && r.name.endsWith('.png');
})());
check('every supported image type is accepted', Object.keys(PASTE_IMAGE_MIMES)
  .every((m) => checkPastedImage(m, 1000, DAY).ok));
check('pasted TEXT is refused with a useful message, not silently ignored', (() => {
  const r = checkPastedImage('text/plain', 100, DAY);
  return !r.ok && /copy an image/i.test(r.error);
})());
check('an unsupported image type is refused by name', (() => {
  const r = checkPastedImage('image/tiff', 100, DAY);
  return !r.ok && r.error.includes('image/tiff');
})());
check('an empty paste is refused', !checkPastedImage('image/png', 0, DAY).ok);
// The cap must match the picker's, or the same screenshot would behave differently by route.
check('exactly at the 5 MB cap is accepted', checkPastedImage('image/png', MAX_PASTE_IMAGE_BYTES, DAY).ok);
check('over the cap is refused, with the size and the limit stated', (() => {
  const r = checkPastedImage('image/png', MAX_PASTE_IMAGE_BYTES + 1, DAY);
  return !r.ok && /6 MB|5\.2 MB|5 MB/.test(r.error) && /limit is 5 MB/.test(r.error);
})(), (checkPastedImage('image/png', MAX_PASTE_IMAGE_BYTES + 1, DAY) as { error: string }).error);
check('the refusal says how to fix it', /crop or resize/i.test((checkPastedImage('image/png', 9e6, DAY) as { error: string }).error));

// ── Drop: the picker's whole file list, at the picker's ceilings ───────────────
check('a dropped pdf is accepted', checkDroppedFile('report.pdf', 1_000_000).ok);
check('every type the picker accepts can also be dropped',
  DROPPABLE_EXTS.every((e) => checkDroppedFile(`file.${e}`, 1000).ok));
check('an unsupported type is refused and lists what IS supported', (() => {
  const r = checkDroppedFile('archive.zip', 1000);
  return !r.ok && r.error.includes('archive.zip') && r.error.includes('pdf');
})());
check('a file with no extension is refused', !checkDroppedFile('README', 1000).ok);
check('a nameless drop is refused rather than crashing', !checkDroppedFile('', 1000).ok && !checkDroppedFile('   ', 1000).ok);
check('extension matching is case-insensitive', checkDroppedFile('Screenshot.PNG', 1000).ok);
// Images keep the 5 MB image cap even when dropped, documents get the 15 MB one.
check('a dropped IMAGE uses the 5 MB image cap', !checkDroppedFile('shot.png', MAX_PASTE_IMAGE_BYTES + 1).ok);
check('a dropped DOCUMENT gets the larger 15 MB cap', checkDroppedFile('big.pdf', MAX_PASTE_IMAGE_BYTES + 1).ok
  && !checkDroppedFile('huge.pdf', MAX_DROP_FILE_BYTES + 1).ok);
check('the dropped name is preserved, not renamed', (() => {
  const r = checkDroppedFile('Q3 audit (final).pdf', 1000);
  return r.ok && r.name === 'Q3 audit (final).pdf';
})());

// ── A multi-file drop must not silently discard the rest ──────────────────────
check('one file drops without a note', multiDropNote(1) === null && multiDropNote(0) === null);
check('several files say what happened to the others', (() => {
  const n = multiDropNote(3) ?? '';
  return n.includes('3 files') && /only the first is attached/i.test(n);
})());

// ── House style ───────────────────────────────────────────────────────────────
check('no em dashes in any message (these render straight into the composer)', (() => {
  const msgs = [
    (checkPastedImage('text/plain', 1, DAY) as { error: string }).error,
    (checkPastedImage('image/png', 9e6, DAY) as { error: string }).error,
    (checkDroppedFile('a.zip', 1) as { error: string }).error,
    multiDropNote(2) ?? '',
  ];
  return !msgs.some((m) => /[—–]/.test(m));
})());

console.log(`\npasted-attachment: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
