// The kit (src/ui): the bricks every part of the page draws with, and nothing that knows a
// vault. The stylesheet is ui.css beside it (tokens.css + base.css), imported by the shell.

export {
  openOverlay, closeTopOverlay, overlayCount, overlayHasInputFocus,
  focusOrigin, retargetFocusOrigin, focusField,
  prompt, confirm, choose,
  contextMenu,
} from './overlay.ts';
export { toast, dismissToast } from './toast.ts';
export { copyText } from './clipboard.ts';
export { icon, hasIcon, glyph } from './icons.ts';
export { fuzzy, highlight } from './fuzzy.ts';
export { loadingLine, loadingOverlay, LOADING_DELAY } from './loading.ts';
export { esc } from './html.ts';
