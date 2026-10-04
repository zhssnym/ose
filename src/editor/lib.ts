// The editor (src/editor), loaded on its own by the shell (docs/CORE.md).
//
//   markdownPage(el, path, opts)  the page editor: title strip, properties, autosave, drafts,
//                                 changes made on disk merged in (H7), versions, the Rich |
//                                 Source switch, find and replace, drop, links, backlinks,
//                                 tables, code blocks, images, maths, and every command and
//                                 chord the editor has. Any text file opens in it; markdown
//                                 gets the rich view, everything else plain source (H17).
//                                 One live instance per file: a page whose tab goes to the
//                                 background is parked (`handle.park()`) and the next
//                                 `markdownPage` of that path puts the same one back (M12).
//   codeEditor(el, opts)          CodeMirror over a file or a string, with the page's drafts
//                                 and the leave gate when it is given a path.
//   render(markdown, opts)        the same markdown, read-only, as DOM.
//   renderMath(tex, opts)         one formula, rendered with Temml to MathML.
//
// Everything the editor needs from outside comes through `host.ts` (the core, src/core, and
// the kit, src/ui) and nothing else. Its stylesheets are imported by the files that use them:
// Vite bundles every `src/editor/*.css` this graph imports, plus the Crepe theme, with the
// editor's chunk — `editor.css` itself, `code.css`, `table.css`, `source.css`,
// `backlinks.css`, `render.css`, in that graph's order. No absolute URL is written anywhere
// inside it: a vault image goes through `ose.files.assetUrl`.

export { markdownPage } from './page.ts';
export { codeEditor } from './code-editor.ts';
export { render } from './render.ts';
export { renderMath } from './math.ts';

/**
 * The page-level commands (`page.new`, `page.save`, `page.save-as`…) without a page mounted, so
 * the shell can offer "New page" on Home. Answers the function that gives the reference back;
 * a mounted page holds one of its own either way.
 */
export { acquireCommands as holdPageCommands } from './page.ts';

/**
 * The two halves of a rename, a move, a trash or a copy, for every live page at or under the
 * path, on screen or parked (C6). The shell's page host hands them on to `ose.fileops`:
 *
 *   beforePathChange({kind, from, to})      -> Promise<{ok, reason?}>  flush, or refuse
 *   afterPathChange({kind, from, to, ok})   -> Promise<void>           follow, or stay
 *
 * `saveAll({explicit, closing})` saves every live page and answers false when any of them
 * could not be saved.
 */
export { beforePathChange, afterPathChange, saveAll } from './page.ts';

/**
 * The page host's wave-2 calls (docs/CORE.md, the page host):
 *
 *   releasePage(path)                 -> Promise<boolean>  PageHost.release: the parked page of
 *                                        `path` is saved and destroyed; false = it could not be
 *                                        saved, and it stays
 *   parkedPaths()                     -> string[]          the parked pages, most recent first
 *   rewriteLinksIn(path, pairs, opts) -> Promise<{handled, changed, failed?}>  PageHost
 *                                        .rewriteLinksIn: an open page's links into moved files
 *                                        are rewritten in the editor, not on disk (H5)
 */
export { releasePage, parkedPaths, rewriteLinksIn } from './page.ts';

/**
 * `problemPages()` -> string[]: the pages, on screen or parked, whose text could not be saved
 * (not saved, a conflict, or deleted). PageHost.problems hands it to the leave gate.
 */
export { problemPages } from './page.ts';
