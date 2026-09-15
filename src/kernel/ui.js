// `ose:ui` (docs/KERNEL.md). The entry of the `ui.js` bundle, and nothing but a list of names.
//
// The code is in `ose:kernel`, which is external to this bundle: the kernel's own router, key
// engine and module loader raise the same dialogs and the same toasts, and there must be one
// overlay stack in a running Ose, not two. So `ose:ui` is a facade over `ose:kernel`, the
// emitted `ui.js` is twenty lines, and `import { toast } from 'ose:ui'` and the toast the
// kernel raises are the same queue.
//
// The stylesheet that goes with it is `ui.css` on the same origin.

export {
  openOverlay, closeTopOverlay, overlayCount, overlayHasInputFocus,
  focusOrigin, retargetFocusOrigin,
  prompt, confirm, choose,
  pickPage, pickFolder, pickFile,
  contextMenu,
  toast, dismissToast,
  copyText,
  pageTitle,
  icon, hasIcon, glyph,
  fuzzy, highlight, pageItems,
  loadingLine, loadingOverlay, LOADING_DELAY,
  esc,
} from 'ose:kernel';
