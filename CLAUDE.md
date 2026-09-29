# App: Ose

## What this is

Ose (On Site Editor; the French imperative "dare") is a markdown viewer and editor for a personal
file tree. It parses certain files and builds a graphical view from them, while leaving every file
ordinary prose. Ose is a web app for Chrome, installable as an app and working offline after the
first visit: the host (the web adapter over the File System Access API), the core, the editor,
the planner (Day, Week, Month, Journal) and the shell (tree, folder view, tabs, palette, settings,
search, home) are one build, served as plain files by Vercel. There is no server and no database:
Vercel serves the app's own code, and a vault never leaves the machine. Nothing of the app lives
in the vault.

The files are the database. Every page is a plain markdown file on disk, edited in place, with
line endings and formatting preserved; the app keeps no index, no cache and no second copy of
anything. It owns two kinds of state. What belongs to the vault and travels with it (pins, the
planner's paths, vault settings, file versions) is in `.ose/state.json` and `.ose/history` inside
the vault. What belongs to this machine is in the browser's storage for the site (IndexedDB
`ose-web`): the folders it may open, the session, recent files, the sidebar, per-folder sort,
reading comfort, Show hidden, drafts of unsaved text and a log. A vault is any folder the person
picks in Chrome; "Allow on every visit" lets it open again without asking.

It is a file manager as much as an editor: one tree rooted at the vault, every folder a place
with its own view, every file listed under its real name and openable, nothing hidden by name.
The planner's four views are built in, `src/planner`: they read ordinary files (a timetable, todo
lists, a monthly plan, `systems.jsonl`, the journal) whose paths are chosen in Settings › Planner,
and write back only one appended or replaced line, or a new `YYYY-MM-DD.md`. There are no plugins
and no loader. An agent (Claude Code, run on the vault from outside) reads and edits the same
files with no adapter, keeping to the formats in `docs/FORMATS.md`, and Ose picks up its changes
as they happen.

A markdown page has three editing modes. **Rich** is Crepe, the page drawn as a document; **Live**
is CodeMirror over the whole file with the markup hidden off the caret's line, where the file text
is the only truth and a save is that text; **Source** is the raw file. **Reading** shows the page
rendered, read-only, over whichever mode it came from. Rich stays the default until Hassan decides
(D1): Settings › Editor picks the default, and each file remembers the mode it was left in. Any
other text file opens in Source, in its own encoding.

Each vault gets its own browser tab, never two on one vault. A file from outside the vault (Open
file…, or the OS once Ose is installed) opens in a tab marked "outside vault", which saves in
place and has no versions, links or attachments.

## Layout

```
README.md           what Ose is, in Hassan's words
docs/
  FORMATS.md        the planner's files: what each one holds, and exactly what the app writes
  CORE.md         everything on `ose`: files, fileops, routes, tabs, session, the local store
  SHELL.md          the interface: layout, boot, places and tabs, the tree, the page seam, settings
  LIVE.md           the Live mode: the text-is-truth rule, the reveal rule, the widgets
  HOST.md           the host, which is the browser: every command, writes, the watcher, drafts,
                    versions, the trash, the service worker and the `vault/` origin, the tests
  DESIGN.md         the visual system: tokens, components, the look
shell/              the interface, flat: index.html, main.js, the surfaces (tree, folder view,
                    Home, tabs, address bar, search, settings, trash), shell.css, tree.css,
                    places.css, folder.css, theme.css, keys.json, logo.png. Copied verbatim into
                    dist/ by the build. The tree is sidebar.js and its parts, sidebar-*.js, which
                    share one `state` (sidebar-state.js).
src/                TypeScript, built by Vite into the four bundles
  core/             ose:core (registry, bridge, router, tabs, session, local store, links,
                    fileops and the undo journal, settings core, state, theme, keys, watch),
                    ose:ui (dialogs, pickers, menu, toast, icons; ui.css = tokens + base);
                    bridge/commands.ts types every host command, kept by hand
  editor/           ose:editor: markdownPage in Rich, Live and Source, codeEditor, render
                    (Crepe, CodeMirror, marked), one live instance per open file, the 3-way
                    merge of changes made on disk; live/ is the Live mode, reading/ the Reading
                    view, page/ the parts of page.ts (open, modes, save, merge, drafts, ...), each
                    adding its functions to one instance's `ctx`; stringify/ the serializer's
                    parts (write, cleanup, reconcile, blocks, markers, tables)
  planner/          ose:planner: Day, Week, Month, Journal and Settings › Planner (date-fns)
  host/             the host: the adapter over the File System Access API (fs, watch, local,
                    vault-handle, rules, idb) and the service worker (sw.js, plain JS: it is
                    served as written)
web/                the PWA manifest and the icons
vite.config.js      the dev server (the shell from shell/, ose:* aliased to the sources) and the
                    build (the four bundles into dist/ose/, the shell, the worker, the CSP)
vercel.json         Vercel's build of dist/ and its cache headers
tests/              vitest: serializer/ (fast-check properties and named regressions), core/,
                    editor/, live/ (with the property test that Live never changes a byte it
                    was not told to), reading/, planner/, shell/, web/ (over the in-memory File
                    System Access stub in stubs/fsa.js), fixtures/, support/; e2e/: the
                    Playwright suites over the built app
vitest.config.js, playwright.config.js, biome.json, tsconfig.json   the test runners, the lint
                    and the type check
dist/, work/        build output and scratch, gitignored
```

## How to run it

```
npm install
npm run dev            # http://localhost:5173: the app from its sources, in Chrome
npm run build          # dist/: the site Vercel serves
npm run preview        # dist/ served as a static host serves it
npm test               # vitest: serializer, core, editor, Live, reading, planner, shell, web
npm run test:e2e       # Playwright: no loss, Live and Ose Web, on the built app
npm run typecheck      # tsc over src/ (TypeScript) and shell/ (checkJs), strict: zero errors
npm run lint           # Biome, warnings are errors
```

`npm run dev` is the real app: pick a throwaway copy of a vault in Chrome's folder picker, never
a real one. Chrome allows the File System Access API on localhost, so no certificate is needed.
`?opfs=1` on the URL opens the browser's private file system as the vault instead, which is the
tests' hook (docs/HOST.md "Testing").

`npm run test:e2e` builds the app into a temp folder, serves it as plain files on port 5190
(`OSE_E2E_PORT` picks 5190 to 5199) and drives it in Chromium, each test over a fresh vault in
the origin's private file system. It needs `npx playwright install chromium` once per machine
(`OSE_E2E_CHROMIUM` points at another Chromium). `OSE_E2E_KEEP=1` keeps the build and
`node tests/e2e/serve.mjs` starts the same server by hand.

Deploying is pushing: Vercel builds every push (`npm run build`, `vercel.json`), `main` is the
real site and every other branch gets a preview address. CI (`.github/workflows/ci.yml`) runs the
lint, the typecheck, the unit tests, the build and the browser suites on every push to `main` and
every pull request. A new deploy reaches an installed app through its service worker once its
open tabs are closed. See docs/HOST.md.

There is one workflow: **a change** is made here, built, and shipped. The planner is part of the
app like everything else; what a vault decides is only where its files are (Settings › Planner).

## Rules for working in this folder

- Read `docs/FORMATS.md` before touching the planner, `docs/CORE.md` before the core,
  `docs/SHELL.md` before the shell, `docs/HOST.md` before `src/host`, and `docs/DESIGN.md` before
  any UI. A hose is added, never changed in meaning.
  Every document lives in `docs/`; the root `README.md` is one paragraph and stays as it is.
- The core never draws and ships no HTML. Nothing in it knows a view, the planner or a file
  name of the shell.
- The planner imports only `ose:ui`, `ose:editor`, `date-fns` and its own files, never
  `ose:core`. It never spells a vault path: every path is a setting, found automatically the
  first time and confirmed by the user. It writes a line, never a whole file.
- Nothing is hidden by name. The host has the one hide rule (`.ose`, `.git`, the vault bin's
  bookkeeping, temp files and Chrome's `.crswap`, `src/host/rules.ts`); dotfiles wait behind Show
  hidden items. Names are shown in full, with their extension.
- Markdown fidelity is non-negotiable. The editor must never rewrite a file it did not edit, and
  a user edit must not reformat the rest of the file. Hassan's conventions: `-` bullets, `_`
  emphasis, H1 and body text, LF endings, UTF-8 without BOM. One blank line separates two blocks
  and a second one is deliberate space that stays: a run of N blank lines is N minus 1 empty
  lines, which is what the editor shows and what Enter twice leaves.
- Never write to a real vault file while testing. Use a throwaway copy and clean up.
- No new dependency without a reason written in the commit message. The bundles carry Milkdown
  Crepe and kit, CodeMirror 6 and lezer's markdown, marked, DOMPurify, Temml, turndown (HTML
  paste), node-diff3 and date-fns. The host uses the browser's own APIs and adds nothing.
- `src/` is TypeScript; `shell/` and `src/host/sw.js` stay JavaScript, because they are served
  as written, and tsc checks them (checkJs). `strict` is on for both (`noImplicitAny` still
  off); `@ts-ignore` and `@ts-expect-error` are banned, and a type error is fixed, not hidden.
- Colours, fonts and sizes come from the tokens in `ui.css` only. No hex values elsewhere.
  Spacing from the scale; no bare pixel paddings.
- Both themes, every time. Keyboard reachable, every time: every action has a command, every
  command is in the palette, and nothing needs the mouse.
- Minimal and old-school. Boxes, not rules; whitespace does the grouping; the same thing gets
  the same treatment everywhere. Leave room for the user.
- The app is English; file content is never translated.

## What is deliberately not here

- No AI surface. No terminal, no chat pane, no MCP server. Claude Code is run on the vault from
  outside; `CLAUDE.md` in the vault points at `docs/FORMATS.md` and that is the integration.
- No network but the app's own files. The page loads its code from its origin, once; after that
  the service worker serves it and the app works offline. Nothing of a vault is ever sent
  anywhere, and the page names no other host (its CSP says so). It starts no program: opening a
  file shows it in a browser tab, and nothing runs.
- No updater and no installer. A deploy is picked up by the service worker; installing is
  Chrome's own "Install app", and the vault folder is chosen in Chrome.
- No desktop app. The Rust/Tauri host is gone (git history keeps it). What a browser cannot do
  is not done: no system Trash (a delete goes to the vault's `.trash`), no drag out of the
  window, no Show in Explorer, no native paths.
- Tests: `npm test` for the JS (`tests/`, with a small fixture corpus in `tests/fixtures` copied
  from the throwaway vault, never from a real one) and `npm run test:e2e` for the no-loss suite;
  CI runs both. The app itself is still checked by running it.
- No plugins: no loader, no manifest, no marketplace, no third-party code. Day, Week, Month and
  Journal are built in; a vault's old `.ose/plugins` folder is no longer read.
- No interface in the vault: no `.ose/app`, no `cockpit.json`, no fallback page. A shell that
  throws at boot shows an error page with the message, the stack and where the log is, never a
  blank page; the way back is the log and `npm run dev`.
- No database, no index files, no cache of vault content. Everything is recomputed from the files
  at startup. The one exception is a draft: text the editor could not write is kept in the
  browser's storage on this machine until a save lands, so a page that cannot be saved cannot be
  left and nothing typed is lost.
- No sync, no accounts.
- One page at a time in the column. Each tab has its own back and forward, and a page in a tab
  in the background is kept alive, buffer and undo and all, so switching tabs loses nothing.
- The app opens where it was left: the tabs, their history and scroll come back (Settings ›
  Files turns it off). Home is the vault root's listing, Recent, Pins and a row for the planner.
- No drag-to-reorder in the tree: folders come first, and each folder is sorted by name
  (natural order), modified, size or type, as its folder view says. Maths is `$...$` and `$$...$$` by the
  pandoc rule, rendered with Temml to MathML in the platform's maths face; a `$` that opens
  nothing, as in `5 $ puis 10 $`, stays a `$`.
