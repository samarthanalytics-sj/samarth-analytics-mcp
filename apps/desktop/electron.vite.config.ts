import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// The main bundle has several modules imported both statically and dynamically, which Rollup warns
// about ("dynamic import will not move module into another chunk") - a chunk-splitting notice, not a
// problem. Rather than printing ~10 near-identical multi-line blocks, collapse them: suppress each in
// onwarn, collect the module basenames, and print ONE grouped summary at the end of the main build.
const dynImportModules = new Set<string>();

const groupDynImportWarnings = {
  name: 'group-dynamic-import-warnings',
  closeBundle(): void {
    if (dynImportModules.size === 0) return;
    const list = [...dynImportModules].sort();
    console.log(`\n[VITE] Dynamic import warnings: ${list.length} module(s) have both static and dynamic imports (chunk-splitting only, no action needed):`);
    console.log('  ' + list.join(', '));
    dynImportModules.clear();
  },
};

// Three build targets — main (Node/Electron), preload (bridge), renderer (React).
// externalizeDepsPlugin keeps node/electron deps external in the main+preload
// bundles (they run in Node, not the browser). The renderer is a normal Vite
// React app. See https://electron-vite.org.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), groupDynImportWarnings],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        onwarn: (warning, warn) => {
          if (/dynamic import will not move module into another chunk/.test(warning.message)) {
            const m = /([^/\\\s()]+\.[cm]?ts)/.exec(warning.message); // first source-file basename
            if (m) dynImportModules.add(m[1]);
            return; // swallow the individual noisy warning; groupDynImportWarnings prints one summary
          }
          warn(warning);
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    // compact:false silences Babel's "code generator has deoptimised ... exceeds 500KB" note that
    // App.tsx triggers; it's a cosmetic dev-server log, not a real problem.
    plugins: [react({ babel: { compact: false } })],
  },
});
