// `ose:ui` for the headless tests (vitest.config.js): every name the editor and the planner import, doing
// nothing. A dialog answers "cancelled" (null), a toast answers its kill function.

const none = () => undefined;
export const confirm = async () => false;
export const prompt = async () => null;
export const toast = () => none;
export const contextMenu = none;
export const copyText = async () => true;
export const esc = (s) => String(s ?? '');
export const fuzzy = () => null;
export const highlight = (s) => String(s ?? '');
export const icon = () => '';
export const openOverlay = () => ({ close: none, el: null });
export const pageItems = () => [];
export const pickPage = async () => null;
// The planner's settings fragment (src/planner/settings.ts) imports the two pickers.
export const pickFile = async () => null;
export const pickFolder = async () => null;
