# The rice: `<vault>/.ose/app`

The rice is the whole interface: plain ES modules and CSS, no bundler, no npm, no git. The
kernel serves it at `app.localhost` and imports for it the four kernel bundles (docs/KERNEL.md).
Edit a file, press Ctrl+R (`app.reload`), see the change. The stock rice lives in the repo as
`cockpit/`; a new vault starts by copying it to `.ose/app`.

## Layout of the stock rice

```
.ose/app/
  cockpit.json      { "name": "stock", "requires": 1 }
  index.html        the page: three stylesheets in cascade order (the kernel's ui.css and
                    editor.css through two <link data-ose> elements with an empty href, then
                    shell/shell.css and theme.css), and two module scripts: shell/first-paint.js
                    (theme and platform onto <html> before the first paint, from localStorage
                    and the user agent; the CSP allows no inline script) then shell/main.js
  shell/            titlebar, tab strip, sidebar, palette, statusbar, settings dialog, search,
                    dashboard, vault chooser, update item, host helpers, shell.css
  theme.css         token overrides (optional; the stock one is empty)
  keys.json         an override layer, not the keymap: the window map is the kernel's
                    (`ose.keys.defaults()`, with its macOS alternates and in-body rules that JSON
                    cannot say); the stock file adds only `mod+r` → app.reload and
                    `mod+shift+j` → journal.new. A chord here wins over the default.
  lib/              plain files two or more modules share (docs/MODULES.md rule 1): a drills
                    lib, a chart helper. The rice owns them like everything else in .ose/app;
                    a module imports one as `../../lib/<file>.js` and never reaches into
                    another module's folder. Optional: a rice with nothing to share has none.
  modules/          one folder per module (docs/MODULES.md): day, week, month, journal, _template
```

## How it loads

1. The kernel resolves the vault. With none, the native folder picker (no rice needed).
2. `.ose/app/index.html` exists and `cockpit.json` has `requires <= ose.api`: the window loads
   `app.localhost/index.html`. The import map and the two stylesheet links are rewritten in
   flight; nothing in the file names an origin. On a plain file server (the browser dev) the
   links are still empty, and `main.js` fills any empty `data-ose` href with
   `ose.assets.url('<name>.css')` after `ose.ready`: three lines, the only place the rice
   touches the kernel's own assets.
3. Otherwise the kernel's fallback page: the vault name, "no cockpit here: create
   `.ose/app/index.html`, or copy `cockpit/` from the Ose repository", `Open folder`,
   `Change vault`. Shift held at launch, or `ose --no-rice`, forces this page.
4. `shell/main.js` awaits `ose.ready`, mounts the shell, calls `ose.modules.load()` (the
   module loader lives in the kernel; the rice decides when to call it, after the shell
   exists). The router is mounted with `start: false`, so nothing is drawn until
   `shell/start.js` navigates to the dashboard, the home tab ("Tabs, the home, and the
   sidebar" below).
   The vault chooser (`shell/vault.js`) is the rice's and is reached in a browser or a web
   view only; in the host a missing vault is the kernel's native picker and fallback page.
   The change-vault and vault-is-gone dialogs live in the same file.
5. `ose --rice <dir>` serves another folder as the rice (development: the repo's `cockpit/`).

## What the shell is

Rice code, not kernel code. The sidebar, palette, status bar, title bar, settings dialog and
start surface are ordinary modules of the rice that call the hoses. They are replaceable:
another rice may have a different sidebar or none. What the kernel guarantees is only that the
hoses exist and behave as documented.

The stock shell keeps every behaviour of the batch-12 interface (docs/CONTRACT.md): the
keymap, the tree, quick open, search, settings rows, zoom, the vault chooser, the update item.

## Tabs, the home, and the sidebar

The kernel keeps one current route and a history stack, and it does not know the word "tab".
The strip above the page column (`shell/tabs.js`) is a rice-side list of routes that follows
`ose.route.on`. The model is the editor's, not the browser's:

- An **ordinary** open replaces what is in the tab you are looking at — a click or Enter in the
  tree, quick open, a followed link, back, forward, a module's own `ose.route.navigate`. The
  strip never grows on its own, because a strip that does is a strip nobody closes.
- A tab is made **on purpose**: the middle button or Ctrl+Enter on a tree row, Ctrl+click or the
  middle button on a pinned row or a dashboard card, `tab.new` (Ctrl+T), and `tab.reopen`
  (Ctrl+Shift+T). Ctrl+click in the *tree* is not one of them: there it toggles the
  multi-selection (docs/CONTRACT.md batch 12, C17), which is the only way to move or trash
  several files at once.
- A route that already has a tab is brought to the front rather than duplicated. A tab's
  identity is the kernel's own route key — `page:<path>`, `own:<path>`, `view:<name>` — so one
  page reached from the tree, from quick open and from a link is one tab.
- **One tab is no strip.** It appears at two and the page column takes the 44px back.
- There is **no home tab**. The dashboard is a route like any other: the one the app boots
  into, the one `app.home` opens, and the one the last tab goes to rather than disappearing —
  closing the only tab navigates it home instead of removing it, so the column is never blank
  and the strip never empty.
- Closing one is `tab.close` (Ctrl+W), the middle button, the × on the tab, or Delete on a
  focused tab; the active tab closes through the kernel (`page.close` when it is a page, so the
  buffer is saved, `ose.route.close()` otherwise), which is what feeds the kernel's own closed
  stack. A close goes to the tab that was in front before it, else its neighbour, else home.
- `tab.reopen` pops the strip's own closed list first — it also holds the tabs closed while
  another was in front, which the kernel never saw — and falls through to the kernel's
  `app.reopen-closed`; either way the page comes back in a tab of its own.
- `tab.next` / `tab.prev` are Ctrl+Tab and Ctrl+Shift+Tab. Ctrl+1…9 are deliberately unbound:
  Ctrl+1…6 are the editor's heading chords in the page body.
- A tab's label is what the window title says for that route: a page's H1 (kept per page off
  `pageTitle` in `ose.store`, so a renamed H1 renames the tab), a view's title, an owned
  route's title from `ose.route.title`. A page with unsaved changes shows a dot, from the same
  `doc:dirty` / `doc:saved` events the title bar reads.
- Renaming, moving or trashing a page from the tree carries or closes its tab.
- The strip is a `tablist`: arrows walk it, Enter opens, Delete closes. It scrolls sideways
  and never wraps. Tabs are not restored across restarts.

The home is the **dashboard** (`shell/dashboard.js`), a view named `dashboard` titled "Home",
one card per module out of `ose.modules.list()` — the name, the manifest's one-line
description, and the chord of the `view.<name>` command when one is bound. A module with no
view of its own is a line under the grid; a disabled one is a line that says why.
`shell/start.js` navigates there at the end of the boot, and the router is mounted with
`ose.init({ page, start: false })` so the kernel's empty surface never flashes under it. There
is no `app.start` command any more; `app.home` is where nothing-in-particular goes.

The sidebar is **modules, pinned, pages, scratch**, top to bottom, in what is drawn and in the
Up/Down walk alike — the walk reads the rows out of the DOM, so the two cannot disagree. The
modules section is one row per registered view out of `ose.views.list()`, in the order of
`cockpit.json`'s `modules` list (`shell/order.js`; the dashboard's cards follow it too), so a
module appended to that list lands at the bottom and moving a line moves the row, with its own icon and the current-row bar, and it sits above everything the vault
put there: it is the app's own section and it does not move when the tree does. The dashboard
is filtered out of it, being the home page rather than a module's view. A row opens in place on
a click or Enter and in a tab of its own on the middle button or Ctrl+Enter, like every other
row, and the context menu passes it by: there is nothing to rename, move or trash. The sidebar
carries no chrome of its own either: the one control that folds it is a chevron in the title
bar's left corner,
at the sidebar's own x, drawn in the same place whether the sidebar is open or folded, with
only its glyph turning — pointing left at an open sidebar and right at a folded one. It runs
`app.sidebar` (Ctrl+\), so `sidebar.open` in state is the one truth. Under 640px of window
the sidebar hides itself out of the way and comes back when the window is wide again (the L25
rule); an explicit toggle there — the chord, the chevron, or `app.focus-sidebar` — overrules
that and opens it anyway, and the overrule lasts until the window is wide again, so narrowing
the window a second time hides it a second time.

### The page seam: markdown, images, PDFs

`shell/page.js` is the whole of the rice's answer to `ose.setPageHost`. It branches on the
file's extension and nothing else:

- `.pdf` → `shell/media.js` mounts an `<iframe>` whose `src` is `ose.files.assetUrl(path)`,
  filling the page column under a one-line header. The web view's own PDF viewer draws it
  (Chromium's in WebView2, WKWebView's on macOS): the vault origin answers
  `application/pdf` (`src-tauri/src/protocol.rs`) and the CSP names the vault origin in
  `frame-src`.
- `.png .jpg .jpeg .gif .webp .svg .bmp .avif .ico` → the same `media.js`, an `<img>` centred
  and capped to the column under the same header. Clicking the image, or `Enter` on it,
  toggles fit and actual size.
- everything else → `markdownPage` from `ose:editor`, exactly as before. A file the editor
  shows as source (`txt`, `csv`, `py`, …) is still the editor's.

A media page answers the page host's contract with the parts that mean something for a file
nobody edits: `close()` tears the frame or the image down and clears the status fields,
`scrollToLine()` answers `false`, `selection()` answers `null`. It never writes, so nothing
is ever dirty and there is no autosave.

The header is `open externally` (`ose.files.open`, the platform's default application) and,
for an image, `fit` / `actual`. The file name is the header's title; the path is the status
bar's, as for any page, with one line beside it saying what the file is — `pdf · 46 KB`, or
an image's `1500 × 1134 · 458 KB`.

**The frame and the keyboard.** The PDF frame is another document on another origin: the app
cannot see into it and none of its chords reach inside. So the frame carries `tabindex="-1"`
and nothing ever focuses it — a keyboard-only user never lands in a place where the keyboard
stops working, and `Tab` steps from the header straight past it. A mouse user may still click
into the viewer on purpose; while it holds the keyboard the header shows one more button,
`leave the viewer`, and a click anywhere on the header does the same. `Esc` inside the page
puts focus back on the page column, the one step out it means everywhere else; it cannot reach
the frame, and nothing can.

**A file that will not draw.** A `.pdf` whose bytes are not a PDF would otherwise get the web
view's own modal, in the web view's language and colours, over our page. So the first kilobyte
is read over the vault origin before the frame is pointed at anything — `%PDF-` must be in it,
and the content type must be `application/pdf` — and when it is not, the frame is never given
a `src`: the page says `<name> could not be drawn here · try open externally` in its own voice
and the status line ends `· could not be drawn`. An image says the same on its `error` event.

**A media file that is not there.** The kernel stats a page route before it asks anyone to
draw it, and offers `Create it` when the file is missing — right for markdown, wrong for a
`.pdf`, where the stub it writes is a markdown file wearing a media extension. The kernel must
not learn extensions, so `page.js` takes that one box back: a media route whose file does not
exist gets `that file is not in the vault`, the path, and one line saying nothing here can
create it. The button is gone, and a press on it is refused in the capture phase in any case,
so nothing is ever written over a media path.

A rice that wants no PDF frame deletes the `.pdf` branch: the kernel neither knows nor cares
which extensions the page host claims.

## Settings

`ose.settings` is one shared object in `.ose/state.json` under `settings`. The stock keys
(fontSize, lineHeight, readableWidth, zoom, newPages, attachments, trash, spellcheck, updates,
the sources) keep their batch-12 meaning. A module adds a settings section through
`ose.settings.section` and keeps its own keys under `settings.modules.<id>`.

## Rules

- Tokens only, from `ui.css`; a rice overrides them in `theme.css`. No hex elsewhere.
- Everything keyboard-reachable; every action a command; both themes.
- The rice never touches `.ose/state.json` directly: `ose.state(key)` and `ose.settings`.
- A rice file imports `ose:*` and its own files, nothing else. No CDN, no network.
