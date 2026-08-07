import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Our own workspace packages are bundled rather than externalized, so the built
// main process does not depend on the workspace symlink layout at runtime.
const internal = ['@agent-watcher/protocol', '@agent-watcher/agent-adapters'];

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
