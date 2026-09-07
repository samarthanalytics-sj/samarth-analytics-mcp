// Tests for buildContainerInventory — the three audit tables (Tag / Trigger / Variable) rendered from a
// snapshot. Run: tsx src/main/google/__tests__/gtm-inventory.test.ts
import { buildContainerInventory } from '../gtm-inventory';
import type { ContainerSnapshot } from '../gtm-builders';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const tmpl = (key: string, value: string): Record<string, unknown> => ({ type: 'template', key, value });
const cond = (type: string, arg0: string, arg1: string, extra: Array<Record<string, unknown>> = []): Record<string, unknown> => ({
  type,
  parameter: [tmpl('arg0', arg0), tmpl('arg1', arg1), ...extra],
});

const snapshot: ContainerSnapshot = {
  tags: [
    // Custom HTML on the built-in Initialization trigger.
    { tagId: '1', name: 'cHTML - Apollo Tag', type: 'html', firingTriggerId: ['2147479553'], paused: false, parameter: [] },
    // GA4 event tag on a used trigger, once per event.
    { tagId: '2', name: 'GA4 - Event - Start Free Trial Click Tag', type: 'gaawe', firingTriggerId: ['10'], paused: false, parameter: [], tagFiringOption: 'oncePerEvent' },
    // Form event tag, once per load (the cleanup-rec case).
    { tagId: '3', name: 'GA4 - Event - Audit Form Tag', type: 'gaawe', firingTriggerId: ['11'], paused: false, parameter: [], tagFiringOption: 'oncePerLoad' },
    // Conversion linker.
    { tagId: '4', name: 'Google Ads Conversion Linker Tag', type: 'gclidw', firingTriggerId: ['2147479553'], paused: false, parameter: [] },
  ],
  triggers: [
    // Unused: referenced by no tag.
    { triggerId: '5', name: 'All Elements Click Trigger', type: 'click', filter: [] },
    { triggerId: '6', name: 'Just Links Click Trigger', type: 'linkClick', filter: [] },
    // Used: Start Free Trial (linkClick with a click-text condition).
    { triggerId: '10', name: 'Start Free Trial Click Trigger', type: 'linkClick', filter: [cond('equals', '{{Click Text}}', 'Start free trial')] },
    // Used: Audit Form (customEvent with event match + a URL filter).
    { triggerId: '11', name: 'Audit Form Trigger', type: 'customEvent',
      customEventFilter: [cond('equals', '{{_event}}', 'form_submit')],
      filter: [cond('contains', '{{Page URL}}', 'audit.tagdrishti.com/')] },
  ],
  variables: [
    { variableId: '20', name: 'GA4 Variable', type: 'c', parameter: [tmpl('value', 'G-5LWQWGXHMD')] },
    { variableId: '21', name: 'DLV - ecommerce', type: 'v', parameter: [tmpl('name', 'ecommerce')] },
  ],
};

const inv = buildContainerInventory(snapshot);

// Tag table
const apollo = inv.tags.find((t) => t.name === 'cHTML - Apollo Tag')!;
check('custom html type label', apollo.type === 'Custom HTML', apollo.type);
check('built-in firing trigger label', apollo.firingTriggers === 'All Pages (Initialization)', apollo.firingTriggers);
const sft = inv.tags.find((t) => t.name.includes('Start Free Trial'))!;
check('ga4 event type label', sft.type === 'GA4 Event', sft.type);
check('resolves firing trigger NAME', sft.firingTriggers === 'Start Free Trial Click Trigger', sft.firingTriggers);
check('firing option once per event', sft.firingOption === 'Once per event', sft.firingOption);
const form = inv.tags.find((t) => t.name.includes('Audit Form'))!;
check('firing option once per load', form.firingOption === 'Once per load', form.firingOption);
check('gclidw → Google Ads Linker', inv.tags.find((t) => t.type === 'Google Ads Linker') !== undefined);

// Trigger table
const unusedNames = inv.triggers.filter((t) => t.usage === 'Unused').map((t) => t.name).sort();
check('exactly the 2 unreferenced triggers are Unused', unusedNames.join('|') === 'All Elements Click Trigger|Just Links Click Trigger', unusedNames.join('|'));
const start = inv.triggers.find((t) => t.name === 'Start Free Trial Click Trigger')!;
check('link click type label', start.type === 'Link Click', start.type);
check('renders the click-text condition', start.conditions === 'Click Text equals Start free trial', start.conditions);
check('used trigger marked Used', start.usage === 'Used');
const auditT = inv.triggers.find((t) => t.name === 'Audit Form Trigger')!;
check('custom event type label', auditT.type === 'Custom Event', auditT.type);
check('joins event + filter conditions with AND', auditT.conditions === 'Event equals form_submit AND Page URL contains audit.tagdrishti.com/', auditT.conditions);
const allClicks = inv.triggers.find((t) => t.name === 'All Elements Click Trigger')!;
check('empty-filter click trigger reads "None (all clicks)"', allClicks.conditions === 'None (all clicks)', allClicks.conditions);

// Variable table
const ga4v = inv.variables.find((v) => v.name === 'GA4 Variable')!;
check('constant type + literal value', ga4v.type === 'Constant' && ga4v.value === 'G-5LWQWGXHMD', `${ga4v.type} / ${ga4v.value}`);
const dlv = inv.variables.find((v) => v.name === 'DLV - ecommerce')!;
check('data layer variable label + source', dlv.type === 'Data Layer Variable' && dlv.value === 'dataLayer: ecommerce', `${dlv.type} / ${dlv.value}`);

console.log(`\ngtm-inventory: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
