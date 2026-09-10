// The seam between the page editor and the batch-12 packages (docs/CONTRACT.md batch 12).
//
// Each package owns exactly one module listed here and touches nothing else in this file:
// crepe.js asks `extensionPlugins` for ProseMirror plugins and `extensionFeatureConfigs` for
// Crepe feature options; index.js asks `registerExtensionCommands` once at boot and hands
// over a small API onto the open page. A module may export any of:
//
//   plugins(ctx, o)        -> Plugin[]   ProseMirror plugins, asked before Milkdown's own keymap
//                                        and before the block keymap (blocks.js), in list order
//   featureConfig(o)       -> { [CrepeFeature]: options }   merged over crepe.js's own configs
//   registerCommands(api)  -> void       commands.register(...) with `api` (see index.js editorApi)
//
// Order matters for keymaps: the table keymap must answer Enter and Tab inside a cell before
// anything else sees them, so `table` is first.

import * as table from './table.js';
import * as code from './code.js';
import * as commandsMod from './commands.js';
import * as menu from './menu.js';
import * as image from './image.js';
import * as source from './source.js';
import * as versions from './versions.js';
import * as backlinks from './backlinks.js';
import * as linkstate from './linkstate.js';
import * as wikitrigger from './wikitrigger.js';

const MODULES = [table, code, commandsMod, menu, image, source, versions, backlinks, linkstate, wikitrigger];

/** @returns {import('@milkdown/kit/prose/state').Plugin[]} */
export function extensionPlugins(ctx, o) {
  const out = [];
  for (const m of MODULES) {
    if (typeof m.plugins !== 'function') continue;
    try { out.push(...(m.plugins(ctx, o) || [])); } catch (e) { console.error('[editor] extension plugins', e); }
  }
  return out;
}

/** Feature configs merged one level deep, so a module can add a key without replacing ours. */
export function extensionFeatureConfigs(o, base) {
  const merged = { ...base };
  for (const m of MODULES) {
    if (typeof m.featureConfig !== 'function') continue;
    let cfg;
    try { cfg = m.featureConfig(o) || {}; } catch (e) { console.error('[editor] extension featureConfig', e); continue; }
    for (const [feature, options] of Object.entries(cfg)) {
      merged[feature] = { ...(merged[feature] || {}), ...(options || {}) };
    }
  }
  return merged;
}

export function registerExtensionCommands(api) {
  for (const m of MODULES) {
    if (typeof m.registerCommands !== 'function') continue;
    try { m.registerCommands(api); } catch (e) { console.error('[editor] extension commands', e); }
  }
}
