// `ose:editor` — the bundle (docs/KERNEL.md).
//
//   markdownPage(el, path, opts)  the block editor: title strip, properties, autosave,
//                                 changed-on-disk, versions, source mode, find and replace,
//                                 drop, links, backlinks, tables, code blocks, images, maths,
//                                 and every command and chord the editor has.
//   codeEditor(el, opts)          CodeMirror over a file or a string.
//   render(markdown, opts)        the same markdown, read-only, as DOM.
//   renderMath(tex, opts)         one formula, rendered with Temml to MathML.
//
// Everything the bundle needs from outside comes through `host.js` (the kernel: `ose:kernel`,
// `ose:ui`, `ose:md`) and nothing else. The stylesheet is `editor.css` on the kernel origin:
// the bundler concatenates every `src/editor/*.css` this graph imports, plus the Crepe theme,
// into that one file — `editor.css` itself, `code.css`, `table.css`, `source.css`,
// `backlinks.css`, `render.css`, in that graph's order. No absolute URL is written anywhere
// inside it: a vault image goes through `ose.files.assetUrl`.

export { markdownPage } from './page.js';
export { codeEditor } from './code-editor.js';
export { render } from './render.js';
export { renderMath } from './math.js';

/**
 * The page-level commands (`page.new`, `page.save`, `page.rename`…) without a page mounted, so
 * the shell can offer "New page" on its start surface. Answers the function that gives the
 * reference back; a mounted page holds one of its own either way.
 */
export { acquireCommands as holdPageCommands } from './page.js';
