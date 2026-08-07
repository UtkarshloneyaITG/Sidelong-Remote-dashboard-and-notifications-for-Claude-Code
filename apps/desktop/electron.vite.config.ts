import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Bundled rather than externalized, so the built main process has NO runtime
// node_modules at all. That matters twice over: it does not depend on the
// workspace symlink layout, and packaging does not have to resolve hoisted
// dependencies out of the monorepo root. `ws` is pure JS (its native accelerators
// are optional and guarded), so it bundles cleanly.
const internal = ['@agent-watcher/protocol', '@agent-watcher/agent-adapters', 'ws'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: internal })],
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: internal })],
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
