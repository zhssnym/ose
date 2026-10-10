# The shell

The shell is the whole interface: the title bar with the tabs, the sidebar, the page column, the
status bar, the palette, search, Settings and the vault chooser. It is `src/shell/`, TypeScript
like the rest of `src/`, bundled by Vite with everything else. It draws and calls `ose`
(docs/CORE.md) like any other client; the core never draws. Imports are plain relative paths
(`'../core/core.ts'`, `'../ui/index.ts'`). The views (Today, Planner, Journal) are `src/views`,
loaded by the boot; their file formats are docs/FORMATS.md.

## Files

```
index.html (repo root)   #app and two module scripts: src/shell/first-paint.ts, then main.ts
first-paint.ts   theme and platform onto <html> before the first paint
main.ts          imports the stylesheets, then boot.ts by dynamic import; boot-error.ts on a throw
boot.ts          the boot (below); binds keys.json
boot-error.ts    the page a failed boot leaves; imports nothing
layout.ts        the frame, resizers, the narrow-window rule, the side panel, window-level guards
titlebar.ts      the sidebar's corner, the slot the tabs move into, +, the window buttons
tabs.ts          the tab strip           statusbar.ts   the status bar
sidebar*.ts      the sidebar: sidebar.ts exports, -state (shared state), -tree (data and
                 drawing), -select, -load (reading and patching), -commands (menus, drag), -init
folder-model.ts  sort, visibility, icons and labels for the tree and the file card
start.ts         Home, and where the boot ends
page.ts          the page host: the editor or media.ts's card
palette.ts       the command palette and Go to file      search.ts   search in the side panel
settings.ts      the Settings page        fileops.ts     the one UI for file operations
drag.ts          the internal drag of rows (to a folder, to the tab strip)
recover.ts       the Recovered changes sheet
vault.ts         the vault chooser, Change vault…, the "vault is gone" dialog
host.ts, paths.ts, order.ts, logo.ts   a window hose, path helpers, view order, the mark
shell.css, tree.css, places.css, media.css, theme.css, keys.json, logo.svg
```

`main.ts` imports the stylesheets in the order they win: `../ui/ui.css` (tokens and base
components), `shell.css`, `tree.css`, `places.css`, `media.css`, then `theme.css` (token
overrides only, empty on purpose). The editor's and the views' stylesheets come with their own
lazy chunks.

## The boot

```
ose.ready -> settings.apply -> vault chooser | mountShell
          -> initPageHost -> initHome -> initTabs -> ose.init({page})
          -> palette, search, settings, fileops, recover -> keys.json
          -> views -> startSurface (Home) -> 'booted' -> offerRecovered, offerUpdate
```

The editor chunk starts downloading first. With no vault, `vault.ts` mounts the chooser and the
shell is not built. The page host, Home and the tab strip exist before `ose.init`, because the
router mounts with it and may need Home at once; it mounts blank and leaves the first place to
the shell. The views register their own views, commands and Settings section; if they fail to load,
one toast says so and the boot goes on. The app always opens on Home, unless the OS has already
asked for a file. Then the Recovered changes sheet appears when there are drafts, and a
downloaded update offers **Restart** in a sticky toast.

A failed boot never leaves a blank window: `boot-error.ts` shows "Ose could not start", how far
it got, the error, the stack, the log path, **Copy details** and **Try again**. An editor chunk
that fails costs only the pages, which open as plain text.

## Layout

```
+--------------+---------------------------------------------------+
| mark     [<] | tab | tab | +                          _  []  x   |  title bar
+--------------+------------------------------+--------------------+
| Views        | page column                  | side panel         |
| Vault        |                              | (search; hidden    |
| Scratchpad   |                              |  until opened)     |
+--------------+------------------------------+--------------------+
| ⚙ | Rich·Source | Document·Plain | Scroll·Pages   412 words · a.md |  status bar
+------------------------------------------------------------------+
```

**Title bar.** There is no system title bar on Windows and Linux; on macOS the traffic lights
sit over its left end. The corner over the sidebar holds the mark and the sidebar toggle
(`app.sidebar`, Ctrl+\); folded, only the toggle is left. Then the tabs, **+** (`tab.new`), and
on Windows and Linux the window buttons. Empty parts drag the window; a double click maximises.
There are no back and forward buttons and no breadcrumb: back and forward are Alt+Left and
Alt+Right (Cmd+[ and Cmd+] on a Mac).

**Sidebar.** Resizable up to 60 % of the window; dragged under half its minimum, it folds. Under
640px of window it hides itself without touching the saved preference. Width, open state and
expanded folders are this machine's (`ose.local('sidebar')`).

**Status bar.** Left, the controls: a gear that opens Settings (`app.settings`), lit while
Settings is open, then the editing mode (Rich · Source), and for a markdown page
the page face (Document · Plain) and the page layout (Scroll · Pages), the same settings as
Settings › Appearance. Right, the facts: the other fields of `ose.status` joined by `·` (the
counts, when the file was saved, and the save state only when it is bad, a button that shows
the problem), the vault-relative path, which copies the absolute path on click, and the zoom
while it is not 100 %, which resets on click.

**Side panel.** `layout.ts` exports `panel`, a resizable column to the right of the page. Search
is its only user. Its width is `ose.local('panel')`.

`layout.ts` also refuses the web view's reload and history keys (F5, Ctrl+R, Ctrl+U, F7, the
Back, Forward and Refresh keys), swallows the web view's context menu (Shift+right-click still
gets it, for spelling), and ignores file drops that land on no target, which is every drop
from Explorer or Finder outside an open page (a page attaches what is dropped into it). The
window is at least 480 by 360.

## Tabs and Home

The core owns the tabs (`ose.tabs`): each has its own back and forward, and only the active
tab's place is mounted. A page in a background tab is parked by the editor, buffer and undo
intact. `tabs.ts` only draws the strip and registers the `tab.*` commands.

- An ordinary open (tree, Go to file, a link, back, forward) replaces the place in the active
  tab. A new tab is on purpose: middle click or Ctrl+Enter on a row, Ctrl+T, or Ctrl+Shift+T to
  reopen a closed one.
- Tabs are small cards in the title bar, the active one on `--bg-3`. Drag a tab to reorder it
  (Ctrl+Shift+Left and Right from the keyboard). A file dragged from the sidebar over the strip
  shows a dashed ghost tab where it will open.
- The label is the file's real name or the view's title; the tooltip is the path. Only a page
  that could not be saved wears a mark on its tab; unsaved changes are said in the status bar.
  A file outside the vault reads "outside vault" after its name.
- The last tab cannot be closed when it is Home (it shakes); closing any other last tab sends it
  Home.

**Home** (`start.ts`, `app.home`) is the view `home`, titled "New tab": an empty page where a new
tab starts and the router falls back. A `folder` route is not a place: the router reveals that
folder in the sidebar.

## The sidebar

Up to four sections, each its own `role="tree"`: **Views** (the registered views of the
`planner` section, ordered by `order.ts`), **Pinned** (when anything is), **Vault** (the vault folder's contents; the folder
has no row of its own) and **Scratchpad** (a top-level `scratchpad` folder, when there is one,
shown here instead of under Vault). They stand in the order the person puts them in: a
section's heading has **Move up** and **Move down** in its menu, and **Move section up** and
**Move section down** (`sidebar.section-up`, `sidebar.section-down`) move the section of the
focused row from the palette. The order is kept with the sidebar's state for the vault. Folders come first, then files, in natural order; a folder
opens and closes in place; every name is shown in full. Hidden items (dot names, the OS hidden
attribute) appear only with Show hidden items on, greyed. What the host never lists (`.ose`,
`.git`, temp files) never arrives (docs/HOST.md).

**Focus mode** (`app.focus-enter`, Focus folder) narrows the sidebar, search and page lists to
one folder. The Vault heading becomes "Focus *folder*" with a button that leaves it.

The tree is read once at boot, then patched: watcher batches and the app's own `paths:*` events
re-list only the folders they touch. A rescan, a lost watcher or Show hidden items re-reads it.

Keys: arrows, Home, End and type-ahead move; Enter opens; Ctrl+Enter opens in a new tab; F2
renames; Delete trashes (Cmd+Backspace on a Mac); Ctrl+X, C, V; Ctrl+Z undoes the last file
operation; Shift+F10 opens the menu; Esc clears the selection, then a cut, then returns to the
page. Ctrl+Shift+E moves the keyboard in. A row's menu opens with New file and New folder, then on
a folder Focus folder first under the line, then the other file commands, Copy path, Copy link, Open with default app,
Open containing folder and Search in folder; the empty
space below holds New file, New folder, Collapse all folders and Show hidden items.

Rows dragged in the tree move, with Undo, and the place a drop would land sits in a dashed box
while the drag hovers: a folder row takes it into that folder (the box holds the folder and its
open contents); a file row, beside that file in its folder; a section's heading or empty space,
to the section's top (the vault or the focus folder, the scratchpad), the box around the whole
section. So rows go into, out of and between folders, and between Vault and Scratchpad. Views
take no drop. Nothing is dragged in from Explorer or Finder onto the tree, and nothing drags a
file out.

A view's row has its own menu: **Hide view** (`tree.hide-view`) takes it out of the sidebar,
and **Show hidden views** (`tree.show-views`, also in that menu and on the empty space's) brings
every hidden one back. Which are hidden is kept with the sidebar's state for the vault; a hidden
view still opens from the palette.

**Pin** (`tree.pin`) and **Unpin** (`tree.unpin`), on a row's menu, a selection's and the
palette (the focused row, else the page on screen), put a file or folder in **Pinned**, in the
order pinned. A pinned file opens like a view, leaving the Vault tree as it was; a pinned folder is shown in
the Vault tree. Pins follow a
move or a rename; a pin whose file is gone stays greyed and struck until it is unpinned, and is
whole again if the file comes back. A pinned row's menu: Unpin, Open in new tab, Copy path,
Copy link, Search in folder or Open with default app, Open containing folder. Pins are kept with
the sidebar's state for the vault, on this machine; focus mode hides them.

## Pages

`page.ts` is the shell's `ose.setPageHost`, the one page host the router and `ose.fileops` talk
to (docs/CORE.md has the contract). Every file opens. Text (the host sniffs the first 8 KB) goes
to the editor: markdown in Rich or Source, anything else in Source, encoding and line endings
kept. An image, a PDF or any other non-text file gets `media.ts`'s card: name, size, type and
date, "Ose shows text files", **Open with default app** and **Open containing folder** (and
**Copy into the vault…** for a file outside it). A missing image or PDF is never created.

## Commands and search

`app.palette` (Ctrl+Shift+P) lists every command, grouped, with its chord. Go to file
(`app.quickopen`, Ctrl+P or Ctrl+O) lists every file by real name with its folder below; recent
files float up, and Shift+Enter creates the name typed (`.md` added when it has no extension).

Search (`app.search`, Ctrl+Shift+F) opens in the side panel. Up and Down move; Enter opens a hit
at its line with the query in the page's find bar, keeping the caret in the field; Ctrl+Enter
opens it in a new tab; Esc returns to the page; the panel stays until closed. The host matches
(every term, `"a phrase"`, `path:`, `file:`); the shell ranks name, then heading, then whole
word, then part of a word, newest first. It re-runs when files change.

`keys.json` binds the shell's chords over the core's defaults (`src/core/keys.ts`) and wins on a
tie: Ctrl+P Go to file, Ctrl+Shift+P palette, Ctrl+Alt+P export PDF, Ctrl+Alt+N new file, F2
rename, Ctrl+Shift+J today's journal, Ctrl+T new tab. The full list is Settings › Help.

## Files

`fileops.ts` is the only UI for file operations (`file.new`, `tree.new-folder`, `file.rename`,
`file.move`, `file.duplicate`, `file.cut`, `file.copy`, `file.paste`, `file.undo`, `file.trash`,
`file.open`, `file.copy-into-vault`), and each ends at `ose.fileops`, which saves the open page
first and refuses when it cannot.

- A name is literal: what is typed is written, any extension or none. New files never overwrite;
  `a/b/c.md` makes the folders. The clipboard is the app's own list of paths.
- Each completed operation shows a toast in real names with **Undo**; `file.undo` takes back the
  newest. No redo; the journal lasts the session.
- Trash names the real destination (Recycle Bin, Trash, or the vault's `.trash`). One item goes
  without asking, several ask once. Nothing is deleted outright.
- A file outside the vault (Open file…, or the OS) opens in a tab marked "outside vault", is
  saved in place, and is never renamed, moved or trashed from Ose.

## Vaults, recovery, settings

**Vaults** (`vault.ts`): one window per vault, never two on one. The chooser lists the vaults
this machine has opened; Shift+Enter or **Open in new window** opens one in its own window.
Change vault… and Reload window leave through the core's gate (`ose.window.leave`), which saves
first. A vanished vault folder gets one dialog with **Retry** and **Change vault…**.

**Recovered changes** (`recover.ts`): text that never reached its file is listed after the boot.
Enter opens the page and the editor restores or offers the draft; a draft with no file offers
**Save as…**. Discarding goes through the open page when there is one, so the discarded text is
never saved. `app.recovered` reopens the sheet.

**Settings** (`app.settings`, Ctrl+,) is a view in a tab; `route.arg` names a section. Sections:
Appearance (theme, zoom, text size, line height, page face, page layout, full width), Editor
(Rich or Source by default, spellcheck, name new pages after their heading), Files (attachments,
show hidden items, hide `.md`), any registered section (Views, where the views' files are),
Updates, Vault (path, Change vault…, log path) and Help (a short guide and every shortcut).
Every change applies at once. The values belong to `ose.settings`, which knows what is per machine and what per vault.
