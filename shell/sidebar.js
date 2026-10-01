// Sidebar: one tree of the whole vault rooted at its name, then Trash. One
// scrolling column under a small tool strip. The vault is shown as it is on disk, the way a
// file manager shows it (H16, H20, M20, L8): every file with its real name and extension,
// folders first, nothing hidden by name. Dotfiles and files the OS marks hidden appear only
// while Show hidden items is on, greyed; `.ose`, `.git` and the exe are the host's to keep out
// and never arrive here (docs/HOST.md, the one hide rule).
//
// A folder row goes to the folder's own view (`{type:'folder'}`) on a click or Enter; its
// chevron, Left and Right fold it. A file row opens the file, whatever it is: the page host
// decides how (H17). Each folder sorts the way its folder view says (M22, `folder-model.js`),
// by name with numbers in number order unless the person chose otherwise.
//
// The tree is read once at boot (`ose.files.tree`) and then patched in place (M16): a batch
// of watcher changes re-lists only the folders those changes are in, and the app's own file
// operations do the same off their `paths:*` events. Only a watcher `rescan` or `lost`, or
// Show hidden items flipping, reads the whole tree again. An autosave of a page already in
// the tree touches that one node and draws nothing.
//
// Several rows can be selected at once (C17) and cut, copied, moved, trashed or dragged
// together. Create, rename, move, copy, duplicate and trash are not done here: every gesture
// of the tree ends in shell/fileops.js and from there in `ose.fileops`, which saves the open
// page first and refuses when it cannot (C6), and journals what it did so Ctrl+Z in the tree
// takes it back (M17). This file only follows what happened: expansion, the selection and the
// focused row.
//
// The sidebar is in parts: sidebar-state.js (what they share), sidebar-tree.js, sidebar-select.js,
// sidebar-load.js, sidebar-commands.js and sidebar-init.js. This file says what the sidebar
// exports.

export { allPages, allFiles, focusTree } from './sidebar-tree.js';
export { refreshTree, revealFolder } from './sidebar-load.js';
export { initSidebar } from './sidebar-init.js';
