// The seam between the page editor and the feature packages built on top of it.
//
// Each package owns exactly one module listed here and touches nothing else in this file:
// crepe.ts asks `extensionPlugins` for ProseMirror plugins and `extensionFeatureConfigs` for
// Crepe feature options; page/commands.ts asks `registerExtensionCommands` once at boot and hands
// over a small API onto the open page. A module may export any of:
//
//   plugins(ctx, o)        -> Plugin[]   ProseMirror plugins, asked before Milkdown's own keymap
//                                        and before the block keymap (blocks.ts), in list order
//   featureConfig(o)       -> { [CrepeFeature]: options }   merged over crepe.ts's own configs
//   registerCommands(api)  -> void       commands.register(...) with `api` (see page/commands.ts editorApi)
//
// Order matters for keymaps: the table keymap must answer Enter and Tab inside a cell before
// anything else sees them, so `table` is first.

import * as table from './table.ts';
import * as math from './math-node.ts';
import * as space from './space.ts';
import * as code from './code.ts';
import * as commandsMod from './commands.ts';
import * as menu from './menu.ts';
import * as image from './image.ts';
import * as source from './source.ts';
import * as versions from './versions.ts';
import * as backlinks from './backlinks.ts';
import * as linkstate from './linkstate.ts';
import * as wikitrigger from './wikitrigger.ts';

/**
 * What a module may export; each one exports only the hooks it needs.
 */
const MODULES: Array<{ plugins?: Function; featureConfig?: Function; registerCommands?: Function;[name: string]: unknown; }> = [table, math, space, code, commandsMod, menu, image, source, versions, backlinks, linkstate, wikitrigger];

export function extensionPlugins(ctx, o): import('@milkdown/kit/prose/state').Plugin[] {
  const out: any[] = [];
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
