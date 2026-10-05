# App: Ose

## What this is

Ose (On Site Editor; the French imperative "dare") is a markdown viewer and editor for a personal
file tree. It is a desktop app built with Tauri: a Rust host (`src-tauri/`) and one page (the
core, the kit, the editor, the views and the shell) shown in the system's web view. Installed
once on Windows and macOS, it updates itself: every push to `main` is a release (release.yml),
and an installed Ose downloads it and offers a restart.

The files are the database. Every page is a plain markdown file on disk, edited in place, with
line endings and formatting preserved; the app keeps no index, no cache and no second copy of
anything. **Nothing of the app is written into the vault**: no `.ose` folder. What the app keeps
(a vault's settings and the views' paths, file versions, drafts of unsaved text, the window,
the log) is in the app's own folders on this machine, keyed by the vault. The app opens on Home,
an empty "New tab", every time; it does not reopen the last session. A delete goes to the
system's Recycle Bin or Trash.

It is a file manager as much as an editor: the sidebar is the vault as it is on disk (Views,
Vault, Scratchpad), every file listed under its real name and openable, nothing hidden by name.
A folder is not a page: opening one shows it in the sidebar. Files Ose does not show open in their
own app. Today, Planner and Journal are built-in views (`src/views`): they read ordinary files
(a year file, month files with their week and a table of days, `todo.md`, the journal) whose folders are chosen in
Settings › Views, and write back only one appended or replaced line, or a new `YYYY-MM-DD.md`.
There are no plugins and no loader: Ose is extended by forking it (`docs/VIEWS.md`). An agent
(Claude Code, run on the vault from outside) reads and edits the same files with no adapter,
keeping to the formats in `docs/FORMATS.md`, and Ose picks up its changes as they happen.

A markdown page has two editing modes. **Rich** is Crepe, the page drawn as a document, the Word
way of writing; **Source** is the raw file in CodeMirror, the code editor's way. There is nothing
in between, and there never will be: no Obsidian-style live preview. Rich is the default:
Settings › Editor picks it, and each file remembers the mode it was left in. Any other text file
opens in Source, in its own encoding.

Each vault gets its own window, never two on one vault. A file from outside the vault (Open
file…, or the OS once Ose is installed) opens in a tab marked "outside vault", which saves in
place and has no versions, links or attachments.

## Layout

```
README.md           what Ose is, how to install it, which folder to change for what
index.html          the page: loads src/shell/first-paint.ts and main.ts
src/                TypeScript, built by Vite into one app (dist/); imports are plain paths
  core/             the brain: the `ose` facade (core.ts), router and tabs, file
                    operations and their undo journal, the leave gate, links, names, paths,
                    settings, state and the local store, keys, focus, the watcher, updates, the
                    vault pickers; bridge/ talks to Rust (bindings.ts is generated, see below)
  ui/               the kit: overlays and dialogs, menus, toasts, the clipboard, icons, the
                    loading line, the fuzzy matcher, esc; styles/tokens.css is every colour, font
                    and size, base.css the shared components. Imports nothing from core
  editor/           Rich and Source (Crepe, CodeMirror, marked), one live instance per open file,
                    the 3-way merge of changes made on disk; page/ the parts of one page's life
                    (open, modes, save, merge, drafts, leave…); stringify/ the serializer
  views/            Today and Planner (year, month), Journal, and shared/; index.ts registers
                    them and holds the view contract (docs/VIEWS.md)
  shell/            the interface: layout, title bar and tabs, sidebar (sidebar*.ts, one shared
                    state), status bar, Home, page seam and media card, palette, search, settings,
                    file actions, vault switching, draft recovery; keys.json; the shell's CSS
src-tauri/          the Rust host: every host command (commands.rs, typed for the page by
                    tauri-specta into src/core/bridge/bindings.ts), the vault's files, the
                    watcher, drafts, versions and state in the app's data folder, the window,
                    the updater; tauri.conf.json, tauri.dev.json, icons/ (from icons/source.svg;
                    icon.icns from icons/macos.svg, the same mark on the Mac's rounded tile:
                    `npx tauri icon` on each, keeping only icon.icns from the second)
site/               the landing page: static, no build (index.html, style.css, main.js, shots/:
                    pictures only, in both themes); a Vercel project serves this folder. Its
                    tokens are copies of the app's, held equal by tests/site/tokens.test.js
docs/               CORE.md, SHELL.md, HOST.md, VIEWS.md, FORMATS.md (the views' files and
                    exactly what the app writes), DESIGN.md (tokens, components, the look)
tests/              vitest: serializer/ (fast-check properties and named regressions), core/,
                    editor/, views/, shell/, fixtures/, support/, stubs/. The host's own tests
                    are in src-tauri (`cargo test`)
vite.config.js, vitest.config.js, biome.json, tsconfig.json
```

The direction of imports: **ui ← core ← editor; views and shell use them.** The kit imports
nothing; the core never imports the editor, the views or the shell; a view is handed `ose` and
imports only `src/ui`, `date-fns`, `shared/` and its own files (the editor by dynamic import).

## How to run it

```
npm install
npm run app:dev        # "Ose Dev": the app from its sources, beside the installed Ose
npm run app            # the same with the installed app's identifier: shares its data and lock
npm run app:build      # the installer for this machine (tauri build)
npm test               # vitest
npm run typecheck      # tsc over src/, strict: zero errors
npm run lint           # Biome, warnings are errors
npm run site           # the landing page (site/) on localhost:5180
cargo test --manifest-path src-tauri/Cargo.toml   # the host
OSE_WRITE_BINDINGS=1 cargo test --manifest-path src-tauri/Cargo.toml bindings   # regenerate bindings.ts
```

Use `npm run app:dev`, which keeps its own data folders. It opens the vault it remembers; a
vault path after `-- --` opens that one. Point it at a throwaway copy of a vault, never a real
one, before trying anything that writes.

**Every change stays local until Hassan says to push.** Work is committed on the local `dev`
branch and tested in the app on a throwaway vault; nothing is pushed, not even to `dev`, and no
PR is opened, until he says so in so many words. A push to `dev` runs CI and a push to `main` a
full release: neither is spent on small changes.

**`main` is sacred: every merge into it is a public release.** When Hassan asks, `dev` is pushed;
after many refinements, and only once he has accepted the batch, it reaches `main` as one PR from
`dev`, squashed into one commit, so `main` stays a short list of releases.

Shipping is pushing: every push to `main` builds Windows and macOS in GitHub Actions
(`.github/workflows/release.yml`) and publishes a release with `latest.json`; an installed Ose
downloads it and offers a restart. The updater's private key is the repository secret
`TAURI_SIGNING_PRIVATE_KEY`; its public half is `plugins.updater.pubkey` in tauri.conf.json.
CI (`ci.yml`) runs the lint, the typecheck, the unit tests, the build and the host's tests on
every pull request and every push to `dev` and `main`.

## Rules for working in this folder

- Read the doc of the part you touch first: `docs/CORE.md`, `docs/SHELL.md`, `docs/HOST.md`,
  `docs/VIEWS.md` and `docs/FORMATS.md` (views), `docs/DESIGN.md` (any UI).
- The core holds state and rules; it draws only the router's small boxes (not found, a view
  that failed) and the vault pickers. Nothing in it knows a view or the shell.
- A view writes a line, never a whole file, and never spells a vault path: every path is a
  setting, found automatically the first time and confirmed by the user.
- Nothing is hidden by name. The host has the one hide rule (`.ose`, `.git`, the vault bin's
  bookkeeping, temp files, `src-tauri/src/hide.rs`); dotfiles wait behind Show hidden items.
  Names are shown in full, with their extension.
- Markdown fidelity is non-negotiable. The editor must never rewrite a file it did not edit, and
  a user edit must not reformat the rest of the file. Hassan's conventions: `-` bullets, `_`
  emphasis, H1 and body text, LF endings, UTF-8 without BOM. One blank line separates two blocks
  and a second one is deliberate space that stays: a run of N blank lines is N minus 1 empty
  lines, which is what the editor shows and what Enter twice leaves.
- Never write to a real vault file while testing. Use a throwaway copy and clean up.
- No new dependency without a reason written in the commit message. The page carries Milkdown
  Crepe and kit, CodeMirror 6 and lezer's markdown, marked, DOMPurify, Temml, node-diff3 and
  date-fns, and Tauri's API and updater.
- Everything in `src/` is TypeScript, `strict` on (`noImplicitAny` still off); `@ts-ignore` and
  `@ts-expect-error` are banned, and a type error is fixed, not hidden.
- Colours, fonts and sizes come from the tokens in `src/ui/styles/tokens.css` only. No hex
  values elsewhere. Spacing from the scale; no bare pixel paddings.
- Both themes, every time. Keyboard reachable, every time: every action has a command, every
  command is in the palette, and nothing needs the mouse. Shortcuts are listed in Settings ›
  Help only, never as hints elsewhere.
- Minimal and old-school, calm: near black and white, one accent used sparingly. Boxes, not
  rules; whitespace does the grouping; the same thing gets the same treatment everywhere. Leave
  room for the user.
- The app is English; file content is never translated.

## What is deliberately not here

- No AI surface. No terminal, no chat pane, no MCP server. Claude Code is run on the vault from
  outside; `CLAUDE.md` in the vault points at `docs/FORMATS.md` and that is the integration.
- No network but the update check (GitHub releases). Nothing of a vault is ever sent anywhere.
- No website in this app: the browser host and the PWA are gone (git history keeps them). The
  landing page, when it comes, is its own static folder (`site/`).
- No plugins: no loader, no manifest, no marketplace. A new view is a folder in `src/views/`.
- No interface in the vault. A shell that throws at boot shows an error page with the message,
  the stack and where the log is, never a blank page.
- No database, no index files, no cache of vault content. Everything is recomputed from the files
  at startup. The one exception is a draft: text the editor could not write is kept in the
  app's data folder on this machine until a save lands, so a page that cannot be saved cannot be
  left and nothing typed is lost.
- No sync, no accounts, no session restore.
- One page at a time in the column. Each tab has its own history (Alt+Left, Alt+Right), and a
  page in a tab in the background is kept alive, buffer and undo and all.
- No drag-to-reorder in the tree: folders come first, then files, by name in natural order.
- Maths is `$...$` and `$$...$$` by the pandoc rule, rendered with Temml to MathML in the
  platform's maths face; a `$` that opens nothing, as in `5 $ puis 10 $`, stays a `$`.
- Tests: `npm test` for the page (`tests/`, with a small fixture corpus copied from a throwaway
  vault, never a real one) and `cargo test` for the host; CI runs both. The app itself is still
  checked by running it.
