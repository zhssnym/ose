# App: Ose

## What this is

Ose (On Site Editor; the French imperative "dare") is a markdown viewer and editor for a personal
file tree. It is a desktop app built with Tauri: a Rust host (`src-tauri/`) and one page (the
core, the editor, the planner and the shell) shown in the system's web view. Installed once on
Windows and macOS, it updates itself: every push to `main` is a release (release.yml), and an
installed Ose downloads it and offers a restart.

The files are the database. Every page is a plain markdown file on disk, edited in place, with
line endings and formatting preserved; the app keeps no index, no cache and no second copy of
anything. **Nothing of the app is written into the vault**: no `.ose` folder. What the app keeps
(a vault's settings and the planner's paths, file versions, drafts of unsaved text, the window,
the log) is in the app's own folders on this machine, keyed by the vault. The app opens on the
vault folder every time; it does not reopen the last session. A delete goes to the system's
Recycle Bin or Trash.

It is a file manager as much as an editor: one tree rooted at the vault, every folder a place
with its own view, every file listed under its real name and openable, nothing hidden by name.
The planner's four views are built in, `src/planner`: they read ordinary files (a timetable, todo
lists, a monthly plan, `systems.jsonl`, the journal) whose paths are chosen in Settings › Planner,
and write back only one appended or replaced line, or a new `YYYY-MM-DD.md`. There are no plugins
and no loader. An agent (Claude Code, run on the vault from outside) reads and edits the same
files with no adapter, keeping to the formats in `docs/FORMATS.md`, and Ose picks up its changes
as they happen.

A markdown page has two editing modes. **Rich** is Crepe, the page drawn as a document, the Word
way of writing; **Source** is the raw file in CodeMirror, the code editor's way. There is nothing
in between. Rich is the default: Settings › Editor picks it, and each file remembers the mode it
was left in. Any other text file opens in Source, in its own encoding.

Each vault gets its own window, never two on one vault. A file from outside the vault (Open
file…, or the OS once Ose is installed) opens in a tab marked "outside vault", which saves in
place and has no versions, links or attachments.

## Layout

```
README.md           what Ose is, in Hassan's words
docs/
  FORMATS.md        the planner's files: what each one holds, and exactly what the app writes
  CORE.md         everything on `ose`: files, fileops, routes, tabs, session, the local store
  SHELL.md          the interface: layout, boot, places and tabs, the tree, the page seam, settings
  HOST.md           the host (largely about the old browser host; src-tauri is the truth): every command, writes, the watcher, drafts,
                    versions, the trash, the service worker and the `vault/` origin, the tests
  DESIGN.md         the visual system: tokens, components, the look
shell/              the interface, flat: index.html, main.js, the surfaces (tree, folder view,
                    Home, tabs, address bar, search, settings, trash), shell.css, tree.css,
                    places.css, folder.css, theme.css, keys.json, logo.png. Copied verbatim into
                    dist/ by the build. The tree is sidebar.js and its parts, sidebar-*.js, which
                    share one `state` (sidebar-state.js); the folder view is folder.js and
                    folder-sort.js, folder-list.js, folder-view.js.
src/                TypeScript, built by Vite into the four bundles
  core/             ose:core (registry, bridge, router, tabs, session, local store, links,
                    fileops and the undo journal, settings core, state, theme, keys, watch),
                    ose:ui (dialogs, pickers, menu, toast, icons; ui.css = tokens + base);
                    bridge/commands.ts types every host command, kept by hand
  editor/           ose:editor: markdownPage in Rich and Source, codeEditor, render
                    (Crepe, CodeMirror, marked), one live instance per open file, the 3-way
                    merge of changes made on disk, page/ the parts of page.ts (open, modes, save, merge, drafts, ...), each
                    adding its functions to one instance's `ctx`; stringify/ the serializer's
                    parts (write, cleanup, reconcile, blocks, markers, tables)
  planner/          ose:planner: Day, Week, Month, Journal and Settings › Planner (date-fns)
src-tauri/          the Rust host: every host command (commands.rs, typed for the page by
                    tauri-specta into src/core/bridge/bindings.ts), the vault's files, the
                    watcher, drafts, versions and state in the app's data folder, the window,
                    the updater; tauri.conf.json, icons/ (from icons/source.svg: `npx tauri icon`)
vite.config.js      the dev server (the shell from shell/, ose:* aliased to the sources) and the
                    build (the four bundles into dist/ose/, the shell beside them)
tests/              vitest: serializer/ (fast-check properties and named regressions), core/,
                    editor/ (with the property test that Source never changes a byte it was
                    not told to), planner/, shell/, fixtures/, support/. The host's
                    own tests are in src-tauri (`cargo test`)
vitest.config.js, biome.json, tsconfig.json   the test runners, the lint
                    and the type check
dist/, work/        build output and scratch, gitignored
```

## How to run it

```
npm install
npm run app            # the app, from its sources (tauri dev: the Rust host and the dev server)
npm run app:build      # the installer for this machine (tauri build)
npm test               # vitest: serializer, core, editor, planner, shell
npm run typecheck      # tsc over src/ (TypeScript) and shell/ (checkJs), strict: zero errors
npm run lint           # Biome, warnings are errors
cargo test --manifest-path src-tauri/Cargo.toml   # the host
```

`npm run app` opens the vault the app remembers: point it at a throwaway copy of a vault, never
a real one, before trying anything that writes.

**`main` is sacred: every merge into it is a public release.** All work goes to the `dev`
branch (small PRs into `dev` are fine, they release nothing), is tested locally in the app on a
throwaway vault, and reaches `main` only as one PR from `dev` once Hassan has accepted the batch.

Shipping is pushing: every push to `main` builds Windows and macOS in GitHub Actions
(`.github/workflows/release.yml`) and publishes a release with `latest.json`; an installed Ose
downloads it and offers a restart. The updater's private key is the repository secret
`TAURI_SIGNING_PRIVATE_KEY`; its public half is `plugins.updater.pubkey` in tauri.conf.json.
CI (`ci.yml`) runs the lint, the typecheck, the unit tests, the build and the host's tests on
every pull request.

There is one workflow: **a change** is made here, built, and shipped. The planner is part of the
app like everything else; what a vault decides is only where its files are (Settings › Planner).

## Rules for working in this folder

- Read `docs/FORMATS.md` before touching the planner, `docs/CORE.md` before the core,
  `docs/SHELL.md` before the shell, `docs/HOST.md` before `src-tauri`, and `docs/DESIGN.md` before
  any UI. A hose is added, never changed in meaning.
  Every document lives in `docs/`; the root `README.md` is what Ose is and how to install it.
- The core never draws and ships no HTML. Nothing in it knows a view, the planner or a file
  name of the shell.
- The planner imports only `ose:ui`, `ose:editor`, `date-fns` and its own files, never
  `ose:core`. It never spells a vault path: every path is a setting, found automatically the
  first time and confirmed by the user. It writes a line, never a whole file.
- Nothing is hidden by name. The host has the one hide rule (`.ose`, `.git`, the vault bin's
  bookkeeping, temp files, `src-tauri/src/hide.rs`); dotfiles wait behind Show
  hidden items. Names are shown in full, with their extension.
- Markdown fidelity is non-negotiable. The editor must never rewrite a file it did not edit, and
  a user edit must not reformat the rest of the file. Hassan's conventions: `-` bullets, `_`
  emphasis, H1 and body text, LF endings, UTF-8 without BOM. One blank line separates two blocks
  and a second one is deliberate space that stays: a run of N blank lines is N minus 1 empty
  lines, which is what the editor shows and what Enter twice leaves.
- Never write to a real vault file while testing. Use a throwaway copy and clean up.
- No new dependency without a reason written in the commit message. The bundles carry Milkdown
  Crepe and kit, CodeMirror 6 and lezer's markdown, marked, DOMPurify, Temml,
  node-diff3 and date-fns, and Tauri's API and updater.
- `src/` is TypeScript; `shell/` stays JavaScript, because it is served
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
- No network but the update check (GitHub releases). Nothing of a vault is ever sent anywhere.
- No website: the browser host, the PWA and Vercel are gone (git history keeps them).
- Tests: `npm test` for the JS (`tests/`, with a small fixture corpus in `tests/fixtures` copied
  from the throwaway vault, never from a real one) and `cargo test` for the host; CI runs both.
  The app itself is still checked by running it.
- No plugins: no loader, no manifest, no marketplace, no third-party code. Day, Week, Month and
  Journal are built in; a vault's old `.ose/plugins` folder is no longer read.
- No interface in the vault: no `.ose/app`, no `cockpit.json`, no fallback page. A shell that
  throws at boot shows an error page with the message, the stack and where the log is, never a
  blank page; the way back is the log and `npm run dev`.
- No database, no index files, no cache of vault content. Everything is recomputed from the files
  at startup. The one exception is a draft: text the editor could not write is kept in the
  app's data folder on this machine until a save lands, so a page that cannot be saved cannot be
  left and nothing typed is lost.
- No sync, no accounts.
- One page at a time in the column. Each tab has its own back and forward, and a page in a tab
  in the background is kept alive, buffer and undo and all, so switching tabs loses nothing.
- The app opens on Home, the vault root's folder view. Nothing of the last session comes back.
- No drag-to-reorder in the tree: folders come first, and each folder is sorted by name
  (natural order), modified, size or type, as its folder view says. Maths is `$...$` and `$$...$$` by the
  pandoc rule, rendered with Temml to MathML in the platform's maths face; a `$` that opens
  nothing, as in `5 $ puis 10 $`, stays a `$`.
