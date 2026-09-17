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
  main.js           boot, below
  layout.js         the frame: title bar, sidebar, page column, status bar, the app commands
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

A plugin is not here. It is a folder in `<vault>/.ose/plugins`, loaded at boot and on Ctrl+R.

## How it loads

1. The host resolves the vault and navigates the window to `<app origin>/index.html`. The import
   map and the two stylesheet links are rewritten in flight, so no file of the shell names an
   origin. On a plain file server (the browser dev server) the links are still empty, and
   `main.js` fills any empty `data-ose` href with `ose.assets.url('<name>.css')` after
   `ose.ready`.
2. `main.js` awaits `ose.ready`, puts the platform on `<html>` and applies the reading settings
   before anything is drawn.
3. No vault: the status is `NO VAULT` and `vault.js` mounts the chooser. The shell is not built
   at all, and it starts again on the answer.
4. `resolveScratch()` declares the shell's own path and resolves it once, before the sidebar is
   drawn: owner `app`, key `scratch`, `{ folder: 'scratchpad', hint: 'Where new pages land unless
   a folder is focused.' }`. `ose.focus.defaultNewFolder()` and the editor's new page both read
   it through `ose.paths.of('app').peek('scratch')` and fall back to the vault root.
5. `mountShell()`, then `initPageHost()`, `initDashboard()` and `initTabs()`, all three before
   `ose.init`, because the router mounts with the shell and the home has to be a registered view
   before anything navigates to it.
6. `ose.init({ page, start: false })`: the theme, the key engine and the router into the shell's
   page column. `start: false` so the kernel's empty surface never flashes under the home.
7. `initPalette()`, `initSearch()`, `initSettings()`, then `keys.json`.
8. `startSurface()` opens the home tab, and `ose.plugins.load()` runs after it: the home is on
   screen while the plugins activate and fills in when `booted` says they have.
9. Status `READY`, and `ose.bus.emit('booted')`.

`keys.json` is an override layer, not the keymap: the window map is the kernel's
(`ose.keys.defaults()`, with its macOS alternates and in-body rules that JSON cannot say). The
stock file adds `mod+r` to `app.reload` and `mod+shift+j` to `journal.new` and `mod+shift+p` to `page.print`. A chord here wins over
a kernel default and over a plugin's own `shortcut`.

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
  tab; the active tab closes through the kernel (`page.close` when it is a page, so the buffer is
  saved, `ose.route.close()` otherwise), which is what feeds the kernel's own closed stack. A
  close goes to the tab that was in front before it, else its neighbour, else home.
- `tab.reopen` pops the strip's own closed list first (it also holds the tabs closed while
  another was in front, which the kernel never saw) and falls through to the kernel's
  `app.reopen-closed`; either way the page comes back in a tab of its own.
- `tab.next` / `tab.prev` are Ctrl+Tab and Ctrl+Shift+Tab. Ctrl+1…9 are deliberately unbound:
  Ctrl+1…6 are the editor's heading chords in the page body.
- A tab's label is what the window title says for that route: a page's H1 (kept per page off
  `pageTitle` in `ose.store`, so a renamed H1 renames the tab), a view's title, an owned route's
  title from `ose.route.title`. A page with unsaved changes shows a dot.
- Renaming, moving or trashing a page from the tree carries or closes its tab.
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

The scratch section is the `app` path `scratch`. Unresolved, the section is simply absent and new
pages land at the vault root: there is no row about a missing folder. It redraws on
`ose.paths.on` for that owner and key.

The sidebar carries no chrome of its own: the one control that folds it is a chevron in the title
bar's left corner, at the sidebar's own x, drawn in the same place whether the sidebar is open or
folded, with only its glyph turning. It runs `app.sidebar` (Ctrl+\), so `sidebar.open` in state is
the one truth. Under 640px of window the sidebar hides itself and comes back when the window is
wide again; an explicit toggle there overrules that until the window is wide again.

### The page seam: markdown, images, PDFs

`page.js` is the whole of the shell's answer to `ose.setPageHost`. It branches on the file's
extension and nothing else:

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
edits: `close()` tears the frame or the image down and clears the status fields, `scrollToLine()`
answers `false`, `selection()` answers `null`. It never writes, so nothing is ever dirty and there
is no autosave.

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

**A media file that is not there.** The kernel stats a page route before it asks anyone to draw it,
and offers `Create it` when the file is missing, which is right for markdown and wrong for a
`.pdf`, where the stub it writes is a markdown file wearing a media extension. The kernel must not learn
extensions, so `page.js` takes that one box back: a media route whose file does not exist gets
`that file is not in the vault`, the path, and one line saying nothing here can create it. The
button is gone, and a press on it is refused in the capture phase in any case, so nothing is ever
written over a media path.

## The status bar

Left: every field `ose.status.all()` answers, joined by `·`: the shell's five (mode, path, doc,
save, watch) and then whatever a plugin set, each one a button when it carries an `onClick` and
coloured when it carries a `kind`. Right: the zoom while it is not 100 %, `ctrl+, settings`, the
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

`app.reload` is titled **Reload plugins**: the page again, and therefore every plugin from disk.
Editing a plugin is: save the file, press Ctrl+R.

## The browser dev server

`npm run dev` (port 5173) and `npm run dev:test` (5174) serve this same shell over a Node
implementation of the bridge (`dev/bridge-plugin.mjs`), which is how the app is looked at without
building the exe. `vite.config.js` has `shell/` as its root, aliases `ose:*` onto the kernel
sources, and serves `/plugins/**` from `<vault>/.ose/plugins/**`: a `.js` file goes through Vite's
own transform so its `ose:*` imports resolve to the same module instances the shell's do, and
anything else is sent with its media type. Everything there is `no-store`.

The vault is `OSE_ROOT`, else `ose.config.json` at the repo root, else the repo's parent folder;
`dev:test` sets `OSE_ROOT` from `OSE_TEST_ROOT` and takes `OSE_TEST_PORT`. A command the Node
bridge does not implement answers `null` and is named once in the log, the same tolerance the host
has.

## Rules

- Tokens only, from `ui.css`; overrides go in `theme.css`. No hex elsewhere.
- Everything keyboard-reachable; every action a command; both themes.
- The shell never touches `.ose/state.json` directly: `ose.state(key)` and `ose.settings`.
- A shell file imports `ose:*` and its own files, nothing else. No CDN, no network.
