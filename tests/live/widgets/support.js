// Helpers for the widget tests: a Live-like state (the core's language, these widgets' parser
// extensions), the nodes of a type, and a widget context with nothing revealed.

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { collect } from '../../../src/editor/live/registry.js';
import { liveLanguage } from '../../../src/editor/live/syntax.js';
import { WIDGETS } from '../../../src/editor/live/widgets/index.js';

/** A state over `doc` with Live's language and the widgets' syntax, fully parsed. */
export function stateOf(doc, extensions = []) {
  const state = EditorState.create({ doc, extensions: [liveLanguage(collect(WIDGETS)), ...extensions] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** Every node named `name`, as refs that outlive the walk. */
export function nodesOf(state, name) {
  const out = [];
  syntaxTree(state).iterate({ enter(n) { if (n.name === name) out.push(n.node); } });
  return out;
}

/**
 * @param {EditorState} state
 * @param {Partial<import('../../../src/editor/live/registry.js').WidgetContext>} [over]
 * @returns {import('../../../src/editor/live/registry.js').WidgetContext}
 */
export function ctxOf(state, over = {}) {
  return {
    state,
    path: 'notes/page.md',
    revealed: () => false,
    resolveAsset: (src) => `vault://${src}`,
    openLink: () => {},
    inlineHtml: (md) => String(md).replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`),
    ...over,
  };
}

/** Run `widget.decorate` over every node it names; answers what went into the sink. */
export function decorations(widget, ctx) {
  const out = [];
  for (const name of widget.nodes) {
    for (const node of nodesOf(ctx.state, name)) {
      widget.decorate(ctx, node, { add: (from, to, deco) => out.push({ from, to, deco }) });
    }
  }
  return out;
}
