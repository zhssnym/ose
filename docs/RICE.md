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
`ose.route.on`: a route that is not in the list joins it, a route that is becomes the active
one. A tab's identity is the kernel's own route key — `page:<path>`, `own:<path>`,
`view:<name>` — so one page reached from the tree, from quick open and from a link is one tab.

- Clicking a tab is `ose.route.navigate`. Closing one is `tab.close` (Ctrl+W), the middle
  button, the × on the tab, or Delete on a focused tab; the active tab closes through the
  kernel (`page.close` when it is a page, so the buffer is saved, `ose.route.close()`
  otherwise), which is what feeds the kernel's own closed stack.
- A close goes to the tab that was in front before it, else its neighbour, else home.
- `tab.reopen` (Ctrl+Shift+T) pops the strip's own closed list first — it also holds the tabs
  closed while another was in front, which the kernel never saw — and falls through to the
  kernel's `app.reopen-closed`.
- `tab.next` / `tab.prev` are Ctrl+Tab and Ctrl+Shift+Tab. Ctrl+1…9 are deliberately unbound:
  Ctrl+1…6 are the editor's heading chords in the page body.
- A tab's label is what the window title says for that route: a page's H1 (through `pageTitle`
  in `ose.store`, so a renamed H1 renames the tab), a view's title, an owned route's title as
  its module registered it with `ose.route.index`. A page with unsaved changes shows a dot,
  from the same `doc:dirty` / `doc:saved` events the title bar reads.
- Renaming, moving or trashing a page from the tree carries or closes its tab.
- The strip is a `tablist`: arrows walk it, Enter opens, Delete closes. It scrolls sideways
  and never wraps. Tabs are not restored across restarts.

The first tab is the home, and it has no ×: the **dashboard** (`shell/dashboard.js`), a view
named `dashboard` titled "Home", one card per module out of `ose.modules.list()` — the name,
the manifest's one-line description, and the chord of the `view.<name>` command when one is
bound. A module with no view of its own is a line under the grid; a disabled one is a line
that says why. `shell/start.js` navigates there at the end of the boot, and the router is
mounted with `ose.init({ page, start: false })` so the kernel's empty surface never flashes
under it. Closing the last real tab lands there. There is no `app.start` command any more;
`app.home` is where nothing-in-particular goes.

The sidebar is the vault and nothing else: pinned, pages, scratch. It has no views section —
a view is a module's surface, and the dashboard is where the modules are. Its top edge carries
a chevron that folds it; folded, a chevron at the far left of the title bar unfolds it. Both
run `app.sidebar` (Ctrl+\), so `sidebar.open` in state is the one truth. Under 640px of window
the sidebar hides itself and comes back when the window is wide again (the L25 rule, unchanged);
while that is what hid it, the title bar's chevron stands down, because nothing it could do
would bring the sidebar back before the window does.

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
for an image, `fit` / `actual`. Both are buttons in the tab order; `Esc` does nothing special.
The file name is the header's title; the path is the status bar's, as for any page.

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
