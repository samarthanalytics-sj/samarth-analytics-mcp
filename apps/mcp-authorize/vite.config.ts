import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built to dist/, then served by the MCP Express server under /oauth/authorize.
// `base` is set so asset URLs resolve under that path.
export default defineConfig({
  plugins: [react()],
  base: '/oauth/authorize/',
  build: { outDir: 'dist', emptyOutDir: true },
});
