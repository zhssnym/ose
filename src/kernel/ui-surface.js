// What `ose:ui` is made of. The names live here and are re-exported twice: out of
// `kernel.js`, because the kernel's own router and key engine use the same overlay stack and
// the same toast, and out of `ui.js`, which is the `ose:ui` entry and does nothing but name
// them again from `ose:kernel`.
//
// That indirection is the point: there is exactly one overlay stack, one toast queue and one
// icon set in a running Ose. Two copies would mean Esc closing an overlay that is not the
// newest, which is the kind of bug a bundler makes in silence.
//
// Everything here already existed as `src/shell/dialog.js`, `icons.js` and `fuzzy.js`. The
// stylesheet is `ui.css` (tokens.css + base.css); nothing here writes a colour.

export {
  openOverlay, closeTopOverlay, overlayCount, overlayHasInputFocus,
  focusOrigin, retargetFocusOrigin,
  prompt, confirm, choose,
  pickPage, pickFolder, pickFile,
  contextMenu,
  toast, dismissToast,
  copyText,
  pageTitle,
} from './dialog.js';

export { icon, hasIcon, glyph } from './icons.js';
export { fuzzy, highlight, pageItems } from './fuzzy.js';
export { loadingLine, loadingOverlay, LOADING_DELAY } from './loading.js';
export { esc } from './registry.js';
