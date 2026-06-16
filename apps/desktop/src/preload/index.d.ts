import type { DesktopApi } from './index';

// Makes `window.desktop` typed in the renderer (referenced from the renderer's
// env.d.ts). Keep this in sync with the api object in index.ts.
declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

export {};
