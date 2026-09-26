# The host

The host is the Rust half of `ose.exe`: a Tauri 2 window, the vault's filesystem, the watcher,
file versions, processes, the three origins the app is drawn from, and the single-instance rule.
It draws nothing and knows nothing about views or plugins. The JavaScript reaches it through one
Tauri command, `rpc`, whose surface is `docs/KERNEL.md`.

```
src-tauri/src/
  main.rs       argv, the window, geometry, single instance, the menu (macOS), the protocols
  lib.rs        AppState, the epoch, the `rpc` dispatch, `gone()`, the persistent log
  args.rs       the four flags
  shell.rs      the `ose` and `app` origins, the index rewrite, the CSP, load_window, reload
  protocol.rs   the `vault` origin
  vault.rs      paths, the vault filesystem, what is hidden, the root resolution, the hash,
                write_atomic
  files.rs      readFile, saveFile, createNew, copyFile, appendLine, replaceLine
  drafts.rs     unsaved buffers, per machine, outside the vault
  watcher.rs    notify on the root, debounced into one `fs` event, rescan
  versions.rs   .ose/history, tiered
  run.rs        starting a program, streamed line by line
  print.rs      the PDF and the system print dialog (WebView2's on Windows, WKWebView's dialog on macOS)
  state.rs  vaults.rs  platform.rs      state.json, the recent vaults, open/reveal and the stamp
```

## The three origins

Tauri maps a custom scheme to `http://<scheme>.localhost/…` on Windows and `<scheme>://localhost/…`
on macOS and Linux. `shell.rs::origin()` is the one place that knows which.

- **`ose`** serves `dist-kernel/` out of the executable: `kernel.js`, `editor.js`, `ui.js`,
  `md.js`, `ui.css`, `editor.css`. GET only, CORS open, `no-store`.
- **`app`** serves the app itself. The window opens on `<app origin>/index.html`.
- **`vault`** serves the vault's own files read-only, so an `<img src>` or a PDF frame can point
  at a file in the tree. It answers `application/pdf` for a `.pdf`, which is what lets the web
  view's viewer draw it. Every answer carries `X-Content-Type-Options: nosniff`, and a file that
  could run script as a document (`.html`, `.htm`, `.xhtml`, `.svg`, `.xml`, `.xsl`) also carries
  `Content-Security-Policy: sandbox`: it is shown, never executed. An `<img>` of an SVG is
  unaffected, and a PDF gets no sandbox, which the viewer would refuse.

The whole contract of the `app` origin is five rules:

1. Anything under `/plugins/` is `<vault>/.ose/plugins/<rest>`, read from disk on every request,
   with `Cache-Control: no-cache`: a plugin is the vault owner's code, edited in place.
2. Everything else is a file of the shell: `<dir>/<path>` on disk when `--shell <dir>` was given,
   otherwise the embedded `shell/<path>`, with `no-store`.
3. `/` and `/index.html` are the shell's `index.html`, and it is the only file that is rewritten:
   the import map goes in after `<head>`, `<link data-ose="ui">` and `<link data-ose="editor">`
   get the kernel origin's stylesheets, and the response carries the `Content-Security-Policy`.
4. A missing file, a folder, a path that escapes its folder, and "there is no vault" for a plugin
   are all the same plain-text 404. No listing, no redirect, no guessing.
5. `--shell` moves the shell and nothing else: plugins always come from the vault.

The CSP names the three origins, allows inline styles, allows the one inline script the host
injects by its sha256 rather than by `'unsafe-inline'`, keeps `object-src 'none'`, gives
`frame-src` to the vault origin alone, and allows nothing whatsoever from the network.

## Flags

```
--root <path>     the vault, when it is a folder that exists
--log <file>      also append the host and UI lines to this file, with every rpc name
--shell <dir>     serve the shell from this folder instead of the copy inside the executable
--version         print `ose <version> (<short sha>, <date>)`, or `(dev build)` locally, and exit
```

Nothing else. An unknown flag is ignored in silence, so an old shortcut still starts the app.

## The vault root

In order, the first that answers:

1. `--root <path>`, when it is a directory;
2. the nearest ancestor of the executable that looks like a vault (it holds `.ose/` or a
   `CLAUDE.md` and does not hold `src-tauri/`), the executable's own folder first;
3. `OSE_ROOT`;
4. the remembered root, one line in `<app config dir>/vault`, read once the app has a config
   folder;
5. nothing: the host logs `no vault: the shell will ask for a folder`, loads the shell anyway, and
   `pickVault` opens the native dialog when the page asks. There is no pre-window picker.

Whatever is opened goes to the top of the recent list, so the chooser knows about a vault the app
opened by itself as well as the ones that were picked.

## Single instance

One window per vault. A second launch hands its argv to the copy that holds the lock and exits
inside `builder.build()`, before a line of the second process runs. The same vault, or none named,
brings the window forward. Another folder is **asked for, never adopted** (C5): the host logs it,
sends the `vault` event `{ requested: true, root, name }` and brings the window forward. The page
leaves the vault it is in (saving every page, or refusing and saying why), then opens the new one
with `openVault` and reloads with `reloadShell`. The host never swaps the vault or reloads the
window under a page that may hold unsaved work, and `{ changed: true }` is never sent. The lock is probed before the plugin is installed and the handover is said out loud in the
log, because a copy holding the lock can be a ghost and "the app does not start and the log says
nothing" is the one case a person cannot diagnose.

## The watcher

`notify` on the root, recursive, hidden paths filtered, changes debounced 150ms into one `fs`
event, `{ changes: [{ path, kind, to? }], lost?, rescan? }`. A rename arrives as two events with
nothing joining them, so the pair is matched by arrival order; the kind that goes out is decided at
flush time from the raw kind plus whether the path still exists, so a path reported gone is gone
when the event leaves. A flood is flushed rather than accumulated. `lost` says the vault folder
itself went away (and `lost: false` that it came back).

`rescan: true` (with `changes: []` or alongside them) says "you may have missed events: re-read
what you show" (H9). It is sent when notify flags an event with Rescan, when the Windows backend
gives up on `ReadDirectoryChangesW` (a buffer overflow during a checkout: notify only writes a
`log::error!`, which `lib.rs`'s log hook turns into a watcher restart), and once after every
restart that followed an error.

A rename the watcher paired moves the file's history and drafts with it, exactly as a rename
through the app does, but only when it is a real move (`from` gone, `to` there): an editor that
renames a file aside and writes a new one in its place keeps its history where it was.

## Errors

Every command fails with a string `[code] message`. The codes: `not_found`, `exists`, `not_utf8`,
`stale_vault`, `no_vault`, `write_failed`, `bad_arg`, `bad_name`, `escapes_vault`, `io`,
`unknown_command`. An error with no code of its own is sent as `[io]`. The kernel splits the code
off into `err.code`.

## Epoch

`AppState` holds an epoch: 1 at startup, one more on every vault adopted while the app runs.
`rootInfo` and `vaultInfo` answer it. Every mutating command takes an optional trailing options
object, and one naming an `epoch` other than the current one does nothing and fails with
`[stale_vault]`, so the last save of a page from the vault that was just left can never land in
the one that replaced it. A caller that names none (a read, an old page) is let through.

## The hash

FNV-1a, 64 bits, over the file's raw bytes (offset `0xcbf29ce484222325`, prime `0x100000001b3`),
as 16 lowercase hex digits: `""` is `cbf29ce484222325`, `"a"` is `af63dc4c8601ec8c`. It is a
fingerprint, not a defence. The page never computes one: it carries what `readFile` and `saveFile`
answered and compares by equality.

## Writes

Every file the host writes, in the vault or out of it (pages, versions, `state.json`, drafts),
goes through `vault::write_atomic` (C3):

1. a temp file beside the target, `.<name>.<pid>.<n>.tmp`, written and `sync_all`ed;
2. `rename` onto the target. There is no delete first: `std::fs::rename` replaces an existing
   file on Windows too;
3. a rename refused with a sharing violation, access denied or a lock violation (Windows 32, 5,
   33: a scanner, the indexer or a sync client holding the fresh file) is retried with backoff,
   10, 20, 40 … ms, about two seconds in all;
4. once the bytes are on disk they are **never deleted**. A rename that still fails moves the temp
   file to a visible `<stem>.unsaved-<yyyymmdd-hhmmss>.<ext>` beside the target (or leaves it
   where it is when even that is refused), and the command fails with
   `[write_failed] <path>: <os error>; your text is in <that file>`;
5. on unix the folder is fsynced after the rename.

A temp file whose own write failed (a full disk) is removed: the target was never touched.

## Files

The save path, in `files.rs`. Arguments are positional; `opts` is last and optional.

- **`readFile(path)`** → `{ text, hash, mtime, size }`: every byte, a byte-order mark and CRLF
  included. `not_utf8` for bytes that are not text.
- **`saveFile(path, text, { expectedHash, version? })`** → `{ status: 'saved', hash, mtime,
  unchanged? }` or `{ status: 'conflict', disk: { exists, text, hash } }` (M2). One call does the
  compare and the write, under a process-wide lock per path. `expectedHash: null` means the file
  must not exist; a string means the disk must still hold those bytes; leaving it out is
  `[bad_arg]`, so nothing writes blind. When the disk already holds `text` the answer is `saved`
  with `unchanged: true` and nothing is written. On a mismatch nothing is written and the disk is
  answered (`text` is null for a missing file or bytes that are not UTF-8). Otherwise the bytes
  being replaced are kept as a version (`version: 'save'`, the default, tiered; `'conflict'`,
  forced, for "Keep mine"; `'none'`), a version that fails never blocks the save, the folders are
  created and the file is written with `write_atomic`. Every outcome goes to the log: `save ok`,
  `save conflict`, `save failed`.
- **`createNew(path, text = '')`** → `{ path, hash }` (M4): the folders are created and the file
  is opened exclusively (`create_new`), written and synced. It never overwrites: an existing file,
  in any case the filesystem folds, is `[exists]`. A name the filesystem would refuse is
  `[bad_name]`.
- **`copyFile(from, to)`** → `{ path, hash }`: a byte copy of any file under the same rule.
- **`appendLine(path, line)`** → `{ hash }` (M30): `line` may not hold `\n` or `\r`. Writes
  `sep + line + eol`, where `eol` is `\r\n` when the file's last line ending is CRLF and `\n`
  otherwise, and `sep` is `eol` when the file is non-empty and does not end in `\n`. The file and
  its folders are created when missing. No version: nothing is replaced.
- **`replaceLine(path, index, expected, next)`** → `{ status: 'replaced', hash }` or
  `{ status: 'conflict', actual }` (M31). Lines split on `\n`, a `\r` before it belonging to the
  separator, `index` 0-based; the empty piece after a final `\n` is not a line. The line becomes
  `next` only if it still reads `expected`; its separator and every other byte stay, the write is
  atomic and the replaced bytes are a tiered version. Out of range is `actual: null`.

## Drafts

The buffer of a page that could not be written (C4, D5): kept on this machine, outside the vault,
never synced. One JSON file per page at
`<app local data>/drafts/<vaultKey>/<pathKey>.json`, where `vaultKey` is the hash of the vault's
normalised absolute root with forward slashes (lowercased on Windows and macOS) and `pathKey` the
hash of the vault path. The file holds `v: 1`, `vault` (the root), `path`, `text`, `baselineHash`
(the disk text the buffer was based on, null when the file did not exist), `mode` (`rich` or
`source`), `exact` (false when the text is a best effort, not what a save would write), `rev` (the
editor's edit counter) and `at` (set by the host). Writes go through `write_atomic`.

- `draftWrite(path, draft)` → `{ at }`.
- `draftList()` → the open vault's drafts without their text, with `bytes`, newest first.
- `draftRead(path)` → the draft, or `null`.
- `draftDrop(path, { ifRev? })` → `{ dropped }`: with `ifRev`, only a draft whose `rev` is at most
  that goes, so typing newer than the save that asked is kept.

A rename moves the drafts at or under `from` to `to`; a trash leaves them where they are.

## Versions

Before a save replaces a vault file, the bytes it replaces are kept under `.ose/history/`, the
file's own path a folder: `7-scratchpad/note.md` keeps its versions in
`.ose/history/7-scratchpad/note.md/`. The file names are the host's business (the page only ever
sees ids): `<id>.<reason>[-s].<ext>`, the id the UTC time (`2026-09-10-201500`), the reason `save`,
`conflict`, `reload` or `restore`, `-s` on the first version of that file this session, and the
file's own extension, so a version of `data.json` is JSON. On first use a `.ose/versions/` folder
from before is renamed to `.ose/history/`, and its `<id>.md` names still read.

`versionList(path)` answers `[{ id, at, bytes, reason, session }]`, newest first.
`versionKeep(path, text, opts)` takes the old boolean `force` or `{ force?, reason? }`.
`versionRestore(path, id)` keeps the current bytes (reason `restore`, forced) before writing the
version back, and answers `{ kept, id, hash }`.

A non-forced keep is at most one per file per minute, and identical bytes are never kept twice.
After every keep the file's versions are thinned (H10, D10): under an hour, every one; an hour to a
day, the newest of each clock hour; a day to thirty days, the newest of each calendar day (UTC);
older, none but the file's newest. A session's first version and every version whose reason is
not `save` stay thirty days whatever the thinning says. Across the vault the history is held under
200 MB, the oldest evicted first, never a file's newest version and never one under a day old.

A rename moves `.ose/history/<from>` to `<to>`, a file's folder or a folder's whole subtree,
merging when the target has one already. A trash leaves the history where it is. `.ose` is hidden
from the tree, so a version is never a page.

## The log

Every build writes `<app log dir>/ose.log` (M54), rotated at 2 MB with three files kept
(`ose.log`, `ose.1.log`, `ose.2.log`); `platform().logPath` says where. The lines written before
the folder is known are held and written first. The `log` crate's warnings and errors (Tauri's,
wry's, notify's) go there too. `--log <file>` still works, and adds every rpc name. The page writes
with `log(text, level)` (`error`, `warn`, `info`, `debug`), one line `<stamp> <level> ui: <text>`;
the kernel forwards the window's uncaught errors that way, and the editor every save outcome.

## Browser keys

WebView2's browser accelerator keys are off (`AreBrowserAcceleratorKeysEnabled = false`, M53): F5,
Ctrl+R and Ctrl+Shift+R would reload the page under unsaved work without asking. The page still
receives every key, so the app's own Ctrl+P and Ctrl+F work, and the editing keys are untouched.
WKWebView has no such keys; the shell guards the same chords in JS on both.

## `run`

There is no allow list and no `settings.run`: a plugin is the vault owner's own code and may start
any program. What stays narrow is the shape of the call. There is no shell: `cmd` is a program
name on PATH or a vault-relative path to a file inside the vault, and `args` is passed through
untouched, so nothing a person typed into a page is ever re-parsed as a command line. `cwd` must
be inside the vault. Every child gets `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `LANG=C.UTF-8` and
`LC_ALL=C.UTF-8` under whatever the caller passed. The host answers `{ id, pid }` the moment the
process starts and streams everything else as `run` events, ending with
`{ id, done, code, timedOut }`; it buffers nothing. A process is killed at its timeout and when
the app exits.

## Print

Two RPCs, `printToPdf` and `showPrintUI`. On Windows both are WebView2's own. On macOS
`printToPdf` answers an error that says to use Print, and `showPrintUI` opens the webview's own
print operation, the macOS dialog, whose PDF menu saves the page. Nothing
in the app calls `window.print()`: in WebView2 that call does not return, the renderer stops
answering and whatever the page changed before it stays changed. That is what made `Export to PDF`
render a tenth of a sheet and leave the app in the light theme.

- **`printToPdf(path, { name, folder })`** → `{ path, bytes }`. `ICoreWebView2_7::PrintToPdf`
  writes the file and the command returns when it is on disk. With no `path` the host opens the
  native save dialog first (the dialog plugin, as `pickVault` uses it): `folder` is a vault-relative
  folder to open in, `name` the file name to offer, and a page title is cleaned into one. A
  cancelled dialog answers `{ cancelled: true }`, which is not `null`, because `null` is what a
  host that has no such command answers and the page has to tell the two apart.
- **`showPrintUI()`** → `{ shown: true }`. `ICoreWebView2_16::ShowPrintUI` with
  `COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM`: the Windows print dialog, which is also how "Microsoft
  Print to PDF" is reached. The dialog is modal and runs its own message loop, so the window is
  unresponsive while it is up and the call resolves when it closes.

The settings come from `ICoreWebView2Environment6::CreatePrintSettings`: A4 portrait
(8.27 × 11.69 inches), scale 1, no header or footer, **margins of zero** and **backgrounds off**.

The margins are zero here because the sheet is described in one place, `src/editor/print.css`, whose
`@page` is A4 with a 2cm margin, and the CSS is what governs: measured on the acceptance page, a
`--print-margin` of 0cm gives one page and 2cm gives two, with the settings unchanged. Custom
properties inside `@page` work in WebView2.

Backgrounds are off for a reason that is not obvious. With them on, WebView2 paints the whole page
box — the margins included — with the webview's own default background colour, and the host sets
that from the theme (`winSetTheme`), so a sheet exported from the dark theme came out as a dark grey
page with a white text block inside it. No stylesheet can reach that fill: `html { background: red }`
under `@media print` colours the text block and leaves the page box alone. With backgrounds off the
fill is gone and the paper is paper. Nothing is lost by it, because under `@media print` every
background in the palette is already white; the one exception, the black fill of a done task's
checkbox, print.css draws as a ticked outline instead. Rules, frames and borders are not backgrounds
and print either way.

`webview2-com` and `windows-core` are named in `Cargo.toml` for this, under
`[target.'cfg(windows)'.dependencies]`. Neither is a new download: Tauri's own webview already
depends on both.

## RPC

One Tauri command carries the whole surface. A name no handler claims fails with
`[unknown_command] <name>`, logged the first time: a `null` read as "saved" is how a page could
lose text against an older host. Only the names a past version retired (`riceInfo`, `riceReady`,
`riceFailed`, every `update*`) still answer `null`.

`reloadShell` (also `reloadRice`, the 0.5.0 spelling) navigates the main window back to
`<app origin>/index.html`, which reloads the page and therefore every plugin from disk. The page
calls it only after it has left the window (`ose.reload()`, "Reload plugins"); the host does not
ask again.

`pickVault({ adopt })` opens the folder dialog; with `adopt: false` the folder is only chosen and
answered as `{ root, name }`, neither adopted nor recorded, so the page can leave the old vault
first.

`dev/bridge-plugin.mjs`, with `dev/files.mjs`, is the same surface in Node for the browser dev
server: the same commands, answers, error strings and hash, drafts and the log under
`work/dev-appdata` (or `OSE_DEV_APPDATA`).

## Building

```
cd D:\ose
npm ci
npm run build                       # dist-kernel/: the bundles, ui.css, editor.css, shell/, index.html
cd src-tauri
cargo build --release               # src-tauri/target/release/ose.exe
.\target\release\ose.exe --version
```

`npm run build` is vite over `vite.kernel.config.js`: five entries (kernel, ui, md, ui.css,
editor), nothing hashed, nothing inlined, and a `closeBundle` hook that runs
`scripts/embed-shell.mjs` to copy `shell/` verbatim into `dist-kernel/shell/` and write
`dist-kernel/index.html`. That index is a blank page with the dark background and no script: it is
what the window opens on for the few milliseconds before `setup` sends it to the shell, and
nothing depends on it. While only the shell changed, `node scripts/embed-shell.mjs` and then
`cargo build --release` is enough.

`npm run tauri:build` from the repo root does the whole thing in one step (its
`beforeBuildCommand` is `npm run build`) and resolves to `tauri build --no-bundle` on Windows: one
executable, no installer. `npm run ship` builds and copies `ose.exe` to the vault root, and
carries `WebView2Loader.dll` beside it when a local build made one: a MinGW build loads that DLL
from beside the executable, while the MSVC toolchain CI uses links it statically.

`npm run tauri:dev` is a trap: in dev mode Tauri serves `devUrl` instead of `frontendDist`, so the
asset resolver is empty and the embedded shell 404s. The development loop is
`ose.exe --root <vault> --shell D:\ose\shell`: edit a file in `shell/`, run Reload plugins
(`app.reload`) from the palette, no rebuild. The same goes for a plugin, with no flag at all.

## CI

`.github/workflows/build.yml` has two build jobs. Windows is MSVC, so the result is a single
self-contained file. Checkout, node 22, rust stable with clippy, rust-cache, `npm ci`, `npm test`
(H11: a failing test stops the build), `npm run build`, `cargo test` and `cargo clippy` in
`src-tauri` (clippy reports and does not fail yet), a
check that `dist-kernel/` holds the bundles and `shell/index.html`, the `OSE_BUILD_SHA` /
`OSE_BUILD_DATE` stamp, `npm run tauri:build`, `ose.exe` staged at the workspace root, an assert
that `ose --version` matches `^ose 1\.\d+\.\d+ \(`, and the artifact `ose-windows`. A second job
publishes to the rolling `latest` prerelease and runs only on a push to `main`; a
`workflow_dispatch` on any ref stops after the artifacts. macOS runs on `macos-14` (Apple
silicon): the same steps, tests and clippy included, to `npm run tauri:build`, which bundles `Ose.app`, the same `--version`
assert, and `ose-macos-arm64.zip` packed with `ditto`. The release waits for both jobs but needs
only Windows: a failed macOS build publishes Windows alone.
