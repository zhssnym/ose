// The folder view (H15): a folder is a place. `{ type: 'folder', path }` is a route like a page
// or a view — in the history, in a tab, in the address bar — and this file draws it: the
// folder's name, a small toolbar, the list of what is in it (name, type, modified, size, the
// way Explorer lays it out) and, under the list, the folder's README rendered as a note.
//
// The core draws nothing (docs/CORE.md "Folders"). `initFolder()` registers this file as
// the folder host (`ose.setFolderHost`) before `ose.init`, and the router calls `open` with the
// page column's scroller and the folder's path, then `refresh` on a file change and `unmount`
// on the way out. Home is this view of the vault root.
//
// The order is `folder-model.js`'s: folders first, then the folder's own sort, which is kept
// per folder and per machine in `ose.local('folders')` and read by the tree as well. What is
// hidden is the host's word (a dotfile, or the OS hidden attribute); Show hidden items draws
// it greyed. Nothing is hidden by name.
//
// The keyboard is Explorer's, inside the list: arrows, Home/End, type-ahead, Enter opens,
// Ctrl+Enter opens in a new tab, Backspace goes up, F2 renames, Delete trashes, Ctrl+X/C/V cut,
// copy and paste, Ctrl+Z undoes the last file operation, Ctrl+A selects everything. Every one
// of those ends in `shell/fileops.js`, the one UI for a file operation.
//
// The mouse's way to the same places is drag and drop (shell/drag.js): a row dragged onto a
// folder row, here or in the tree, moves; a drop from Explorer or Finder on a folder row or
// on the list's background is copied in; and Alt+drag takes the rows out of the app, as a
// copy.
//
// The folder view is in parts: folder-sort.js (what they share), folder-list.js and
// folder-view.js. This file says what the folder view exports.

export { folderRoute, folderName, sortSpec } from './folder-sort.js';
export { upFrom, initFolder } from './folder-view.js';
