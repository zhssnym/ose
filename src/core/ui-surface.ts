// What `ose:ui` is made of. The names live here and are re-exported twice: out of
// `core.ts`, because the core's own router and key engine use the same overlay stack and
// the same toast, and out of `ui.ts`, which is the `ose:ui` entry and does nothing but name
// them again from `ose:core`.
//
// That indirection is the point: there is exactly one overlay stack, one toast queue and one
// icon set in a running Ose. Two copies would mean Esc closing an overlay that is not the
// newest, which is the kind of bug a bundler makes in silence.
//
// Everything here was once the shell's own dialog, icon and fuzzy modules. The stylesheet is
// `ui.css` (tokens.css + base.css); nothing here writes a colour.

export {
  openOverlay, closeTopOverlay, overlayCount, overlayHasInputFocus,
  focusOrigin, retargetFocusOrigin, focusField,
  prompt, confirm, choose,
  pickPage, pickFolder, pickFile,
  contextMenu,
  toast, dismissToast,
  copyText,
  pageTitle,
} from './dialog.ts';

export { icon, hasIcon, glyph } from './icons.ts';
export { fuzzy, highlight, pageItems } from './fuzzy.ts';
export { loadingLine, loadingOverlay, LOADING_DELAY } from './loading.ts';
export { esc } from './registry.ts';
