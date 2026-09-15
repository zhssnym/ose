// The browser dev server. Two jobs, and they are the same job:
//
// 1. Serve the rice as plain files, exactly as the host serves `.ose/app`, so the stock
//    cockpit runs in Chrome against the Node bridge with no build step of its own. The root is
//    `cockpit/` as soon as K2 creates it; until then it is the repo root and the old
//    `index.html` (the batch-12 app) is what comes up, so nothing stops working mid-wave.
//    `OSE_RICE=legacy` forces the old page back; `OSE_RICE=<dir>` serves another rice.
// 2. Resolve the four `ose:*` specifiers to the kernel sources, so a rice file and a module
//    file are byte-for-byte the same in the browser and in the host. In the host these come
//    from the import map the kernel injects (docs/KERNEL.md); here they are aliases.
//
// `npm run dev` is 5173 against the real vault; `npm run dev:test` is 5174 against
// `work/vault` (dev/test-server.mjs). Both run this config.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { bridgePlugin } from './dev/bridge-plugin.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

// The rice folder. `OSE_RICE` names one; `legacy` is the old page on purpose; otherwise
// `cockpit/` when it is there, and the repo root when it is not.
const asked = process.env.OSE_RICE || '';
const cockpit = here('cockpit/index.html');
const riceRoot = asked && asked !== 'legacy' ? asked
  : (!asked && existsSync(cockpit) ? here('cockpit') : here('.'));

// `ose:editor` is K1c's entry. Aliasing a file that is not there yet would break every page,
// so it joins the map when it exists.
const alias = {
  'ose:kernel': here('src/kernel/kernel.js'),
  'ose:ui': here('src/kernel/ui.js'),
  'ose:md': here('src/kernel/md.js'),
};
if (existsSync(here('src/editor/lib.js'))) alias['ose:editor'] = here('src/editor/lib.js');

// One entry for the old build: the batch-12 app, kept alive until K2 deletes it. The host
// self-test page is no longer built here — it links `./ui.css`, which only exists beside it in
// `dist-kernel/`, and the host loads it from the kernel origin now (docs/TAURI.md). It is an
// entry of vite.kernel.config.js instead.
const entry = (name) => here(name);

// `root` is the rice for the dev server and the repo root for `vite build`. They are the same
// folder until the cockpit exists, and different the moment K2 creates it: the dev server has
// to serve the new rice, while the only thing this config still *builds* is the old
// `index.html`, whose `/src/main.js` resolves against the repo root and nowhere else. Without
// the split, `npm run build` fails on "Failed to resolve /src/main.js" the day the cockpit
// lands. The whole legacy half goes when K2's step 4 deletes `index.html` and `npm run build`
// becomes `build:kernel`.
export default defineConfig(({ command }) => ({
  base: './',
  root: command === 'build' ? here('.') : riceRoot,
  resolve: { alias },
  define: { __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  plugins: [bridgePlugin()],
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    // The rice may be a folder beside the repo; the kernel sources it imports are inside it.
    fs: { allow: [here('.'), riceRoot] },
    watch: { ignored: ['**/host/**', '**/dist-host/**', '**/dist-kernel/**', '**/legacy/**', '**/state.json', '**/node_modules/**', '**/ci/**', '**/src-tauri/target/**', '**/.trash/**'] },
  },
  build: {
    outDir: here('dist'), emptyOutDir: true, target: 'es2022', sourcemap: false,
    rollupOptions: { input: { main: entry('index.html') } },
  },
}));
