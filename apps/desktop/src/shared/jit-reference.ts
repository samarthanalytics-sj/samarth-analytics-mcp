// Just-in-time reference: knowledge the model needs for ONE kind of work, delivered when that work
// actually happens instead of on every request.
//
// Two blocks dominated the always-sent GTM system prompt and were dead weight on most turns:
//
//   The audit brain (~1,680 tokens). Rule (1), "call audit_gtm_container FIRST", has to arrive
//   BEFORE the model decides what to do, so it stays in the prompt. Rules (2) to (11) are entirely
//   about how to INTERPRET and REPORT findings, which only matters once findings exist. They now
//   ride on the audit tool's result, so they arrive with the very data they govern.
//
//   The raw GTM API v2 resource shapes (~530 tokens). Only the RAW create_gtm_variable /
//   create_gtm_trigger calls need them, and the typed builders cover the common cases. They are now
//   attached to a raw create FAILURE, which is exactly the moment the model needs to fix its shape.
//
// The delivery is DETERMINISTIC, not a guess about intent: if the model audits, it gets the audit
// methodology; if a raw create is rejected, it gets the shapes. Nothing depends on keyword matching
// against the user message, so nothing can be silently withheld from a turn that needed it.
//
// Attached to the MODEL's copy of a tool result only. The UI and the change journal keep the real
// result unchanged (see gateway.ts).

/** Rules (2) to (11) of the audit brain: how to interpret and report findings. */
export const AUDIT_REPORTING_METHODOLOGY =
  'AUDIT REPORTING METHODOLOGY - follow this exactly for the findings you just received; return findings, not opinions: ' +
  '(2) OPEN with the boundary statement: a container-only audit proves CONFIGURATION, not firing behaviour, dataLayer reality, PII in hits, or consent timing — those need runtime verification (GA4 DebugView / Tag Assistant, a network capture of /collect requests, and the live CMP). ' +
  '(3) Tag EVERY finding with a confidence level — [Certain] = provable from the container; [Likely] = strong inference needing one cheap confirmation; [Guessing / runtime-required] = needs runtime evidence you do not have. Never count a [Guessing/runtime-required] item as a confirmed defect. ' +
  '(4) ORDER by impact, not category: Critical (active data corruption or a legal violation — e.g. a double-firing purchase/conversion tag, PII sent to GA4/Ads, tags able to fire before the consent default) → High → Medium → Low. Hygiene (naming, paused, orphaned, folders) is LISTED last, NEVER leads, and is NEVER reported as a data or legal issue. If a container is messy but functionally sound, say so plainly. ' +
  '(5) Each finding has FOUR parts: what is wrong (one sentence) · impact (data / legal / security, quantified where possible) · evidence (the exact tag/trigger/variable/parameter name) · fix (the specific action). When a finding carries a ready-to-run `fix` ({tool,args} with ids filled in), OFFER to apply it and — once the user agrees in chat — CALL that exact tool (never tell the user to fix it manually in the GTM UI when a fix tool exists); non-delete fixes apply directly, deletes show a two-step approval card. ' +
  '(6) FALSE-POSITIVE GUARDS: a denied consent signal correctly BLOCKING a tag is correct behaviour, not a violation; a tag that does not fire where it was never meant to is not broken; classify a tag by its actual destination ID, not a guessed brand; a hygiene issue is never a data/legal issue; if you cannot prove it from the evidence in hand, mark it runtime-required rather than inventing a verdict. NEVER report GTM\'s "Cannot detect the Google tag" warning as a defect — a {{variable}} Measurement/Tag ID is BEST PRACTICE (A3), not a fault; only an EMPTY id (Certain, High) or an id that resolves to nothing at runtime is the finding (a variable id is runtime-required, a hardcoded id with no matching Google tag is verify-only). ' +
  '(7) CONSENT: Consent Mode v2 needs ALL FOUR signals (ad_storage, analytics_storage, ad_user_data, ad_personalization) with a denied-by-default Consent Initialization — flag missing signals as Critical, but consent TIMING/firing-order is runtime-required. CUSTOM HTML has NO built-in Consent Mode (B6): detect an advertising pixel by a STRONG signal (the pixel init/fire — fbq(\'init\'/\'track\', ttq.load(, _linkedin_partner_id, pintrk(, snaptr(, twq(, rdt(, uetq) — a bare DOMAIN reference alone is only "possible, review" [Guessing]; the short tokens twq(/rdt(/uetq also need their domain to co-occur. Then evaluate its CONSENT GATE: consentStatus notSet/absent = UNGATED, notNeeded = declared-no-consent, needed-without-ad_storage = wrong-types — all three are NO valid gate → Critical for EU/UK/AU (else High), [Certain] the gate is missing (firing-before-consent stays runtime-required, keep the two claims separate). needed WITH ad_storage but missing ad_user_data/ad_personalization = partial → Medium. needed WITH all required ad types = correctly GATED → emit NOTHING (do not flag a denied-pass). Google tags (GA4/Ads/Floodlight/Linker) DO have built-in consent, so notSet on them is [Likely], not certain; never skip a non-Google marketing tag\'s missing consent gate as "nothing to check". DEDUP every finding by check+resource (no finding twice for one tag/variable), and an UNUSED item cannot also be a runtime risk — unused wins, suppress the risk finding. ' +
  '(8) SEVERITY nuance: a paused tag is Low, BUT a paused conversion (Ads) or GA4/Google CONFIG tag is High — a silent tracking gap. A tag with an empty destination id (no Measurement/Tag/Conversion id) is High — it looks active but sends nothing. A {{variable}} Measurement ID that a Google/Configuration tag in the container DECLARES is fine ("Google tag found"); one that NO Google tag declares is GTM\'s "Cannot detect the Google tag" case → HIGH [Likely], events may not be collected (point the tag at the id the Google tag uses, or add a Google tag for it). ' +
  '(9) MORE CHECKS — present with the same discipline: DOUBLE-COUNTING (a manual GA4 event tag for an event Enhanced Measurement also auto-tracks — page_view/scroll/click/file_download/form_submit/video_* — is [Likely]; EM lives on the web stream, confirm before scoring), DESTINATION MISMATCH (a GA4 event tag whose Measurement ID differs from the page\'s Google tag splits data), PURCHASE DEDUP (a purchase/conversion sent twice inflates revenue — runtime-required, not provable from the export), CUSTOM JS VARIABLES (jsm run wherever referenced — review for DOM/cookie/PII access), UNRECOGNISED TAG TYPE (flagged for manual review, never skipped silently), and SERVER-SIDE mixed transport (tags not all sharing the transport URL split attribution). ' +
  '(10) SCORING is deterministic + versioned: Critical −30, High −12, Medium −4, Low −1; info and runtime-required score 0. Report the number AND keep runtime-required items in their own "needs verification" list, never as scored defects. ' +
  '(11) END with that explicit runtime-required list so nobody assumes those checks passed. After applying fixes, re-run audit_gtm_container to confirm they cleared. ';

/** Rule (1) plus the pointer, which is all the SYSTEM PROMPT still needs to carry. */
export const AUDIT_POINTER =
  'AUDIT METHODOLOGY (GTM Audit Brain) — when the user asks to audit / check / review / "health-check" the container or its setup, follow this method exactly; return findings, not opinions: ' +
  '(1) ALWAYS call audit_gtm_container FIRST for the deterministic findings — never audit from memory or a generic checklist. ' +
  'The full reporting methodology (boundary statement, confidence levels, impact ordering, false-positive guards, consent rules, severity, scoring) comes back WITH the audit result, so run the tool and follow what it returns rather than reporting from a generic checklist. ';

/** The raw GTM API v2 resource shapes, delivered when a RAW create is rejected. */
export const GTM_RAW_SHAPES =
  'RAW SHAPES (GTM API v2, camelCase types — the create_gtm_variable / create_gtm_trigger resource): Lookup Table = {name, type:"smm", parameter:[{type:"template",key:"input",value:"{{Click Text}}"},{type:"list",key:"map",list:[{type:"map",map:[{type:"template",key:"key",value:"Art Select"},{type:"template",key:"value",value:"true"}]}, …one map per row… ]},{type:"boolean",key:"setDefaultValue",value:"true"},{type:"template",key:"defaultValue",value:"false"}]} — defaultValue is INERT unless the setDefaultValue boolean is true; omit BOTH when no default is wanted. (Simpler: create_gtm_variable_typed kind "lookup_table"/"regex_table" builds these correctly from input+rows+defaultValue.) RegEx Table = the same with type:"remm" (each row key is a regex; add {type:"boolean",key:"ignoreCase",value:"true"} / {type:"boolean",key:"fullMatch",value:"true"} as needed). DOM Element = {name, type:"d", parameter:[{type:"template",key:"selectorType",value:"CSS"} (or "ID"), then for CSS a {type:"template",key:"elementSelector",value:"<css selector>"} OR for ID a {type:"template",key:"elementId",value:"<element id>"}, plus optional {type:"template",key:"attributeName",value:"href"} to read an attribute instead of the element text]} (there is NO elementType param; the CSS selector goes under elementSelector, NOT elementId). Variable-driven click trigger = {name, type:"linkClick" (or "click"), filter:[{type:"equals",parameter:[{type:"template",key:"arg0",value:"{{Browse By Range Variable}}"},{type:"template",key:"arg1",value:"true"}]}]}. Element Visibility trigger = {name, type:"elementVisibility", parameter:[ selectorType + elementSelector + on-screen percent + firingFrequency (ONCE / ONCE_PER_ELEMENT / MANY_PER_ELEMENT) ]} — set the exact keys the API expects and fix on rejection. ';

/** Audit tools whose RESULT should carry the reporting methodology. */
const AUDIT_TOOLS = new Set(['audit_gtm_container', 'audit_server_container']);
/** Raw creates whose FAILURE should carry the resource shapes (the typed builders never need them). */
const RAW_CREATE_TOOLS = new Set(['create_gtm_trigger', 'create_gtm_variable']);

/** Reference to attach to a SUCCESSFUL result, or undefined. */
export function referenceForResult(toolName: string): string | undefined {
  return AUDIT_TOOLS.has(toolName) ? AUDIT_REPORTING_METHODOLOGY : undefined;
}

/** Reference to attach to a FAILED call, or undefined. */
export function referenceForError(toolName: string): string | undefined {
  return RAW_CREATE_TOOLS.has(toolName) ? GTM_RAW_SHAPES : undefined;
}

/**
 * Attach a reference to a tool payload the model is about to read.
 *
 * JSON keeps its shape (the reference becomes a field, so the payload still parses); anything else
 * gets it appended as a labelled block. Returns the payload unchanged when there is no reference.
 */
export function attachReference(content: string, reference?: string): string {
  const text = String(content ?? '');
  if (!reference) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), _methodology: reference });
    }
    return JSON.stringify({ result: parsed, _methodology: reference });
  } catch {
    return `${text}

${reference}`;
  }
}
