// RUNTIME end-to-end: actually EXECUTE each AJAX-form recipe's listener <script> against a minimal
// DOM/jQuery shim, fire the plugin's real submit hook, and assert it dataLayer.pushes exactly the
// Custom Event the recipe's GA4 tag fires on. This proves the snippet is valid, executable JS that
// produces the right payload — a string-check (form-recipe-e2e) can't catch a syntax error or a wrong
// push shape; this does. Closes the loop: listener runs → pushes event → GA4 tag's trigger matches.
//
// Run: tsx apps/desktop/src/main/tools/__tests__/form-recipe-runtime.test.ts

import { formTrackingRecipe, AJAX_FORM_PROVIDERS_LIST, type AjaxFormProvider } from '../form-recipes';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

interface DlEvent { event?: string; form_id?: unknown }

/** Execute a listener <script> with shims, fire the plugin's hook, and return what it pushed. */
function runListener(html: string, provider: AjaxFormProvider): DlEvent[] {
  const dataLayer: DlEvent[] = [];
  const win = { dataLayer };
  const docHandlers: Record<string, Array<(e: unknown) => void>> = {};
  const doc = { addEventListener: (type: string, fn: (e: unknown) => void): void => { (docHandlers[type] ||= []).push(fn); } };
  const jqHandlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  // Minimal jQuery: $(x).on(event, fn) registers; that's all these listeners use.
  const jq = (): { on: (event: string, fn: (...a: unknown[]) => void) => void } => ({
    on: (event: string, fn: (...a: unknown[]) => void): void => { (jqHandlers[event] ||= []).push(fn); },
  });

  const inner = html.replace(/<\/?script>/gi, '');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', 'jQuery', '$', inner)(win, doc, jq, jq);

  const evt = { type: 'submit' };
  const fire = (map: Record<string, Array<(...a: unknown[]) => void>>, hook: string, args: unknown[]): void =>
    (map[hook] ?? []).forEach((fn) => fn(...args));

  switch (provider) {
    case 'contactform7': fire(docHandlers, 'wpcf7mailsent', [{ detail: { contactFormId: 4 } }]); break;
    case 'gravityforms': fire(jqHandlers, 'gform_confirmation_loaded', [evt, 4]); break;
    case 'ninjaforms': fire(jqHandlers, 'nfFormSubmitResponse', [evt, {}, 7]); break;
    case 'wpforms': fire(jqHandlers, 'wpformsAjaxSubmitSuccess', [evt]); break;
    case 'elementor': fire(jqHandlers, 'submit_success', [evt]); break;
  }
  return dataLayer;
}

console.log('\nform-recipe (RUNTIME — listeners actually execute):');

for (const provider of AJAX_FORM_PROVIDERS_LIST) {
  const recipe = formTrackingRecipe(provider)!;
  // Before its hook fires, nothing is pushed (the listener only registers).
  const beforeFireOnly = runListener(recipe.listenerTag.html.replace(recipe.dataLayerEvent, recipe.dataLayerEvent), provider);
  const pushed = beforeFireOnly;

  check(`${provider}: listener executes and pushes exactly once when its hook fires`, pushed.length === 1, `pushed ${pushed.length}`);
  check(
    `${provider}: pushed event === the GA4 tag's Custom Event (${recipe.dataLayerEvent})`,
    pushed[0]?.event === recipe.dataLayerEvent && recipe.ga4Tag.trigger.eventName === recipe.dataLayerEvent,
    `pushed=${pushed[0]?.event}`,
  );
}

// CF7 + Gravity carry the real form id through to the push (their hooks expose it).
{
  const cf7 = runListener(formTrackingRecipe('contactform7')!.listenerTag.html, 'contactform7');
  check('contactform7: form_id from wpcf7mailsent detail flows into the push', cf7[0]?.form_id === 4, `form_id=${cf7[0]?.form_id}`);
  const gf = runListener(formTrackingRecipe('gravityforms')!.listenerTag.html, 'gravityforms');
  check('gravityforms: form_id from gform_confirmation_loaded flows into the push', gf[0]?.form_id === 4, `form_id=${gf[0]?.form_id}`);
}

// Negative: a listener that never has its hook fired pushes nothing (no false positives).
{
  const dl: DlEvent[] = [];
  const win = { dataLayer: dl };
  const jq = (): { on: () => void } => ({ on: (): void => {} }); // register, never fire
  new Function('window', 'document', 'jQuery', '$', formTrackingRecipe('gravityforms')!.listenerTag.html.replace(/<\/?script>/gi, ''))(win, {}, jq, jq);
  check('gravityforms: pushes NOTHING until the hook actually fires', dl.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
if (passed < 12) { console.error(`expected >= 12 checks, got ${passed}`); process.exit(1); }
