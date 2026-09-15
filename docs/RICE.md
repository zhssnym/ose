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
  shell/            titlebar, sidebar, palette, statusbar, settings dialog, search, start
                    surface, vault chooser, update item, host helpers, shell.css
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
   exists). The router draws the empty start surface when it is mounted; `shell/start.js`
   owns the decision that there is no startup route and the command that returns to it.
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
