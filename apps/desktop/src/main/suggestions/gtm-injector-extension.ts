import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Build a throwaway unpacked Chrome extension that injects a GTM container's PLAIN gtm.js snippet into
// every non-Google page - the automated equivalent of the Adswerve "Inject Code" flow the operator proved
// by hand. The container enters PREVIEW/debug from the Tag Assistant link opened in the SAME browser (that
// establishes the preview session); the injector only puts the container's gtm.js on the page, exactly
// like Adswerve does. Written fresh each run with the id baked in, so nothing persists. Returns the
// extension directory to hand to Chromium's --load-extension.
export async function writeInjectorExtension(containerId: string): Promise<string> {
  const id = containerId.trim().toUpperCase();
  // Guard: the id becomes a literal in generated JS and a network request; only ever a real GTM id.
  if (!/^GTM-[A-Z0-9]+$/.test(id)) {
    throw new Error(`Refusing to build the GTM injector for an invalid container id: ${containerId}`);
  }
  const dir = join(tmpdir(), 'samarth-gtm-injector');
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(dir, { recursive: true });

  const manifest = {
    manifest_version: 3,
    name: 'Samarth GTM Injector',
    version: '1.0.0',
    description: 'Injects a GTM container for tag verification (like Adswerve Inject Code). Verification use only.',
    content_scripts: [
      { matches: ['<all_urls>'], js: ['inject.js'], run_at: 'document_start', all_frames: false },
    ],
  };

  // This runs in the PAGE's main world (injected via a <script> element) so the gtm.start push lands on the
  // page's own dataLayer and gtm.js boots exactly as if the site shipped the snippet. `i+'__inj'` guards a
  // double-load if the content script somehow runs twice.
  const pageCode =
    '(function(w,d,i){try{' +
    "if(w[i+'__inj'])return;w[i+'__inj']=1;" +
    'w.dataLayer=w.dataLayer||[];' +
    "w.dataLayer.push({'gtm.start':new Date().getTime(),event:'gtm.js'});" +
    "var j=d.createElement('script');j.async=true;" +
    "j.src='https://www.googletagmanager.com/gtm.js?id='+i;" +
    '(d.head||d.documentElement).appendChild(j);' +
    '}catch(e){}})(window,document,' + JSON.stringify(id) + ');';

  // The content script (isolated world) never touches the page's dataLayer directly - it injects a <script>
  // element carrying pageCode, which the browser executes in the main world. Skips Google's own origins so
  // we never inject onto tagassistant.google.com / gstatic / googletagmanager itself.
  const contentScript =
    '(function(){try{' +
    "var h=location.hostname||'';" +
    'if(/(^|\\.)google\\.com$/i.test(h)||/(^|\\.)gstatic\\.com$/i.test(h)||/(^|\\.)googletagmanager\\.com$/i.test(h))return;' +
    "var el=document.createElement('script');" +
    'el.textContent=' + JSON.stringify(pageCode) + ';' +
    '(document.head||document.documentElement).appendChild(el);' +
    'el.remove();' +
    '}catch(e){}})();';

  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(join(dir, 'inject.js'), contentScript, 'utf8');
  return dir;
}
