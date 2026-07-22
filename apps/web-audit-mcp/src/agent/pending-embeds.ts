// "Is a form still on its way?" - the signal that network quiet cannot give us.
//
// The scan waits for network quiet before reading forms, which is a PROXY for the page being done.
// Measured on get.chownow.com: DOMContentLoaded 1.5s, the HubSpot render-definition 1.9s, the React
// island runtime that actually renders the form 3.1s, load 4.4s, last HubSpot call 4.9s, and the last
// resource of any kind 7.4s. Quiet therefore arrives around 8.1s against a 9s ceiling - it fitted,
// with under a second to spare, and only because network activity happened to outlast the render.
//
// An embed gated on IntersectionObserver or a timer renders AFTER quiet, so the proxy breaks and the
// form is simply absent from the scan. The page states it plainly though: the provider's container
// element is already in the DOM with no <form> inside it yet. That is a fact worth waiting on, and
// waiting on nothing else - a page with no pending container pays nothing.

/** Containers the major embedded-form providers mount BEFORE their form renders. */
export const EMBED_CONTAINER_SELECTORS = [
  '.hs-form-html', '.hbspt-form', '[data-hsfc-id="Renderer"]', '[data-form-id]', // HubSpot
  '.mktoForm', '[id^="mktoForm_"]',                                              // Marketo
  '.pardotForm', '.marketing-form',                                              // Pardot
  '[data-tf-widget]', '.typeform-widget',                                        // Typeform
  '.gform_wrapper', '.wpcf7',                                                    // WordPress (Gravity / CF7)
  '.freshwidget-embedded-form', '.zf-templateWidth',                             // Freshworks / Zoho
] as const;

/**
 * Serialized into the page: how many provider containers are present but still EMPTY of a form?
 *
 * Self-contained on purpose - it is stringified and evaluated in the scanned document, so it may not
 * reference anything from this module. A container counts as pending only when it holds no <form>
 * AND no input, which keeps a decorative wrapper (or a container whose form already rendered) from
 * making the scan wait for something that is never coming.
 */
export function countPendingEmbedsInPage(): number {
  const SELECTORS = [
    '.hs-form-html', '.hbspt-form', '[data-hsfc-id="Renderer"]', '[data-form-id]',
    '.mktoForm', '[id^="mktoForm_"]',
    '.pardotForm', '.marketing-form',
    '[data-tf-widget]', '.typeform-widget',
    '.gform_wrapper', '.wpcf7',
    '.freshwidget-embedded-form', '.zf-templateWidth',
  ];
  let pending = 0;
  try {
    const seen = new Set<Element>();
    for (const sel of SELECTORS) {
      let nodes: Element[] = [];
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll(sel)) as Element[];
      } catch {
        continue; // an unsupported selector must never abort the count
      }
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.tagName === 'FORM') continue; // the form itself, already rendered
        if (el.querySelector('form')) continue; // its form is in
        if (el.querySelector('input, textarea, select')) continue; // a div-form is in
        pending += 1;
      }
    }
  } catch {
    return 0; // never let this break a scan
  }
  return pending;
}
