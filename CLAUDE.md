# App: Ose

## What this is

Ose (On Site Editor; the French imperative "dare") is a markdown viewer and editor for a personal
file tree. It parses certain files and builds a graphical view from them, while leaving every file
ordinary prose. `ose.exe` is the whole app: the Rust host, the kernel, the editor and the shell
(sidebar, tabs, palette, settings, search, home) are all inside the one executable. Nothing of the
app lives in the vault.

The files are the database. Every page is a plain markdown file on disk, edited in place, with
line endings and formatting preserved; the app keeps no index, no cache and no second copy of
anything. The only state it owns is its own, in `.ose/state.json` inside the vault. A vault is any
folder, and the binary normally sits at the root of it, so moving the folder moves the editor with
it. There is no installer.

Workflows are **plugins**: local plain files in `<vault>/.ose/plugins/`, loaded at boot and on
Ctrl+R. No manifest, no permission wall, no marketplace. A plugin is handed the whole `ose` and
never spells a vault path: it says what it needs by name and `ose.paths` finds it. An agent
(Claude Code, run on the vault from outside) reads and edits the same files with no adapter, and
writes plugins against `docs/PLUGINS.md`.

## Layout

```
README.md           one paragraph, Hassan's, not edited by the editor's tooling
docs/
  PLUGINS.md        the plugin contract: where one lives, what it exports, ose.paths, the rules
  KERNEL.md         everything on `ose`, versioned as ose.api
  SHELL.md          the interface: layout, boot, tabs, sidebar, the page seam, settings
  HOST.md           the Rust host: origins, flags, the vault root, the build
  DESIGN.md         the visual system: tokens, components, the look
shell/              the interface, flat: index.html, main.js, the surfaces, shell.css,
                    theme.css, keys.json, logo.png. Embedded in the exe by the build.
plugins/            the stock six as shipped with 1.0.0 (day, week, month, journal,
                    maths, nsi) plus _template and _lib. A snapshot, not what runs: the live copies
                    are the vault's, in .ose/plugins.
src/
  kernel/           ose:kernel (registry, bridge, router, links, paths, settings core, state,
                    theme, keys, watch, run, schedule, the plugin loader and its facade),
                    ose:ui (dialogs, pickers, menu, toast, icons; ui.css = tokens + base),
                    ose:md (generic date, markdown and JSONL helpers)
  editor/           ose:editor: markdownPage, codeEditor, render (Crepe, CodeMirror, marked)
src-tauri/          the host in Rust: vault fs, watcher, versions, run, the ose/app/vault
                    origins, single instance
vite.kernel.config.js   builds the bundles and embeds shell/ into dist-kernel/
vite.config.js      the browser dev server: serves shell/ with ose:* aliased to the sources
dev/                bridge-plugin.mjs: the Node host for the browser; test-server.mjs
scripts/            embed-shell.mjs, ship.mjs
dist-kernel/, src-tauri/target/, work/   build outputs and scratch, gitignored
```

## How to run it

```
npm install
npm run build          # the bundles and shell/ into dist-kernel/
npm run dev            # http://127.0.0.1:5173: the app in a browser over the Node host
npm run dev:test       # http://127.0.0.1:5174, the same against a throwaway vault copy
```

Both dev servers resolve the vault in this order: the `OSE_ROOT` environment variable, then
`ose.config.json` at the root of this repository (per machine, gitignored), then the parent folder
of this repository, which is the layout when Ose sits inside the vault. `npm run dev:test` takes
`OSE_TEST_ROOT` (and `OSE_TEST_PORT`) and passes it down as `OSE_ROOT`.

The host is Tauri 2 (Rust; rustup gnu per user, MinGW for the linker; `cargo` at `~/.cargo/bin`).
`npm run build`, then `cargo build --release` in `src-tauri`, gives
`src-tauri/target/release/ose.exe`; `npm run tauri:build` does both in one step, and
`npm run ship` builds and copies the exe to the vault root. `ose.exe --root <vault>` opens a
vault, `--shell D:\ose\shell` serves the shell from the repo instead of from inside the exe, which
is how the shell is edited live, and `--version` says what a binary is. `npm run tauri:dev` does
not work: in dev mode Tauri serves `devUrl` and the embedded shell is not there. Shipped binaries
come from CI (`.github/workflows/build.yml`): every push to `main` publishes `ose.exe` to the
rolling `latest` release. See docs/HOST.md.

The two workflows: **a plugin change** is an edit in `<vault>/.ose/plugins` and Ctrl+R, no build.
**An app change** is made here, built, and shipped.

## Rules for working in this folder

- Read `docs/PLUGINS.md` before touching a plugin, `docs/KERNEL.md` before the kernel,
  `docs/SHELL.md` before the shell, `docs/HOST.md` before the host, and `docs/DESIGN.md` before
  any UI. A hose is added, never changed in meaning; a breaking change is the next `ose.api`.
  Every document lives in `docs/`; the root `README.md` is one paragraph and stays as it is.
- The kernel never draws and ships no HTML. Nothing in it knows a view, a plugin or a file name
  of the shell.
- A plugin is plain files: no bundler, no npm, no CDN, no inline script (the CSP forbids one),
  imports only from `ose:*`, its own folder and `../_lib/`. It never spells a vault path.
- Markdown fidelity is non-negotiable. The editor must never rewrite a file it did not edit, and
  a user edit must not reformat the rest of the file. Hassan's conventions: `-` bullets, `_`
  emphasis, H1 and body text, no runs of blank lines, LF endings, UTF-8 without BOM.
- Never write to a real vault file while testing. Use a throwaway copy and clean up.
- No new dependency without a reason written in the commit message. The bundles carry Milkdown
  Crepe and kit, marked, DOMPurify and CodeMirror's language pack; the host has two plugins
  beyond Tauri's own, single-instance and dialog.
- Colours, fonts and sizes come from the tokens in `ui.css` only. No hex values elsewhere.
  Spacing from the scale; no bare pixel paddings.
- Both themes, every time. Keyboard reachable, every time: every action has a command, every
  command is in the palette, and nothing needs the mouse.
- Minimal and old-school. Boxes, not rules; whitespace does the grouping; the same thing gets
  the same treatment everywhere. Leave room for the user.
- The app is English; file content is never translated.

## What is deliberately not here

- No AI surface. No terminal, no chat pane, no MCP server. Claude Code is run on the vault from
  outside; `CLAUDE.md` in the vault points at `docs/PLUGINS.md` and that is the integration.
- No updater. The app makes no network call at all: `ose.run` starts programs, and that is the
  only thing that leaves the process. A new version is downloaded by hand and dropped over the
  old one.
- No self-test and no CI fixture vault. The host's tests are `cargo test` in `src-tauri`; the app
  itself is checked by running it.
- No manifest on a plugin, no permission wall, no marketplace, no third-party plugins. What is in
  `.ose/plugins` is what runs, and it is the vault owner's own code.
- No interface in the vault: no `.ose/app`, no `cockpit.json`, no fallback page. A shell that
  throws at boot leaves a blank window, and the way back is the log and `--shell`.
- No database, no index files, no cache of vault content on disk. Everything is recomputed from
  the files at startup.
- No sync, no accounts.
- One page at a time in the column, with back and forward; the tab strip is the shell's list of
  open routes over that one route, not editors kept alive, and it is not restored on restart.
- No startup route. The app opens on the home page (one card per plugin) and the sidebar; the
  user picks. Nothing the user last looked at is restored.
- No drag-to-reorder in the tree: order comes from names. No math: a bare `$` stays a `$`.
- No installer and no code signing: a portable binary that is copied where it is wanted.
