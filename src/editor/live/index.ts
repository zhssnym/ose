// Live: the CodeMirror live-preview mode (docs/LIVE.md). The one module outside `live/`
// imports from.
//
// The file text is the only truth: a save writes `applyFormat(doc.toString(), format)` and
// nothing else, and the decorations that hide the markup off the caret's line only draw. The
// widgets (images, tables, maths, code) and the paste handler come from `./widgets/` and are
// handed in here, so the core itself never names one.

import './live.css';
import { WIDGETS, PASTE } from './widgets/index.ts';
import { createLiveView as createView } from './view.ts';
import {
  liveState as pureState, liveText, liveDecorations as pureDecorations, toggleTaskAt,
} from './state.ts';
import { LIVE_COMMANDS } from './commands.ts';

export { liveText, toggleTaskAt, LIVE_COMMANDS };

/**
 * Mount Live into `opts.host`, with the app's widgets and paste handler.
 */
export function createLiveView(opts: import('./view.ts').LiveOptions): import('./view.ts').LiveView {
  return createView({ widgets: WIDGETS, paste: PASTE, ...opts });
}

/**
 * Pure, no view: the state Live would hold for `text` (format field, language with the
 * widgets' parser extensions, focus), with an optional selection and focus.
 */
export function liveState(text: string, o: { path?: string; focused?: boolean; selection?: { from?: number; to?: number; anchor?: number; head?: number; }; } = {}) {
  return pureState(text, { widgets: WIDGETS, ...o });
}

/**
 * Every decoration Live would draw for `state` (inline ones over the whole document here).
 * For the property tests: never throws, never changes `state.doc`.
 */
export function liveDecorations(state: import('@codemirror/state').EditorState, o: { selection?: any; focused?: boolean; path?: string; } = {}) {
  return pureDecorations(state, { widgets: WIDGETS, ...o });
}
