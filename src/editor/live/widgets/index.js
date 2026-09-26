// Live's widgets (docs/LIVE.md, "Widgets"): what the core draws for images, tables, maths and
// code, and the paste handler. The core imports these two names, and `pendingPastes` for the
// page, and nothing else from here.
//
// Images and maths register twice, an inline half and a block half, because CodeMirror takes
// block decorations only from a state field (registry.js `kind`): an image alone on its line
// and a display formula are blocks, the rest is inline. Every widget only draws; the one
// gesture a widget answers is a click that moves the caret.

import './widgets.css';
import { code } from './code.js';
import { image, imageBlock } from './image.js';
import { math, mathBlock } from './math.js';
import { paste } from './paste.js';
import { table } from './table.js';

/** @type {import('../registry.js').LiveWidget[]} */
export const WIDGETS = [image, imageBlock, table, math, mathBlock, code];

/** @type {((ctx: import('../registry.js').PasteContext) => import('@codemirror/state').Extension) | null} */
export const PASTE = paste;

/**
 * Resolves when every paste and drop a Live view has in the air has landed (or is held while the
 * view is read-only). A mode switch awaits it before it freezes the view and takes its text.
 */
export { pendingPastes } from './paste.js';
