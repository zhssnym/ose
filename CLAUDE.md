# App: the os editor

## What this is

The desktop editor for the whole `D:\os` tree. One window: a sidebar with the vault, a page
column that is either a markdown file in a block editor or a custom view, and a Claude pane that
runs Claude Code on the vault. It ships as a single file, `os.exe`, placed at the root of the
vault. Move the folder, the editor moves with it.

The files are the database. The editor never keeps a second copy of anything; state that is
only about the editor (window size, last route, sidebar width, sessions) lives in
`App/state.json`, which is ignored by git.

## Layout

```
App/
  CONTRACT.md         the agreement between modules: bridge API, registry, events, entry points
  DESIGN.md           the visual system: tokens, components, the look
  index.html          entry
  vite.config.js      dev server, dev bridge plugin, build to dist/
  package.json        scripts: dev, build, host:run, host:publish, ship
  src/
    main.js           boot order
    registry.js       bus, store, commands, views, status (the shared kernel)
    bridge/           facade + WebView2 adapter + dev HTTP adapter
    styles/           tokens.css (all colours, fonts, sizes) and base.css (components)
    shell/            titlebar, sidebar, palette, statusbar, settings, router, dialogs, state
    editor/           Crepe (Milkdown) page editor, autosave, round-trip safe serialisation
    views/            month, week, day, journal (the Agent view lives in claude/)
    claude/           the Claude pane: process protocol, rendering, composer, sessions
    lib/              shared parsers (timetable, monthly plan with systems, jsonl, tasks)
  dev/                bridge-plugin.mjs: Node implementation of the bridge for the browser
  host/               .NET 10 WinForms + WebView2 host, produces os.exe
  dist/, dist-host/   build outputs, ignored
```

## How to run it

Development (browser, hot reload, same vault):

```
cd App
npm install
npm run dev            # http://127.0.0.1:5173, dev bridge serves D:\os
```

Host in dev mode (real window, UI from the dev server):

```
npm run host:run
```

Ship (build the UI, embed it, publish the exe, copy to the root):

```
npm run ship
```

The .NET SDK is installed per user at `%LOCALAPPDATA%\Microsoft\dotnet` and is not on PATH; the
npm scripts reference it explicitly. No admin rights are needed for anything here.

## Rules for working in this folder

- Read `CONTRACT.md` before touching any module and `DESIGN.md` before touching any UI. A change
  to an interface goes into `CONTRACT.md` first, then into code.
- Markdown fidelity is non-negotiable. The editor must never rewrite a file it did not edit, and
  a user edit must not reformat the rest of the file. Hassan's conventions: `-` bullets, `_`
  emphasis, H1 and body text, no runs of blank lines, LF endings, UTF-8 without BOM.
- Never write to a real vault file while testing. Use `Scratchpad/` and clean up.
- No new dependency without a reason written in the commit message. The UI has four:
  Milkdown Crepe and kit for the editor, marked and DOMPurify for chat rendering.
- Colours, fonts and sizes come from `tokens.css` only. No hex values in module CSS.
- Both themes, every time. Keyboard reachable, every time.
- The app is English; file content is never translated.
- Claude Code runs as a child process of the host in stream-json mode; the pane is a chat,
  not a terminal. Permission mode defaults to `acceptEdits`; full access is a deliberate choice
  in the pane header.

## What is deliberately not here

- No database, no index files, no cache of vault content on disk. Everything is recomputed from
  the files at startup (175 files, milliseconds).
- No sync, no accounts, no network calls except the Claude CLI's own.
- No tabs. One page at a time, with back and forward, like Notion.
- No startup route. The app opens on the sidebar and an empty surface; the user picks.
- Sidebar, top to bottom: pinned (only when something is pinned), agent (Claude), views,
  scratch (the Scratchpad folder, flat), pages. Search is an overlay on Ctrl+F, quick open on
  Ctrl+P, commands on Ctrl+K, settings on Ctrl+comma; the status bar says so.
- Tasks in the Day view come from Todo.md at the root, nothing else. Checkboxes elsewhere are
  just checkboxes in their pages.
- The Claude view is a viewer of the CLI: transcript, composer, and one menu for the three
  things the CLI takes as flags (model, permission mode, session). Nothing conversational is
  reimplemented; resumed sessions are read from Claude Code's own transcript files.
- Views are chronological: Month (goals, systems matrix, computed rates, review), Week (the
  timetable), Day (today's timeline, system check-ins, tasks), Journal (write-once record).
  The Agent view is Claude Code on the vault, full width by default, dockable beside a page.
- No plugin system. New views are new files in `src/views/` registered through the registry.
