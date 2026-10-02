// What `ose:ui` is made of. The names live here and are re-exported twice: out of
// `core.ts`, because the core's own router and key engine use the same overlay stack and
// the same toast, and out of `ui.ts`, which is the `ose:ui` entry and does nothing but name
// them again from `ose:core`.
//
// That indirection is the point: there is exactly one overlay stack, one toast queue and one
// icon set in a running Ose. Two copies would mean Esc closing an overlay that is not the
// newest, which is the kind of bug a bundler makes in silence.
//
// The bricks are in src/ui; the stylesheet is src/ui/ui.css (tokens.css + base.css).

export {
  openOverlay, closeTopOverlay, overlayCount, overlayHasInputFocus,
  focusOrigin, retargetFocusOrigin, focusField,
  prompt, confirm, choose,
  contextMenu,
} from '../ui/overlay.ts';
export { toast, dismissToast } from '../ui/toast.ts';
export { copyText } from '../ui/clipboard.ts';
export { icon, hasIcon, glyph } from '../ui/icons.ts';
export { fuzzy, highlight } from '../ui/fuzzy.ts';
export { loadingLine, loadingOverlay, LOADING_DELAY } from '../ui/loading.ts';
export { esc } from '../ui/html.ts';
// The vault pickers are the core's (they read the vault), offered through `ose:ui` all the same.
export { pickPage, pickFolder, pickFile, pageTitle } from './pickers.ts';
export { pageItems } from './page-items.ts';
