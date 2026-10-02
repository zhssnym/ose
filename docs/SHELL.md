# The shell

The shell is the whole interface: the toolbar with its path bar, the tab strip, the
sidebar's one tree, the folder view, the palette and Go to file, the search panel, the
Settings page, the Trash view and the vault chooser. It is plain ES modules and
CSS, no bundler, copied verbatim into the build and served beside the core's bundles
(docs/HOST.md). It is not the core: it draws, and it calls the hoses of `docs/CORE.md` like anything else.

The window around it is Chrome's own, a tab or, once Ose is installed, an app window (X9, D11).
The shell draws no window button, no resize edge and no drag region; its top row is a plain
toolbar.

The planner (Day, Week, Month, Journal) is not in the shell either. It is `src/planner`, one
bundle `ose:planner` that ships beside the core and the editor, and the shell
loads it at boot. Its file formats are `docs/FORMATS.md`.

## Layout

```
shell/
  index.html        the page: the import map, the stylesheets in cascade order (below) and two
                    module scripts, first-paint.js then main.js. Every path in it is relative
                    and flat (`./main.js`), because the build copies `shell/` into `dist/`
                    as it is. The CSP allows no inline script but the import map.
  first-paint.js    theme and platform onto <html> before the first paint
  main.js           the entry: imports boot.js, and puts boot-error.js up when anything throws
  boot.js           the boot, below
  boot-error.js     the page a failed boot leaves (imports nothing)
  layout.js         the frame: toolbar, sidebar, page column, side panel
  titlebar.js       the toolbar: the sidebar's fold, back, forward, New file, the path bar
  tabs.js           the strip, drawn from the core's tabs
  sidebar.js        the one tree
  folder.js         the folder view
  folder-model.js   the folder view's pure model: the order, labels, README, parent
  start.js          where the app opens: the last session, else Home (the vault folder)
  trash.js          the Trash view
  fileops.js        New file…, New folder, Rename…, Move to…, Duplicate, trash, cut, copy,
                    paste, undo, Open file…, Copy into the vault…: the one UI for them
  drag.js           drag in from the OS and drag out to it, for the tree and the folder view
  page.js           the page seam (text, images, PDFs, binary files)   media.js  media.css
  palette.js        the command palette and Go to file
  search.js         search, in the side panel
  settings.js       the Settings page
  recover.js        the Recovered changes sheet
  vault.js          the vault chooser, the change-vault dialogs
  host.js           is this a real window, and the one window hose left
  paths.js          path helpers, and the shared vaultName, errorOf and keyOf
  order.js
  shell.css         the frame, overlays, the vault chooser, search, settings,
                    Go to file, the empty and miss boxes, the boot error page
  tree.css          the tree
  places.css        the toolbar, the path bar, the tabs, the page column, the resizers
  folder.css        the folder view
  theme.css         token overrides; empty on purpose
  keys.json         the shell's chords, below
  logo.png
```

`index.html` carries the import map and then links the stylesheets in this order, so every later
sheet wins over an earlier one and `theme.css` wins over everything:

```html
<script type="importmap">{"imports":{"ose:core":"./ose/core.js","ose:editor":"./ose/editor.js","ose:planner":"./ose/planner.js","ose:ui":"./ose/ui.js"}}</script>
<link rel="stylesheet" href="./ose/ui.css">
<link rel="stylesheet" href="./ose/editor.css">
<link rel="stylesheet" href="./ose/planner.css">
<link rel="stylesheet" href="./shell.css">
<link rel="stylesheet" href="./tree.css">
<link rel="stylesheet" href="./places.css">
<link rel="stylesheet" href="./folder.css">
<link rel="stylesheet" href="./theme.css">
```

The build copies `shell/` verbatim into `dist/`, beside the core's four bundles in `dist/ose/`,
and any static host serves `dist/` (Vercel, `vercel.json`). The import map is the one inline
script of the page; the build hashes it into the page's CSP `<meta>` (vite.config.js). In the
dev server the map is inert, because Vite rewrites every `ose:*` import itself, and the dev server
answers `/ose/*.css`. No file of the shell names an origin.

## How it loads

```
ose.ready -> settings.apply -> vault chooser | mountShell
          -> initPageHost -> initFolder -> initHome -> initTabs
          -> ose.init({start:false}) -> initPalette -> initSearch -> initSettings -> initFileOps
          -> initTrash -> initRecover -> loadKeys
          -> loadPlanner -> startSurface -> 'booted' -> offerRecovered
```

1. `main.js` imports `boot.js` dynamically and calls `boot()`, which starts the editor bundle
   downloading (`page.js loadEditor`), awaits `ose.ready`, puts the platform on `<html>` and
   applies the reading settings before anything is drawn.
2. No vault: `vault.js` mounts the chooser. The shell is not built at all, and it starts again
   on the answer.
3. `mountShell()`, then the page host (which waits for the editor bundle) and the folder host,
   Home and the tab strip, all before `ose.init`: the router mounts with the shell, Home has to
   be a registered view (and the fallback of the last tab) before anything navigates to it, and
   the strip has to be listening before the first route event.
4. `ose.init({ page, start: false })`: the theme, the key engine and the router into the shell's
   page column. `start: false` because the shell decides where the app opens.
5. The palette, search, Settings, the file operations, Trash and Recovered changes register
   their commands; then `keys.json` is bound.
6. `loadPlanner()` is `import('ose:planner').then(m => m.initPlanner(ose))`. The planner
   registers its four views, its commands and its section of Settings itself. A planner that
   fails to load is logged and said in one error toast, and the boot goes on without it.
7. `startSurface()` (start.js): with `restoreSession` on and a usable session, the last session's
   tabs come back (`ose.session.restore()`), only the active one mounted; otherwise Home. The
   files the OS asked the installed app to open (a double click, Open with) then open over them, each in a tab of its own, the last one in front: that is the
   core's (`opens.js`, docs/CORE.md), and the shell does nothing for it.
8. `ose.bus.emit('booted')`, then `offerRecovered()`: the Recovered changes sheet, when there are
   drafts.
9. Once per vault on this machine, when the vault still has a `.ose/plugins` folder from before
   the planner was built in, one toast says it is no longer used and can be deleted.
   Nothing is deleted for the user. The flag is `ose.local('notices')`.

**A boot that fails** (M38) never leaves a blank window. Whatever throws on the way ends on one
page (`boot-error.js`): "Ose could not start", how far the boot got, the error, the stack under
a disclosure, where the log is, and **Copy details** and **Try again**. `boot-error.js` imports
nothing and `main.js` reaches `boot.js` by a dynamic import, so a module that fails to load
cannot take the page down with it. An editor bundle that fails to evaluate costs the pages only:
they open as plain text, and one sticky toast says why.

### keys.json

The window map is the core's (`ose.keys.defaults()`, with its macOS alternates and in-body
rules that JSON cannot say). `keys.json` adds the shell's chords over it; a chord here wins over
a core default for the same combo. A body key (a chord the editor binds inside a page, such as
Alt+Up for `block.move-up`) still wins while the caret is in the editor, and the `keys.json`
binding of the same chord applies everywhere else.

| chord | command |
|---|---|
| `mod+p` | `app.quickopen` (Go to file; Ctrl+O is the core's) |
| `mod+shift+p` | `app.palette` |
| `mod+alt+p` | `page.export-pdf` |
| `mod+alt+n` | `file.new` |
| `f2` | `file.rename` |
| `mod+shift+j` | `journal.today` |
| `alt+arrowup` | `folder.up` |
| `mod+t` | `tab.new` |

The palette lists every command with its chord.

Ctrl+R is bound to nothing. The web view's own reload keys (F5, Ctrl+R, Ctrl+Shift+R and the
keyboard's Back, Forward and Refresh keys) are refused by `layout.js` in the capture phase,
because each of them threw the page away.

`theme.css` is the one place the look is changed: token overrides only, never a rule and never a
hex value anywhere else.

## Places: routes, tabs, Home

A place is a route (docs/CORE.md): a page (`{type:'page', path}`), a folder
(`{type:'folder', path}`, `''` being the vault root) or a view (`{type:'view', name}`: Home,
Settings, Trash, Day, Week, Month, Journal). Every one of them has history, a tab, a window title
and a place in the session.

**Tabs with history** (M23). The core owns the tabs (`ose.tabs`) and each tab has its own back
and forward. One route is mounted in the one page column: the active tab's current entry.
`tabs.js` only draws the strip from `ose.tabs.on` snapshots and registers the tab commands.

- An ordinary open replaces what is in the tab you are looking at: a click or Enter in the tree
  or a folder, Go to file, a followed link, back, forward. The strip never grows on its own.
- A tab is made on purpose: the middle button or Ctrl+Enter on a row, Ctrl+Enter on a search
  hit, `tab.new` (Ctrl+T, which opens Home), and `app.reopen-closed` (Ctrl+Shift+T, which brings
  a closed tab back with its whole history).
- A route that already has a tab is brought to the front rather than duplicated, by its route
  key.
- Back and forward (Alt+Left and Alt+Right, Cmd+[ and Cmd+] on a Mac, the mouse's buttons 4 and
  5, and the two arrows in the toolbar) act on the active tab.
- Closing the last tab sends it to Home, so the strip is never empty. One tab is no strip: it
  appears at two.
- Switching tabs does not tear a page down: the editor parks it, buffer, undo and all, and the
  page comes back as it was left (M12, M24).
- A tab's label is the file's name (`ose.names.display`), a folder's name, or a view's title,
  with the full path as its tooltip. The dirty dot and the error mark come from `doc:state`.
- A tab whose file is outside the vault wears the word "outside vault" after its name, has
  the file's whole absolute path in its tooltip, and says "outside vault" in its accessible
  name (below, "Files outside the vault").
- A page that is trashed turns into its folder, with the file's name selected, in every tab
  that was showing it.

**Session restore** (H19). The tabs, each tab's history, the active tab, and the scroll and
selection of each place are saved per machine and per vault (`ose.local('session')`) while
`restoreSession` is on, which it is by default. The app opens on them; a tab whose file is gone
shows the router's miss box when it is activated. Settings › Files › Restore tabs at start
turns it off, and then the app opens on Home.

**Home** (`start.js`, `app.home`) is the vault root's folder view: where a new tab starts and
where the last closed tab goes. The planner's views are in the palette and on their chords.

**The folder view** (H15, `folder.js`). A folder route draws the folder's name and item count, a
toolbar (New file…, New folder, Paste, Undo, Show hidden items; each also a command),
and one list with Name, Type, Modified and Size. Folders come first, then everything by name
(natural order), here and in the tree. The folder's `README.md` (or `index.md`) is rendered read-only below
the list, with an Edit button. Keys in the list: Up, Down, Home, End and type-ahead move; Enter
opens (a folder as a folder route, a file as a page); Ctrl+Enter opens in a new tab; Backspace
goes to the parent; F2 renames; Delete trashes; Ctrl+X, C and V cut, copy and paste; Ctrl+Z
undoes the last file operation; Shift and Ctrl clicks select several. `folder.up` (Alt+Up, not
while the caret is in the editor) goes to the parent folder from anywhere, and from a page to its
folder with the file selected. With the mouse, a row dragged onto a folder row (here or in the
tree) moves, a drop from Explorer or Finder on a folder row or on the list's background is
copied in, and Alt+drag takes the rows out as a copy ("Drag in and out", below).

**The path bar** (M21, `titlebar.js`). The active place as segments: the vault's name, each
folder, the file's name, each folder a button to that folder (Ctrl+click: a new tab). A page
outside the vault reads "Outside the vault › its folder › its name", and only the name is a
place.

## The sidebar: one tree

At the top of the sidebar is a small tool strip: New file, New folder, Collapse all, and Show
hidden items as a toggle that shows whether it is on. Then the tree, then Trash.

`sidebar.js` is one tree whose root row is the vault's name. The root and every folder row open
the folder view on a click or Enter; the chevron, Left and Right expand and collapse. Folders
come first, then files, by name. Every row shows the full
name; the glyph says text, image, code or other. Hidden items (a dot name or the system's hidden
attribute) appear only while Show hidden items is on, greyed. A link carries a badge whose
tooltip names what it points at. A folder that could not be read has a "no permission" line.
`.ose` and `.git`, the executable at the root, and the atomic writer's temp files are never
listed (the host's one hide rule, docs/HOST.md). Nothing is hidden by name: `App`, `dist` and
`node_modules` are ordinary folders.

The last row is **Trash**, which opens the Trash view.

The tree is walked once at boot; after that, a batch of file changes, and the app's own
`paths:*` events, re-list only the parent folders they touch (a save only restats its file). A
rescan, a lost watcher or flipping Show hidden items re-walks. Folders deeper than the first walk
are listed when they are unfolded.

Keys on the tree: Enter opens; F2 renames; Delete trashes (Cmd+Backspace on a Mac; a lone
Backspace never does); Ctrl+X, C and V cut, copy and paste; Ctrl+Z undoes the last file
operation; Ctrl+Enter or the middle button opens in a new tab; Shift+F10 or the Menu key opens
the context menu; Esc clears the selection, then a pending cut, then returns to the page. The context menu runs
each command with the row under the pointer. Nothing enters focus mode but its own command,
`app.focus-enter` (Focus folder); while a folder is in focus the toolbar carries a chip that
leaves it.

The sidebar folds with `app.sidebar` (Ctrl+\) or the chevron in the toolbar's left corner, can
be widened up to 60 % of the window, and hides itself under 640px of window, so a window at its
480px minimum is the toolbar and the page. Its width and open state are this
machine's (`ose.local('sidebar')`). `app.full-width` flips Settings' full width.

A row dragged onto a folder row moves (the selection drags together); a drop from the OS on a
folder row is copied in; Alt+drag takes the rows out as a copy ("Drag in and out", below).

## The side panel and search

`layout.js` exports `panel`: a resizable aside to the right of the page column, hidden until
something opens in it, its width remembered on this machine (`ose.local('panel')`). Search is
what lives in it today (`panel.open('search', mount, { title: 'Search' })`).

**Search** (M25, `search.js`). `app.search` (Ctrl+Shift+F) opens the panel, or puts the caret
back in its field when it is open. The results stay while hits are opened:

- Up and Down move through the hits, Enter opens the selected one at its line with the query in
  the page's find bar, and the caret stays in the search field. Ctrl+Enter, or the middle button,
  opens the hit in a new tab. A folder hit opens the folder view.
- Esc hands the keyboard to the page; the panel stays. `search.close` (Close search) and the
  panel's own close button close it.
- ArrowUp in an empty field walks back through this session's queries.
- The query language is the host's: every term must be in the file, `"a phrase"` is one term,
  `path:` and `file:` narrow it, names match as well as content. Hidden files are searched only
  while Show hidden items is on. Focus mode narrows the list to the focused folder.
- The order is the shell's, one class per file: the file's name matches, then a heading matches,
  then a whole word in the body, then only part of a word; inside a class, the most recently
  changed file first.
- A cut list says so: "Showing 100 of 412 files. Narrow the search with path: or file:".
- The list follows the vault: a change on disk runs the query again a moment later, keeping the
  selected hit.

`openSearch({ folder, query })` is what the tree's Search in folder calls: the field starts as
`path:<folder>/ ` with the caret after it.

## The palette and Go to file

`palette.js`. `app.palette` (Ctrl+Shift+P) lists every command, grouped under a sentence-case
heading, with its chord. `app.quickopen`, **Go to file** (Ctrl+P, Ctrl+O), lists every file in
the vault (H17), under its real name with its folder on the line below; recent files float up;
on a tie a markdown file comes first. Shift+Enter makes the file you typed and did not find
(New file… with the prompt answered; a name with no extension gets `.md`).

## The page seam: text, images, PDFs, binary files

`page.js` is the shell's answer to `ose.setPageHost`: the one page host the router and
`ose.fileops` talk to (docs/CORE.md). Every existing file opens in the app (H17):

- a PDF or an image goes to `media.js` (below);
- anything else is asked about first, `ose.files.stat(path, { sniff: true })`: a file whose first
  8 KB are text (no NUL, valid UTF-8, or an encoding the host recognises) goes to the editor,
  which gives `.md`, `.markdown`, `.mdown` and `.mkd` the Rich / Source switch and opens
  every other text file, extensionless ones included, as plain source, keeping its line endings
  and BOM;
- a file that is not text gets a box with its name, size and type, and **Open with default
  app**, **Show in folder** (for a file outside the vault, **Copy into the vault…**) and **Show in
  Explorer** (Finder on a Mac). A picture or a PDF has **open with default app** and **show in
  Explorer** in its header. The tree's menu has the same two for a row: **Open with default app**
  (files only) and **Show in Explorer** (files and folders).

| method | what the shell does |
|---|---|
| `open(el, path, opts)` | reuses a parked editor for `path`, else builds one (or a media page) |
| `canLeave(reason)` | the mounted handle's; a dirty page saves first and answers false when it cannot (C1) |
| `stay()` | the handle's: a `true` from `canLeave` froze the page and the navigation did not happen |
| `close({ park })` | `park: true` detaches the editor and keeps it alive (another tab took the column); otherwise the handle's close |
| `release(path)` | a parked editor of `path` is saved and let go; false when it could not be saved |
| `rewriteLinksIn(path, pairs)` | links in an open page are rewritten as an edit in the editor, not on disk (H5) |
| `scrollToLine`, `selection` | the handle's |
| `beforePathChange`, `afterPathChange` | the editor's; a media page lets go of its file first and is mounted again after |
| `claims(path)` | media files: the router hands a missing one over instead of offering to create it |

The editor draws two things of its own in the page column: a banner at the top whenever the page
is not on disk as shown (not saved, changed on disk, deleted, recovered, merged), whose buttons
are commands, and the **Rich | Source** switch in the page meta line. A change made on disk by another program is merged into an open page
when it can be (H7), with a banner that closes by itself; only when the edits overlap does the
page stop and ask. The shell only
draws the default in Settings.

**Media pages.** A PDF is an `<iframe>` on the vault origin, drawn by the web view's own viewer;
an image is an `<img>` capped to the column, where a click or Enter toggles fit and actual size.
The header has **Open externally** and, for an image, fit and actual. The frame carries
`tabindex="-1"` so a keyboard user never lands in it; while a mouse user has clicked into it the
header offers **Leave the viewer**. A `.pdf` whose first kilobyte is not a PDF is never handed to
the frame: the page says it could not be drawn. A missing media file draws the miss box with no
button, so nothing is ever created over a media path.

**Paper.** `page.export-pdf` (Ctrl+Alt+P) and `page.print` open Chrome's print dialog, where
Save as PDF is a destination; Export titles the document after the page. The sheet is black on white from either theme (`src/editor/print.css`).

## Files

`fileops.js` is the only UI for creating, renaming, moving, duplicating, trashing, copying and
pasting files, and every one of them ends at `ose.fileops`, the core's one implementation
(docs/CORE.md), which asks the page host before anything on disk changes.

| command | title | chord | what it does |
|---|---|---|---|
| `file.new` | New file… | Ctrl+Alt+N | a name prompt prefilled `Untitled.md` with the stem selected |
| `tree.new-folder` | New folder | Ctrl+Shift+N | a name prompt, then `ose.fileops.mkdir` |
| `file.rename` | Rename… | F2 | the full name, stem selected |
| `file.move` | Move to… | — | the folder picker, for one row or the selection |
| `file.duplicate` | Duplicate | — | `stem 2.ext` beside it, byte for byte |
| `file.cut` / `file.copy` / `file.paste` | Cut / Copy / Paste | Ctrl+X, C, V in the tree and the folder view | a cut row is dimmed until the paste; pasting into the same folder copies as `name 2` |
| `file.undo` | Undo last file operation | Ctrl+Z in the tree and the folder view | the journal, below |
| `file.trash` | Move to the Recycle Bin, the Trash, or .trash | Delete in the tree and the folder view | see below |
| `file.open` | Open file… | — | the system's file dialog, then the file in a tab (below) |
| `file.copy-into-vault` | Copy into the vault… | — | a folder picker, then a byte copy of the outside file on screen, which opens |

- **A name is literal.** What is typed is what is written: any extension or none, nothing
  appended, nothing cleaned away. A name no file system can hold brings the prompt back with the
  reason.
- **New file** goes in the target row's folder, else the current place's folder (a folder
  route's own path, a page's folder), else the vault root. `a/b/c.ext` makes the folders. It is
  created exclusively: nothing is ever written over.
- **Rename** changing the extension asks once. A case-only rename is allowed.
- **The clipboard is the app's own**: a list of vault paths, never the system clipboard. It
  follows moves, and drops what was trashed. While the folder view's list has focus it answers
  for "here" (`addContext`), so F2 and the palette's file commands act on its rows.
- **The undo journal** (M17). Every completed operation shows a toast with what happened, in real
  names ("Renamed notes.md to notes.txt", "Moved 3 items to 2-learning"), and an **Undo**
  button. `file.undo` undoes the newest one. An undo goes back through the same operations, so
  open pages follow and links are rewritten back; a file created or copied that has changed since
  is left in place and the toast says so. The journal is this session's only; there is no redo.
- **Trash says where** (M18). The command's own title, in the palette and in every context
  menu, names the real bin as the host reports it for the vault (`ose.files.trashWhere`, asked
  at boot and again when the setting changes): "Move to the Recycle Bin" (Windows), "Move to the
  Trash" (macOS), "Move to .trash in this vault" (the setting, or a drive with no recycle bin).
  The confirm and the toast name the destination the same way, per path. Nothing is ever deleted
  outright. A single item is trashed with the Undo toast and no dialog; several ask once.
- **A file outside the vault** is never renamed, moved, copied, duplicated or trashed from
  here: those commands are not offered for it. Copy into the vault… is.
- **The open page** (and every page under a renamed or moved folder) is saved first. When it
  cannot be, nothing on disk changes and a sticky error toast says why.

### Files outside the vault

A file anywhere on the machine can be opened in a tab (X7): **Open file…** (`file.open`,
Chrome's file picker), or the OS once Ose is installed (Open with, a double click; the core's
`opens.js`). A browser has no paths, so A file inside this vault opens as the vault page it is. Any other is an `abs:` page
(`abs:/web/<id>/todo.md`, docs/HOST.md "Files outside the vault"): its tab and its
path bar say "outside vault" with its name, it is read, edited, saved in place, kept as a
draft and merged like a vault page, and it has no versions, no links or backlinks and no
attachments. **Copy into the vault…** (`file.copy-into-vault`) asks for a folder and copies it
there byte for byte under a free name, create-only, with Undo; the copy opens and the outside
tab stays.

### Drag in

`drag.js`, for the tree and the folder view (X8, §5.5 of the wave-3 contract).

- **In.** A drop from Explorer or Finder on a tree folder row, a folder-view folder row or the
  folder view's background (that folder) is copied in. The entries are taken from the drop at
  once (`webkitGetAsEntry()`), folders walked with their children read in batches, and handed
  to `ose.fileops.importEntries`: every file lands as its bytes through the create-only
  `createNewBinary` (a byte-order mark or another encoding arrives as it was), a taken name gets
  a free one for its whole subtree, and the drop is one undo step ("Copied 3 items into
  Notes", with Undo). Above 20 items a toast says the copy has started. A file over 64 MB is
  refused: "too large to copy by drop; copy it in Explorer" (Finder on a Mac). What did not come
  in is listed in one sticky toast. A drop on the editor is the editor's (Rich: its image drop), and any other drop is ignored.
- **Out.** A browser tab cannot drag a vault file out to the system, so nothing does.
- **Within.** A plain drag of a row onto a folder row, in either list, is a move through Move
  to…'s rules (never into itself, never where it already is), with its Undo.

**The Trash view** (`trash.js`, `app.trash`, the view `trash`). Every item in the vault's
`.trash`, which is where a delete goes: a browser cannot reach the system bin. Each row has its
name, its original folder and when it was deleted. Enter or **Restore** (`trash.restore`) puts
it back; a name that is taken again is refused with "A file with that name is already there",
and nothing is overwritten.

## Leaving the window

Everything that throws the window's document away goes through the core's leave gate
(`ose.window.leave`, docs/CORE.md, C5), which waits for every open page to save and keeps the
window when it cannot:

- **Reload window** (`app.reload`, no chord) is `ose.reload()`, which leaves first.
- **Change vault…** chooses a folder without adopting it, then `switchVault(root)` in `vault.js`:
  leave (stop on false: the core has said why), `ose.vault.open(root)`, reload. The page's last
  save lands in the vault it came from. When that vault is already open in another tab, this
  tab stays as it was (X6), and a toast says "That vault is open in another tab".

## Tabs per vault

One browser tab per vault, never two on one (X6). In the Change vault… dialog and on the
first-run chooser, Shift+Enter or Shift+click on a recent vault, or the **Open in new tab**
button, opens that vault in a tab of its own and leaves this one as it was; with no row chosen
the button asks for the folder first. A vault already open in another tab is not opened twice,
and the toast says so. Each tab has its own tabs strip, session and epoch; closing one keeps the
others.
- **The vault is gone**: the lost dialog. **Retry** closes it when the folder is back, and so does
  the watcher saying so. **Change vault…** there asks once whether to switch anyway; the text
  stays on this machine as a draft.

## Recovered changes

`recover.js` (C4). After the boot, when there is text that never reached its file, a sheet lists
each page with the time its text was written. Enter opens the page (`ose.route.navigate`), and
the editor puts the draft back or offers it. A draft whose file is gone offers **Save as…**,
which creates a new file and never writes over anything. Delete discards a draft after asking.
The sheet comes up after the session is restored, so the page in front may already hold its
draft, put back into the buffer and unsaved; dropping the draft alone would let the next leave
write the discarded text. A draft whose page is open in a tab is therefore discarded through
that page: it is brought to the front and `page.discard-changes` reverts the buffer to the file
on disk and drops the draft, asking its own question. Only a draft no tab holds is dropped
directly.
`app.recovered` brings the sheet back while there are drafts. When a dialog is already up at the
end of the boot, a sticky toast with **Show** stands in for the sheet.

## Settings

Settings is a page (M26): the view `settings`, opened in a tab by `app.settings` (Ctrl+,), which
brings the tab forward when it is already open. `route.arg` names a section, so
`ose.tabs.open({type:'view', name:'settings', arg:'planner'})` opens Settings › Planner
(`planner.settings` does exactly that).

The section list is on the left, a vertical tab list (Up and Down move and show, Tab goes into
the rows); the section's rows are on the right. Every change applies at once.

- **Appearance**: theme (System, Light, Dark; System is the default and follows the computer),
  zoom, text size, line height, page face, page layout, full width.
- **Editor**: "Open markdown files in" Rich or Source (`editorMode`, Rich by default: the
  mode a markdown file opens in the first time; a file you switch keeps its own mode, and a plain
  text file is always Source), spellcheck, and "Name new pages after their heading" (`titleSync`,
  off by default: a file keeps the name it was given).
- **Files**: where deleted files go, with a second line saying what really happens (a drive with
  no Recycle Bin, the macOS Trash that cannot be listed); where attachments go; Show hidden
  items; Restore tabs at start; Hide .md in names.
- **Planner**, and any other section registered through `ose.settings.section({id, title,
  order, render})`: each renders into a box of its own, and one that throws is one line saying
  so.
- **Vault**: the vault's path with **Change vault…**, where the root came from, the version, and
  the log file's path.

The values are the core's (`ose.settings`), and the core knows where each one lives:

| key | kept | default |
|---|---|---|
| `fontSize`, `lineHeight`, `pageFace`, `layout`, `readableWidth`, `zoom`, `spellcheck` | this machine | as before |
| `showHidden` | this machine | off |
| `restoreSession` | this machine | on |
| `hideMdExt` | this machine | off |
| `editorMode` | this machine | `rich` |
| `trash` | the vault | the system bin |
| `attachments` | the vault | beside the page |
| `titleSync` | the vault | off |

The theme is kept per machine too (`localStorage`, read by `first-paint.js` before the first
frame). The shell never touches `.ose/state.json` or the machine store directly:
`ose.state(key)`, `ose.local(key)` and `ose.settings`.

## Two kinds of state

The vault's `.ose/state.json` travels with the vault (it is synced with it): the planner's
paths, and the vault settings above. Everything about how this machine looks at the vault is kept
on the machine (`ose.local`, in the browser's storage for the site, docs/HOST.md
"Machine-local state"): the session, recent
files, the sidebar's width, open state and expansion, the side panel, the
reading settings, Show hidden items, the restore switch, one-time notices and the theme.

## The dev server

`npm run dev` (http://localhost:5173) serves this same shell from its sources, over the same web
adapter as the built site: a folder is picked in Chrome like anywhere else. `vite.config.js` has
`shell/` as its root and aliases `ose:core`, `ose:ui`, `ose:editor` and `ose:planner` onto
their sources; the stylesheet middleware answers `/ose/ui.css`, `/ose/editor.css` and
`/ose/planner.css`. Pick a throwaway copy of a vault, never a real one, while working on Ose.
`?opfs=1` on the URL opens the browser's private file system as the vault instead (the tests'
hook, docs/HOST.md "Testing").

## Rules

- Tokens only, from `ui.css`; overrides go in `theme.css`. No hex elsewhere.
- Everything keyboard-reachable; every action a command; both themes.
- Sentence case in every label, heading and button; no internal word in the chrome.
- A file is shown under its real name, everywhere.
- The shell never touches `.ose/state.json` directly: `ose.state(key)`, `ose.local(key)` and
  `ose.settings`.
- A shell file imports `ose:*` and its own files, nothing else. No CDN, no network.
