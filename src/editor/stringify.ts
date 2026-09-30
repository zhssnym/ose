// remark-stringify configuration, the canonical clean-up of what it produces, and the pass
// that reconciles that canonical output with the file already on disk.
//
// Milkdown feeds STRINGIFY_OPTIONS straight into remark-stringify (see @milkdown/core `init`:
// the options are read once, after ConfigReady, to build the remark instance behind the parser
// and the serializer). They also seed the default `marker` attribute of the emphasis and strong
// marks, so `emphasis: '_'` is what a NEW italic gets; existing ones keep the marker they were
// written with, because the commonmark preset's remarkMarker plugin records it per node at
// parse time. That is why the vault's mix of `_x_` and `*x*` survives untouched.
//
// The pieces are in ./stringify/: write (the options and the handlers), cleanup, reconcile,
// blocks, markers and tables. This file says what the serializer exports.

export {
  STRINGIFY_OPTIONS, labelKey, withSerializeContext, definitionInScope, serializeContextKey,
  detectLineBreak, GFM_OPTIONS, configureStringify,
} from './stringify/write.ts';
export type { LineBreak } from './stringify/write.ts';
export { postProcess } from './stringify/cleanup.ts';
export { lineKey, reconcile } from './stringify/reconcile.ts';
export { blocks } from './stringify/blocks.ts';
export { detectStyle } from './stringify/markers.ts';
