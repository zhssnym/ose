// The browser dev server. Two jobs, and they are the same job:
//
// 1. Serve the rice as plain files, exactly as the host serves `.ose/app`, so the stock
//    cockpit runs in Chrome against the Node bridge with no build step of its own. The root is
//    `cockpit/`; `OSE_RICE=<dir>` serves another rice.
// 2. Resolve the four `ose:*` specifiers to the kernel sources, so a rice file and a module
//    file are byte-for-byte the same in the browser and in the host. In the host these come
//    from the import map the kernel injects (docs/KERNEL.md); here they are aliases.
//
// `npm run dev` is 5173 against the real vault; `npm run dev:test` is 5174 against
// `work/vault` (dev/test-server.mjs). Both run this config. Building is
// vite.kernel.config.js's job (`npm run build`): the kernel bundles, the fallback page and the
// self-test page into dist-kernel/, which the host embeds.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { bridgePlugin } from './dev/bridge-plugin.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

const riceRoot = process.env.OSE_RICE || here('cockpit');

const alias = {
  'ose:kernel': here('src/kernel/kernel.js'),
  'ose:ui': here('src/kernel/ui.js'),
  'ose:md': here('src/kernel/md.js'),
  'ose:editor': here('src/editor/lib.js'),
};

export default defineConfig({
  base: './',
  root: riceRoot,
  resolve: { alias },
  define: { __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  plugins: [bridgePlugin()],
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    // The rice may be a folder beside the repo; the kernel sources it imports are inside it.
    fs: { allow: [here('.'), riceRoot] },
    watch: { ignored: ['**/host/**', '**/dist-host/**', '**/legacy/**', '**/state.json', '**/node_modules/**', '**/ci/**', '**/src-tauri/target/**', '**/.trash/**', '**/work/vault/**'] },
  },
});
