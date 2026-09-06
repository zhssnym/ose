import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { bridgePlugin } from './dev/bridge-plugin.mjs';

// Two entries: the app, and the host self-test page the host loads with --selftest (TAURI.md).
const entry = (name) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  base: './',
  define: { __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  plugins: [bridgePlugin()],
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    watch: { ignored: ['**/host/**', '**/dist-host/**', '**/legacy/**', '**/state.json', '**/node_modules/**', '**/ci/**', '**/src-tauri/target/**', '**/.trash/**'] },
  },
  build: {
    outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false,
    rollupOptions: { input: { main: entry('index.html'), selftest: entry('selftest.html') } },
  },
});
