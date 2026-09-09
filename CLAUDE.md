# App: the os editor

## What this is

Obsidian plus custom GUIs from files: a markdown viewer and editor for any folder, which
parses certain files and builds graphical views from them while leaving every file ordinary
prose — so an agent (Claude Code, run on the vault from outside) can read and edit the same
files with no adapter. That is the whole application. One window: a sidebar with the vault,
and a page column that is either a markdown file in a block editor or one of the views. It
ships as a single portable file, `os.exe` (or `os.app`), that normally lives at the root of
its vault — move the folder, the editor moves with it — and asks for a folder when it doesn't.
It updates itself in place from the repo's `latest` release; there is no installer.

The files are the database. The editor never keeps a second copy of anything; state that is
only about the editor (window size, last route, sidebar width) lives in `.ose/state.json`,
which is ignored by git.

## Layout

```
README.md           one paragraph, Hassan's, not edited by the editor's tooling
docs/
  CONTRACT.md       the agreement between modules: bridge API, registry, events, entry points
  DESIGN.md         the visual system: tokens, components, the look
  TAURI.md          the host design
  OSE.md            the long-form introduction (the former README)
index.html          entry
vite.config.js      dev server, dev bridge plugin, build to dist/
package.json        scripts: dev, build, ship
src/
  main.js           boot order
  registry.js       bus, store, commands, views, status (the shared kernel)
  bridge/           facade + Tauri adapter + dev HTTP adapter
  styles/           tokens.css (all colours, fonts, sizes) and base.css (components)
  shell/            titlebar, sidebar, palette, statusbar, settings, router, dialogs, state
  editor/           Crepe (Milkdown) page editor, autosave, round-trip safe serialisation
  views/            day, week, month, journal
  lib/              shared parsers (timetable, monthly plan with systems, jsonl, tasks)
dev/                bridge-plugin.mjs: Node implementation of the bridge for the browser
src-tauri/          the Tauri 2 host in Rust: vault fs, watcher, state, window
ci/fake-vault/      the vault the self-test runs against in CI
dist/, src-tauri/target/   build outputs, ignored
```

## How to run it

Development (browser, hot reload, same vault):

```
npm install
npm run dev            # http://127.0.0.1:5173, dev bridge serves D:\os
```

Host in dev mode (real window, UI from the dev server):

```
npm run tauri:dev
```

Ship (build the UI, embed it, publish the exe, copy to the root):

```
npm run ship
```

The host is Tauri 2 (Rust). On this machine Rust is installed per user (rustup, gnu host) with
MinGW from winget for the linker tools; no admin rights are needed. Shipped binaries come from
CI (`.github/workflows/build.yml`): every push to `main` publishes `os.exe` and
`os-macos-arm64.zip` to the rolling `latest` release. See docs/TAURI.md for the host design.

## Rules for working in this folder

- Read `docs/CONTRACT.md` before touching any module and `docs/DESIGN.md` before touching any UI.
  A change to an interface goes into `docs/CONTRACT.md` first, then into code. Every document
  lives in `docs/`; the root `README.md` is one paragraph and stays as it is.
- Markdown fidelity is non-negotiable. The editor must never rewrite a file it did not edit, and
  a user edit must not reformat the rest of the file. Hassan's conventions: `-` bullets, `_`
  emphasis, H1 and body text, no runs of blank lines, LF endings, UTF-8 without BOM.
- Never write to a real vault file while testing. Use `Scratchpad/` and clean up.
- No new dependency without a reason written in the commit message. The UI has four:
  Milkdown Crepe and kit for the editor, marked and DOMPurify for rendering.
- Colours, fonts and sizes come from `tokens.css` only. No hex values in module CSS. Spacing
  comes from the spacing scale in `tokens.css`; no bare pixel paddings in module CSS.
- Both themes, every time. Keyboard reachable, every time: every action has a command, every
  command is in the palette, and nothing needs the mouse.
- Minimal and old-school. Boxes, not rules; whitespace does the grouping; the same thing gets
  the same treatment everywhere. Leave room for the user.
- The app is English; file content is never translated.

## What is deliberately not here

- No AI surface. No terminal, no chat pane, no MCP server. Claude Code is run on the vault from
  outside; `CLAUDE.md` in the vault is the whole integration, and it costs nothing.
- No database, no index files, no cache of vault content on disk. Everything is recomputed from
  the files at startup (175 files, milliseconds).
- No sync, no accounts. One network call: the update check against the repo's own `latest`
  release, ten seconds after boot and every six hours, off by a switch in settings. Nothing
  else in the app has a network path.
- No tabs. One page at a time, with back and forward, like Notion.
- No startup route. The app opens on the sidebar and an empty surface; the user picks.
- Sidebar, top to bottom: pinned (only when something is pinned), views, scratch (the
  Scratchpad folder, flat), pages. Search is an overlay on Ctrl+Shift+F, find-in-page on
  Ctrl+F, quick open on Ctrl+P, commands on Ctrl+K, settings on Ctrl+comma; the status bar
  says so.
- Every path the app reads is a source in settings (timetable, plans folder, systems log, todo
  file or folder, journal folder, scratch folder), each with a sentence saying what it must
  contain and a red `missing` when it does not exist. Nothing is hard-coded; a missing source
  shows the path and points at settings. Checkboxes outside the todo source are just
  checkboxes in their pages.
- Views are chronological: Day (today's timeline, system check-ins, tasks), Week (the
  timetable), Month (goals, systems matrix, computed rates, review), Journal (write-once
  record).
- No plugin system. New views are new files in `src/views/` registered through the registry.
- No drag-to-reorder in the tree: order comes from names, which survive every other tool.
- No math. A bare `$` in prose stays a `$`.
- No installer and no code signing: a portable binary that swaps itself in place, trusting
  HTTPS to the repo's own release.
- Any folder is a vault; no marker file is required (`.ose/` or `CLAUDE.md` only tell an exe it
  is already inside one).
