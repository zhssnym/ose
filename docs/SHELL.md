# The shell

The shell is the whole interface: the title bar, the tab strip, the sidebar, the palette, search,
the status bar, the settings dialog, the home page and the vault chooser. It is plain ES modules
and CSS, no bundler, and it travels inside `ose.exe`, served on the `app` origin
(docs/HOST.md). It is not the kernel: it draws, and it calls the hoses of `docs/KERNEL.md` like
anything else. The kernel guarantees the hoses, not this layout; what a plugin may rely on is
`docs/PLUGINS.md`.

## Layout

```
shell/
  index.html        the page: four stylesheets in cascade order (the kernel's ui.css and
                    editor.css through two <link data-ose> elements with an empty href, then
                    shell.css and theme.css), and two module scripts, first-paint.js then
                    main.js. Every path in it is relative and flat (`./main.js`), because the
                    app origin serves `shell/<path>`. The CSP allows no inline script.
  first-paint.js    theme and platform onto <html> before the first paint, from localStorage
                    and the user agent
  main.js           the entry: imports boot.js, and puts boot-error.js up when anything throws
  boot.js           the boot, below
  boot-error.js     the page a failed boot leaves (imports nothing)
  layout.js         the frame: title bar, sidebar, page column, status bar, the app commands
  fileops.js        New file…, Rename…, Move to…, Duplicate, Move to trash: the one UI for them
  recover.js        the Recovered changes sheet
  titlebar.js  tabs.js  sidebar.js  palette.js  search.js  settings.js  statusbar.js
  dashboard.js      the home page
  page.js           the page seam (markdown, images, PDFs)   media.js  media.css
  vault.js          the vault chooser and the change-vault dialogs
  start.js  order.js  host.js  paths.js
  shell.css         every rule of the shell
  theme.css         token overrides; empty on purpose
  keys.json         an override layer, below
  logo.png
```

A plugin is not here. It is a folder in `<vault>/.ose/plugins`, loaded at boot and on **Reload
plugins** (`app.reload`, in the palette; it has no chord since Ctrl+R went, D8).

## How it loads

1. The host resolves the vault and navigates the window to `<app origin>/index.html`. The import
   map and the two stylesheet links are rewritten in flight, so no file of the shell names an
   origin. On a plain file server (the browser dev server) the links are still empty, and
   `main.js` fills any empty `data-ose` href with `ose.assets.url('<name>.css')` after
   `ose.ready`.
2. `main.js` imports `boot.js` dynamically and calls `boot()`, which starts the editor bundle
   downloading (`page.js loadEditor`, a dynamic `import('ose:editor')`), awaits `ose.ready`, puts
   the platform on `<html>` and applies the reading settings before anything is drawn.
3. No vault: the status is `NO VAULT` and `vault.js` mounts the chooser. The shell is not built
   at all, and it starts again on the answer.
4. `resolveScratch()` declares the shell's own path and resolves it once, before the sidebar is
   drawn: owner `app`, key `scratch`, `{ folder: 'scratchpad', hint: 'Where new pages land unless
   a folder is focused.' }`. `ose.focus.defaultNewFolder()` and the editor's new page both read
   it through `ose.paths.of('app').peek('scratch')` and fall back to the vault root.
5. `mountShell()`, then `initPageHost()` (which waits for the editor bundle), `initDashboard()`
   and `initTabs()`, all three before
   `ose.init`, because the router mounts with the shell and the home has to be a registered view
   before anything navigates to it.
6. `ose.init({ page, start: false })`: the theme, the key engine and the router into the shell's
   page column. `start: false` so the kernel's empty surface never flashes under the home.
7. `initPalette()`, `initSearch()`, `initSettings()`, `initFileOps()`, `initRecover()`, then
   `keys.json`.
8. `startSurface()` opens the home tab, and `ose.plugins.load()` runs after it: the home is on
   screen while the plugins activate and fills in when `booted` says they have.
9. The boot's own status goes, and `ose.bus.emit('booted')`.
10. `offerRecovered()`: the Recovered changes sheet, when there are drafts (below).

**A boot that fails** (M38) never leaves a blank window. Whatever throws on the way — a shell
module that does not load, the kernel not answering, a surface that throws while it is built —
ends on one page (`boot-error.js`): "Ose could not start", how far the boot got, the error, the
stack under a disclosure, where the log is (`ose.vault.info().logPath` when the kernel can say),
and two buttons, **Copy details** and **Try again**. `boot-error.js` imports nothing and `main.js`
reaches `boot.js` by a dynamic import, so a module that fails to load cannot take the page down
with it. An editor bundle that fails to evaluate costs the pages only: the page host still goes
in, pages open as plain text, and one sticky toast says why.

`keys.json` is an override layer, not the keymap: the window map is the kernel's
(`ose.keys.defaults()`, with its macOS alternates and in-body rules that JSON cannot say). A
chord here wins over a kernel default and over a plugin's own `shortcut`. The stock file, after
decision D8:

| chord | command |
|---|---|
| `mod+p` | `app.quickopen` (beside Ctrl+O) |
| `mod+shift+p` | `app.palette` |
| `mod+alt+p` | `page.export-pdf` |
| `mod+alt+n` | `file.new` |
| `f2` | `file.rename` |
| `mod+shift+j` | `journal.new` |

Ctrl+R is bound to nothing. The web view's own reload keys (F5, Ctrl+R, Ctrl+Shift+R and the
keyboard's Back, Forward and Refresh keys) are refused by `layout.js` in the capture phase,
whatever the host does with its accelerators, because each of them threw the page away.

`theme.css` is the one place the look is changed: token overrides only, never a rule and never a
hex value anywhere else.

## Tabs, the home, and the sidebar

The kernel keeps one current route and a history stack, and it does not know the word "tab". The
strip above the page column (`tabs.js`) is a shell-side list of routes that follows
`ose.route.on`. The model is the editor's, not the browser's:

- An **ordinary** open replaces what is in the tab you are looking at: a click or Enter in the
  tree, quick open, a followed link, back, forward, a plugin's own `ose.route.navigate`. The strip
  never grows on its own, because a strip that does is a strip nobody closes.
- A tab is made **on purpose**: the middle button or Ctrl+Enter on a tree row, Ctrl+click or the
  middle button on a pinned row or a home card, `tab.new` (Ctrl+T), and `tab.reopen`
  (Ctrl+Shift+T). Ctrl+click in the *tree* is not one of them: there it toggles the
  multi-selection, which is the only way to move or trash several files at once.
- A route that already has a tab is brought to the front rather than duplicated. A tab's identity
  is the kernel's own route key (`page:<path>`, `own:<path>`, `view:<name>`), so one page reached
  from the tree, from quick open and from a link is one tab.
- **One tab is no strip.** It appears at two and the page column takes the 44px back.
- There is **no home tab**. The home is a route like any other: the one the app boots into, the
  one `app.home` opens, and the one the last tab goes to rather than disappearing, so the column
  is never blank and the strip never empty.
- Closing one is `tab.close` (Ctrl+W), the middle button, the × on the tab, or Delete on a focused
  tab; the active tab closes through the kernel (`page.close` when it is a page,
  `ose.route.close()` otherwise), which asks the page first and feeds the kernel's own closed
  stack. A page that cannot be saved refuses: the close answers false, the page's banner says
  why, and the strip drops nothing. A close goes to the tab that was in front before it, else its
  neighbour, else home.
- A navigation the page refused (C1) changes nothing in the strip: tabs follow `route` events,
  and a refused navigation sends none. `openInNewTab` spends its "make a tab" flag whatever the
  answer.
- `tab.reopen` pops the strip's own closed list first (it also holds the tabs closed while
  another was in front, which the kernel never saw) and falls through to the kernel's
  `app.reopen-closed`; either way the page comes back in a tab of its own.
- `tab.next` / `tab.prev` are Ctrl+Tab and Ctrl+Shift+Tab. Ctrl+1…9 are deliberately unbound:
  Ctrl+1…6 are the editor's heading chords in the page body.
- A tab's label is what the window title says for that route: a page's H1 (kept per page off
  `pageTitle` in `ose.store`, so a renamed H1 renames the tab), a view's title, an owned route's
  title from `ose.route.title`.
- **Save state** (H8), from the editor's `doc:state` for every open page, not only the one in
  front: a dirty page shows the dot; `not-saved` or `conflict` shows the error mark, a small
  square in `--err`, with the editor's own sentence as the tab's tooltip; `deleted` adds
  " (deleted)" to the label, and the mark while the page still holds unsaved text. The title bar
  shows the same mark for the page in front.
- A rename or a move re-points the router (`route:repointed`) and the tabs follow it: the page is
  not reopened and keeps its one tab. Trashing a page closes its tab once the file is gone.
- The strip is a `tablist`: arrows walk it, Enter opens, Delete closes. It scrolls sideways and
  never wraps. Tabs are not restored across restarts.

The home is `dashboard.js`, a view named `dashboard` titled "Home": one card per
`ose.plugins.list()` row, with the name, the description and the chord of the `view.<name>`
command when one is bound. A plugin with no view is a line under the grid; a disabled one is a
line saying why, in the error colour. A vault with no plugins gets one sentence: "No plugins. A
plugin is a folder in .ose/plugins." `start.js` navigates there at the end of the boot.

The sidebar is **plugins, pinned, pages, scratch**, top to bottom, in what is drawn and in the
Up/Down walk alike: the walk reads the rows out of the DOM, so the two cannot disagree. The
plugins section is one row per registered view, ordered by the view's `order` then its title
(`order.js`; the home cards follow the same rule). There is no list of plugins anywhere, so a
plugin that wants to sit between two others changes the `order` of its view. The home is filtered
out of it, being the home page rather than a plugin's view. The section sits above everything the
vault put there and does not move when the tree does. A row opens in place on a click or Enter and
in a tab of its own on the middle button or Ctrl+Enter; the context menu passes it by, there being
nothing to rename, move or trash.

A click on a row focuses it, and so does a right-click, before the menu opens (H21): every tree
command asks the focused row what it is about, and on macOS a click never focused a button. The
menu itself runs each command with the row under the pointer and does not ask the command's
`when`, which knows only the focused row.

A pinned page opens the page; a pinned folder goes to its folder in the tree and focuses that row
(H18). Nothing enters **focus mode** but its own command, `app.focus-enter` (Focus folder, on a
folder row's menu and in the palette). While a folder is in focus the title bar carries a chip,
`focus · <folder>` with a ×, whether or not the sidebar is open; pressing it runs
`app.focus-exit`.

The scratch section is the `app` path `scratch`. Unresolved, the section is simply absent and new
pages land at the vault root: there is no row about a missing folder. It redraws on
`ose.paths.on` for that owner and key.

The sidebar carries no chrome of its own: the one control that folds it is a chevron in the title
bar's left corner, at the sidebar's own x, drawn in the same place whether the sidebar is open or
folded, with only its glyph turning. It runs `app.sidebar` (Ctrl+\), so `sidebar.open` in state is
the one truth. Under 640px of window the sidebar hides itself and comes back when the window is
wide again; an explicit toggle there overrules that until the window is wide again.

### The page seam: markdown, images, PDFs

`page.js` is the whole of the shell's answer to `ose.setPageHost`: the one page host the router
and `ose.fileops` talk to (docs/KERNEL.md). Every method but `open` is optional to the router.

| method | what the shell does |
|---|---|
| `open(el, path, opts)` | a media page or `markdownPage`, by extension (below) |
| `canLeave(reason)` | the mounted handle's `canLeave`; a dirty page saves first and answers false when it cannot (C1) |
| `stay()` | the handle's `stay`: a `true` from `canLeave` froze the page and the navigation did not happen |
| `close()` | the handle's `close`; `false` means still mounted, nothing torn down |
| `scrollToLine`, `selection` | the handle's |
| `beforePathChange(change)` | the editor's module `beforePathChange` (every mounted page at or under `from` saves, or the change is refused); a media page lets go of its file first |
| `afterPathChange(change)` | the editor's `afterPathChange`; a media page is mounted again at its new path (or its old one when the change failed) |
| `claims(path)` | `isMediaFile(path)`: the router skips its own "page not found" and calls `open` anyway |

The editor draws two things of its own in the page column, and the shell adds nothing for them:
a sticky banner at the top of the column (`.ed-banner`) whenever the page is not on disk as shown
(not saved, changed on disk, deleted on disk, recovered, opened as text), whose buttons are
commands; and a **Rich | Source** switch in the page meta line. It also sets the status field
`mode` (`{text:'Rich'|'Source', onClick}`, or `{text:'Text'}` for a plain file), and its `save`
field is an object with `kind` `err` or `warn` and an `onClick` that runs `page.show-problem`
whenever the page is not saved.

It branches on the file's extension and nothing else:

- `.pdf` → `media.js` mounts an `<iframe>` whose `src` is `ose.files.assetUrl(path)`, filling the
  page column under a one-line header. The web view's own PDF viewer draws it (Chromium's in
  WebView2, WKWebView's on macOS): the vault origin answers `application/pdf` and the CSP names
  the vault origin in `frame-src`.
- `.png .jpg .jpeg .gif .webp .svg .bmp .avif .ico` → the same `media.js`, an `<img>` centred and
  capped to the column under the same header. Clicking the image, or Enter on it, toggles fit and
  actual size.
- everything else → `markdownPage` from `ose:editor`. A file the editor shows as source (`txt`,
  `csv`, `py`, …) is still the editor's.

A media page answers the page host's contract with the parts that mean something for a file nobody
edits: `canLeave()` answers true and `stay()` does nothing, `close()` tears the frame or the
image down, clears the status fields and answers true, `scrollToLine()` answers `false`,
`selection()` answers `null`. It never writes, so nothing is ever dirty and there is no
autosave.

The header is `open externally` (`ose.files.open`, the platform's default application) and, for an
image, `fit` / `actual`. The file name is the header's title; the path is the status bar's, as for
any page, with one line beside it saying what the file is: `pdf · 46 KB`, or an image's
`1500 × 1134 · 458 KB`.

**The frame and the keyboard.** The PDF frame is another document on another origin: the app
cannot see into it and none of its chords reach inside. So the frame carries `tabindex="-1"` and
nothing ever focuses it: a keyboard-only user never lands in a place where the keyboard stops
working, and Tab steps from the header straight past it. A mouse user may still click into the
viewer on purpose; while it holds the keyboard the header shows one more button, `leave the
viewer`, and a click anywhere on the header does the same. Esc inside the page puts focus back on
the page column; it cannot reach the frame, and nothing can.

**A file that will not draw.** A `.pdf` whose bytes are not a PDF would otherwise get the web
view's own modal, in the web view's language and colours, over our page. So the first kilobyte is
read over the vault origin before the frame is pointed at anything (`%PDF-` must be in it, and
the content type must be `application/pdf`), and when it is not, the frame is never given a `src`:
the page says `<name> could not be drawn here · try open externally` in its own voice and the
status line ends `· could not be drawn`. An image says the same on its `error` event.

**Paper.** Two commands put a page on a sheet, both the host's (docs/HOST.md "Print"). `Export to
PDF` (`page.export-pdf`, Ctrl+Alt+P; Ctrl+Shift+P is the palette since D8) opens the native save dialog
on the page's own folder in the vault with the page's title and `.pdf` as the name, writes the file
through WebView2 and says where it went; it returns when the file is on disk. `Print`
(`page.print`, no chord) opens the Windows print dialog, which is also the way to "Microsoft Print
to PDF"; the app is unresponsive while that dialog is up, as it is behind any modal system dialog,
and comes back when it closes. Neither switches the theme: the sheet is black on white from either
theme because `src/editor/print.css` says so, and a PDF taken from the dark theme and one taken
from the light theme draw the same marks. Nothing calls `window.print()` any more except the
browser dev server's fallback, where `Print` uses the page's own dialog and `Export to PDF` says it
needs the app.

**A media file that is not there.** The kernel stats a page route before it asks anyone to draw it,
and offers `Create it` when the file is missing, which is right for markdown and wrong for a
`.pdf`. The page host claims every media path (`claims`), so the router hands a missing one over
instead, and `media.js mediaMissingPage` draws the kernel's own `.miss` box re-lettered:
`that file is not in the vault`, the path, and one line saying nothing here can create it. There
is no button, so nothing is ever written over a media path (M4; the capture-phase guard and the
`MutationObserver` that did this before are gone).

## Files

`fileops.js` is the only UI for creating, renaming, moving, duplicating and trashing files (H12,
H13, C6). The tree and its context menu, the palette, the title bar's New file button and quick
open's Shift+Enter all end here, and every one of them ends at `ose.fileops`, the kernel's one
implementation (docs/KERNEL.md), which asks the page host before anything on disk changes. The
kernel draws nothing: the name prompt, the extension question, the trash confirmation and every
notice are this file's.

| command | title | chord | what it does |
|---|---|---|---|
| `file.new` | New file… | Ctrl+Alt+N | a name prompt prefilled `Untitled.md` with the stem selected |
| `file.rename` | Rename… | F2 | the full name, stem selected |
| `file.move` | Move to… | — | the folder picker, for one row or the selection |
| `file.duplicate` | Duplicate | — | `stem 2.ext` beside it, byte for byte |
| `file.trash` | Move to trash | — | one confirm, then the trash |

Each takes an optional target `{ path, kind }` (a list for move and trash). The tree's menu hands
it the row; from the palette or a chord it acts on the focused tree row, else the page on screen
(the sidebar tells `fileops.js` what "here" is through `setContext`). The old `tree.new-page`,
`tree.rename`, `tree.move`, `tree.duplicate` and `tree.trash` are gone, so each act is listed
once.

- **A name is literal.** What is typed is what is written: any extension or none, no `.md`
  appended, no extension kept behind the user's back, no character "cleaned" away.
  `ose.names.check` refuses what no file system can hold, and the prompt comes back with the
  reason and the text as typed.
- **New file** goes, first match wins, in the target row's folder (a folder row is its own), the
  open page's folder, the focused folder, the vault root. `a/b/c.ext` makes the folders. A `.md`
  starts with its H1 and anything else starts empty. The host creates it exclusively, so nothing
  is ever written over: a name that is taken brings the prompt back saying so. The new file opens.
  Quick open's Shift+Enter is New file with the prompt already answered; a name typed there with
  no extension is a page and gets `.md`.
- **Rename** changing the extension asks once ("Change .md to .txt?"); No goes back to the prompt.
  A case-only rename is allowed.
- **Trash** names where the files really go (the Recycle Bin or the Trash, or `.trash` in the
  vault, per Settings), then trashes; only once a file is gone does its tab close and the page in
  front land on its neighbour.
- **The open page** (and every page under a renamed or moved folder) is saved first. When it
  cannot be, nothing on disk changes and a sticky error toast says why, with **Show**
  (`page.show-problem`). A renamed or moved page follows its file without being reopened: the
  buffer and the undo history survive.

The sidebar follows what happened, off the kernel's bus: `paths:moving` (sent by `fileops.js`
before the host call, so the watcher's report of the app's own move is not taken for an outside
rename), `paths:moved`, `paths:trashed` and `paths:created` keep expansion, pins, the selection
and the focused row pointing at the right paths. It never navigates after a move.

## Leaving the window

Everything that throws the window's document away goes through the kernel's leave gate
(`ose.window.leave`, docs/KERNEL.md, C5), which waits for the open page to save and keeps the
window when it cannot:

- **Reload plugins** is `ose.reload()`, which leaves first.
- **Change vault…** chooses a folder without adopting it (`chooseVault({ adopt: false })`), then
  `switchVault(root)` in `vault.js`: `ose.window.leave('vault-change')` (stop on false: the
  kernel has said why), `ose.vault.open(root)` (on error `ose.window.stay()` and a toast), and
  `ose.reload({ skipLeave: true })`. The page's last save lands in the vault it came from.
- **A second launch** naming another folder: the host only asks now
  (`ose.vault.onChangeRequested`), and the shell runs the same `switchVault`.
- **The vault is gone** (the lost dialog): **Retry** closes the dialog when the folder is back,
  and so does the watcher saying so; nothing reloads. **Change vault…** there is the same switch,
  and since the page cannot be saved into a vault that is gone, a refused leave asks once whether
  to switch anyway; the text stays on this machine as a draft.
- The first-run chooser has nothing to leave and reloads straight away.

## Recovered changes

`recover.js` (C4). After the boot, `ose.files.drafts.list()`: when there is text that never
reached its file, a sheet, "Unsaved changes were recovered", lists each page with the time its
text was written. Enter opens the page, and the editor puts the draft back or offers it (it
knows whether the file changed since). A draft whose file is gone offers **Save as…** instead,
which creates a new file with the draft's text through `ose.fileops.create` and never writes over
anything. Delete discards a draft after asking. `app.recovered` ("Recovered changes…") brings
the sheet back while there are drafts. When a dialog is already up at the end of the boot, a
sticky toast with **Show** stands in for the sheet.

## The status bar

Left: every field `ose.status.all()` answers, joined by `·`: the shell's five (mode, path, doc,
save, watch) and then whatever a plugin set, each one a button when it carries an `onClick` and
coloured when it carries a `kind`. The editor's `save` field ("Not saved", "Not saved · changed
on disk", "Deleted on disk") and its `mode` field (the **Rich | Source** switch) are such
buttons; the shell adds nothing for them. Right: the zoom while it is not 100 %, `ctrl+, settings`, the
resolved theme, and which host is answering.

## Settings

`ose.settings` is one shared object in `.ose/state.json` under `settings`: `fontSize`,
`lineHeight`, `readableWidth`, `zoom`, `newPages`, `attachments`, `trash`, `spellcheck`. The shell
never touches `.ose/state.json` directly: `ose.state(key)` and `ose.settings`.

The dialog's sections, in order:

- **theme**, one row.
- **reading**: zoom, body text, line height, readable width.
- **files**: where new pages go, where attachments go, where deleted files go, spellcheck, then
  the shell's own path rows out of `ose.paths.of('app').list()`, which today is `scratch` alone.
- **plugins**: per plugin a heading line (name, description, state, and the error on its own line
  in the danger colour), then one row per declared path: the label, the resolved path or
  `missing` / `ambiguous` in the error colour, the hint as the note, **Choose…** and **Reset**
  (Reset is hidden while nothing is saved). The list repaints on `ose.paths.on` while the dialog
  is open. Two buttons under it: **Reload plugins** (`app.reload`) and **Open plugins folder**,
  which creates `.ose/plugins` when the vault has none and then reveals it.
- whatever the plugins registered through `ose.settings.section`, in registration order. A section
  that throws is one line saying so, never a dialog that fails to open.
- **about**: vault, where the root came from, and `version` as `kernel · host · platform`.

`app.reload` is titled **Reload plugins**: the page again, and therefore every plugin from disk,
once the open page has been saved. Editing a plugin is: save the file, then Reload plugins from
the palette or Settings. It has no chord (D8).

## The browser dev server

`npm run dev` (port 5173) and `npm run dev:test` (5174) serve this same shell over a Node
implementation of the bridge (`dev/bridge-plugin.mjs`), which is how the app is looked at without
building the exe. `vite.config.js` has `shell/` as its root, aliases `ose:*` onto the kernel
sources, and serves `/plugins/**` from `<vault>/.ose/plugins/**`: a `.js` file goes through Vite's
own transform so its `ose:*` imports resolve to the same module instances the shell's do, and
anything else is sent with its media type. Everything there is `no-store`.

The vault is `OSE_ROOT`, else `ose.config.json` at the repo root, else the repo's parent folder;
`dev:test` sets `OSE_ROOT` from `OSE_TEST_ROOT` and takes `OSE_TEST_PORT`. A command the Node
bridge does not implement fails with `[unknown_command]`, as the host's does (docs/HOST.md).

## Rules

- Tokens only, from `ui.css`; overrides go in `theme.css`. No hex elsewhere.
- Everything keyboard-reachable; every action a command; both themes.
- The shell never touches `.ose/state.json` directly: `ose.state(key)` and `ose.settings`.
- A shell file imports `ose:*` and its own files, nothing else. No CDN, no network.
