# The host

The host is the Rust half of `ose.exe`: Tauri 2 windows, one per vault; the vault's filesystem and
its one hide rule; the watcher; the trash; file versions; drafts; the per-machine store; text in any
encoding; files outside the vault; opens from the OS; and the single-instance rule. It draws nothing
and knows nothing about views. It starts no program of its own choosing: handing a file, a folder or
a link to the system (`openPath`, `reveal`, `openExternal`) is all that leaves the process.

The JavaScript reaches it through **typed commands**: one `#[tauri::command]` per operation, serde
structs in and out, one error type, and TypeScript bindings generated from the Rust
(`src/kernel/bridge/bindings.ts`). There is no string dispatcher: a name the host does not register
is a hard error. Inside the host, most module functions still build their answers as JSON and fail
with a coded string; the commands convert both (see "The compatibility layer").

```
src-tauri/src/
  main.rs       argv, the plugins, the protocols, setup, window events, the menu (macOS), OS opens
  lib.rs        Source, Root, the pickers' types, the persistent log
  commands.rs   every command, its argument and answer types
  bindings.rs   the tauri-specta builder: registers the commands, writes bindings.ts
  error.rs      HostError: { code, message }
  windows.rs    Host and Win (per-window state), the window builder, geometry, `route` for opens
  outside.rs    files outside the vault: `abs:` paths, registration, their folders' watches
  encoding.rs   detect, decode and encode text that is not UTF-8
  args.rs       the flags and the positional paths
  protocol.rs   the `vault` origin: ranges, outside media
  legacy.rs     the one-time rescue of the old `app` origin's page store
  vault.rs      paths, listings, the tree, the search, copyPath, the root resolution, the hash,
                write_atomic, NFC
  hide.rs       the one hide rule: excluded, hidden, shown; link kinds; the walker
  files.rs      readFile, saveFile, createNew, createNewBinary, copyFile, importOutside,
                appendLine, replaceLine
  trashbin.rs   trash, trashWhere, trashList, trashRestore
  drafts.rs     unsaved buffers, per machine, outside the vault
  local.rs      the per-machine store: localGet, localSet, the window and the theme mirror
  watcher.rs    notify-debouncer-full on a root, one `fs` event per burst, to its own window
  versions.rs   .ose/history, tiered
  print.rs      the PDF and the system print dialog
  state.rs  vaults.rs  platform.rs      state.json, the recent vaults, open/reveal and the stamp
```

## Commands

Each command's JS name is the camelCase of its Rust name (`read_file` is `readFile`), which is the
name the page has always called. Arguments are positional. The generated function answers
`{ status: 'ok', data }` or `{ status: 'error', error: HostError }`; the kernel's adapter
(`src/kernel/bridge/tauri.js`) unwraps it, and it is the only file that imports the bindings.

The conventions:

- **Windows.** Every command finds its window's state from the window that invoked it. Each window
  has its own vault, its own epoch, its own outside files.
- **Epoch.** Every mutating command's options carry `epoch?`. One naming another epoch than this
  window's does nothing and fails with `stale_vault`.
- **Paths.** A path is a vault path. The commands marked **A** below also take `abs:` for a file
  outside the vault that this window opened (`outsideOpen`); on any other command `abs:` is
  `escapes_vault`, and an unregistered one is `not_registered`.
- **Optional arguments** may be left out. An optional field of an options object is `field?: T`.
- **Blocking work.** `tree`, `search`, `copyPath` and the four trash commands run on a blocking
  worker.
- **The log.** Every failure goes to the log as `cmd <name> failed: <code> <message>`; `--log`
  also traces every command's name.

| Command | Arguments | Answer |
|---|---|---|
| `rootInfo` | — | `{ root, name, epoch }` (nulls with no vault) |
| `vaultInfo` | — | `{ root, name, remembered, source, epoch }`; `source` is `arg`, `exe`, `env`, `remembered`, `picked`, `opened` or null |
| `pickVault` | `opts?: { adopt? }` | `{ root, name, epoch? }` or null (cancelled; also when the choice is open in another window, which is focused). `adopt: false` only chooses |
| `openVault` | `path` | `{ status: 'adopted', root, name, epoch }` or `{ status: 'focused', label }` |
| `openVaultWindow` | `path?` | `{ label, created }`: the vault's window, focused, or a new one; no path is a new window with no vault |
| `recentVaults` | — | `[{ path, name, exists, current }]`, newest first, at most ten |
| `forgetVault` | `path?` | null: with a path, drops that recent entry; without, forgets the remembered root |
| `platform` | — | `{ os, version, exe, exeDir, root, logPath, build, dragIcon }` |
| `quit` | — | null: every window closes through its own save path |
| `log` | `text, level?` | null |
| `tree` | `opts?: { hidden? }` | the root `Entry` |
| `list` | `path, opts?: { hidden? }` | `Entry[]` |
| `stat` **A** | `path, opts?: { sniff? }` | `{ exists, kind, mtime, size, hidden, link?, text?, encoding? }` |
| `exists` **A** | `path` | boolean |
| `search` | `query, opts?: { limit?, chan?, hidden? }` | `{ hits, files, total, capped, stale }` |
| `readText` **A** | `path` | the file as UTF-8, or `not_utf8` |
| `readFile` **A** | `path, opts?: { encoding? }` | `{ text, hash, mtime, size, encoding, bom, lossy }` |
| `saveFile` **A** | `path, text, opts: { expectedHash, version?, encoding?, epoch? }` | `{ status: 'saved', hash, mtime, unchanged? }` or `{ status: 'conflict', disk: { exists, text, hash } }` |
| `createNew` | `path, text?, opts?` | `{ path, hash }` |
| `createNewBinary` | `path, data (base64), opts?` | `{ path, hash }` |
| `copyFile` | `from, to, opts?` | `{ path, hash }` |
| `importOutside` | `from (abs:), to, opts?` | `{ path, hash }` |
| `appendLine` | `path, line, opts?` | `{ hash }` |
| `replaceLine` | `path, index, expected, next, opts?` | `{ status: 'replaced', hash }` or `{ status: 'conflict', actual }` |
| `writeText` / `appendText` | `path, text, opts?` | null |
| `writeBinary` | `path, data, opts?` | null |
| `readBinary` **A** | `path` | base64 |
| `mkdir` | `path, opts?` | null |
| `rename` | `from, to, opts?` | null |
| `copyPath` | `from, to, opts?` | `{ path, files, leftOut? }` |
| `trash` | `path, opts?: { mode?, epoch? }` | `{ id, where }` |
| `trashWhere` | `path, opts?: { mode? }` | `{ where }` |
| `trashList` | — | `TrashItem[]` |
| `trashRestore` | `ids, opts?` | `{ restored: {id, path}[], failed: {id, error}[] }` |
| `draftWrite` **A** | `path, draft, opts?` | `{ at }` |
| `draftList` | — | `DraftInfo[]`, this window's vault's and every outside file's |
| `draftRead` **A** | `path` | `Draft` or null |
| `draftDrop` **A** | `path, opts?: { ifRev?, epoch? }` | `{ dropped }` |
| `versionKeep` | `path, text, opts?: { force?, reason?, epoch? }` | `{ kept, id }` |
| `versionList` | `path` | `[{ id, at, bytes, reason, session }]` |
| `versionRead` | `path, id` | the text, or null |
| `versionRestore` | `path, id, opts?` | `{ kept, id, hash }` |
| `getState` / `setState` | — / `state, opts?` | the vault's `.ose/state.json` |
| `localGet` / `localSet` | `scope` / `scope, value, opts?` | the per-machine store |
| `openExternal` | `url` | null |
| `openPath` **A** / `reveal` **A** | `path` | null |
| `printToPdf` | `path \| null, opts?: { name?, folder? }` | `{ path, bytes }` or `{ cancelled: true }` |
| `showPrintUI` | — | `{ shown: true }` |
| `outsideOpen` | `path` (native absolute or `abs:`) | `{ path, inside, name, exists, kind }` |
| `takeOpens` | — | `OpenRequest[]` |
| `pickFile` | `opts?: { title? }` | a native absolute path, or null |

The legacy boolean third argument of `versionKeep` is gone: it takes an options object. The version
commands on an `abs:` path are `unsupported`: an outside file keeps no versions. A draft of an
outside file needs no registration (it is this machine's memory of what was typed, and the recovery
sheet lists it before the file is open again); it is filed under the vault key `outside`.

`showPrintUI`'s Rust name is `show_print_u_i`, so that its camelCase is the name the page calls.

### The bindings

`bindings.rs` holds the one list of commands. `builder().invoke_handler()` registers them with
Tauri, and `builder().export(…)` writes the TypeScript, so a command cannot be registered and missing
from the bindings. Integers are `number` (sizes, times in milliseconds, counters: far below 2^53).
Types whose serialised and deserialised shapes differ (an optional field the host leaves out) are
exported in both phases, `Entry_Serialize` and `Entry_Deserialize`, with `Entry` their union. Any
JSON the page keeps (`getState`, `localGet`) is `Json`, which is `unknown`.

The file is generated, never edited. `bindings_are_current` renders it and compares, so CI fails
when a command changed and the file did not:

```
cd src-tauri
OSE_WRITE_BINDINGS=1 cargo test bindings     # writes src/kernel/bridge/bindings.ts
```

The crates are betas (tauri-specta 2.0.0-rc.25, specta 2.0.0-rc.25, specta-typescript 0.0.12),
pinned with `=`. In this beta `serde_json::Value` recurses without end when exported, which is why
the page's JSON travels in the `Json` newtype.

### The compatibility layer

The command signatures are typed, and so are the bindings. The module functions behind most of
them are not yet: `files.rs`, `drafts.rs`, `versions.rs`, `trashbin.rs`, `vault.rs` (`stat`,
`search`, `copyPath`) and `vaults.rs` still return `Result<Value, String>`, build their answers with
`json!`, and fail with a `[code] message` string. Each command reads the answer into its struct with
`typed()` in commands.rs and the error into `HostError` (`From<String>` parses the code back out).
A shape that does not fit is an `io` failure of that command, `the host built an answer it cannot
read`.

So the compiler does not check those shapes; a test does. `every_module_answer_that_goes_through_typed_fits`
runs every module function that comes through `typed()` (each branch of `saveFile` and
`replaceLine`, the creates and copies, `appendLine`, the four draft commands, the three version
commands, the vault trash and `recentVaults`' rows) against the struct its command answers, over
real files. The e2e suite runs over the dev bridge, so this test is the one place the exe's answers
are checked. `draftList` reads its rows one by one: a draft file that does not fit is left out and
logged (`draft left out of the list, it does not fit: …`), rather than failing the whole recovery
list. Moving the modules to the structs and `HostError`, and deleting `typed()`, is later work.

### Events

Emitted to their own window only (`emit_to` a webview window's label), and exported as types:

- `fs`: `FsEvent { changes: FsChange[], lost?, rescan? }` (see "The watcher"); an `abs:` path for an
  outside file of that window;
- `open`: `OpenEvent { requests: OpenRequest[] }` (see "OS opens").

The `vault` event of wave 2 (a second launch naming another folder, asked of the page) is no longer
sent: that launch opens the folder's own window.

## Errors

Every refusal is `HostError`, `{ code, message }` on the wire:

`not_found`, `exists`, `not_utf8`, `unencodable`, `lossy`, `stale_vault`, `no_vault`,
`write_failed`, `bad_arg`, `bad_name`, `escapes_vault`, `not_registered`, `unsupported`, `io`.

The module functions under the commands still answer `Result<_, String>` with a `[code] message`
prefix; `HostError::from(String)` reads the code back out, and an unknown code or none is `io`.
`unknown_command` is the kernel's own: its answer to a name the bindings do not have, or to Tauri's
"command not found". An argument serde cannot read is Tauri's "invalid args" string, which the
kernel maps to `bad_arg`.

## Windows

One window per vault (D14). `Host` holds the windows by label; `Win` is one window: its root, its
epoch, its watcher, its outside files, the opens queued for it, when it last had the focus, and
its last normal geometry.

1. At most one window per vault root, compared as the filesystem compares (case-insensitively on
   Windows). A window may have no vault: it shows the chooser.
2. Labels are `main`, then `w2`, `w3` and so on. `windows::build` makes every window: native
   decorations (X9), 1280 by 800, at least 480 by 360, invisible until its page has loaded (and
   shown after two seconds whatever happens), no zoom hotkeys, and Tauri's drag-drop handler off,
   because in WebView2 it turns off HTML5 drag and drop, which the tree's drag-to-move needs. On
   macOS the title bar is `Visible`. `tauri.conf.json` declares no window.
3. **Geometry.** `main` keeps its bounds in `local/app.json` `window`; any other window in its
   vault's local store, under the same host-owned key. A window with nothing saved opens 32 px
   down and right of the window focused last. Saved bounds are used only when they still land on
   a monitor that exists.
4. **The theme.** The mirror of the last resolved theme is global; a system theme change repaints
   every window's native background.
5. **Closing.** A window closes through its own save path (the adapter's `closing` handshake).
   `ExitRequested` is held while any window exists and turned into a close of every window; `quit`
   and the macOS menu's Quit do the same. A window that is gone is forgotten, its watchers stopped.
6. **Change vault in place.** `openVault` (and `pickVault`) adopt the folder in the window that
   asked, the epoch one more, unless another window has it open: that one is focused and the
   answer says `focused`.

## OS opens

A file or a folder can come from four places:

- the first launch's positional arguments (`--root` stays the vault flag). On Windows "Open with →
  ose.exe" hands the file over this way;
- a second launch's arguments, resolved against its own folder;
- `RunEvent::Opened` on macOS (Finder, the Dock), file URLs turned into paths. It can arrive before
  `setup`: it then waits in `Host`, and `setup` routes it once the first window exists;
- "Open file…" (`pickFile`, then `outsideOpen` in the window that asked, never routed).

`windows::route(P, windows)` is a pure function, tested on every platform:

1. `P` is a folder: the window whose root is `P`. Inside some window's vault, that window, as a
   folder route (`kind: 'dir'`, the path relative to the root), never a second window nested in the
   first. Inside a vault with no window (the nearest `.ose/` at or above `P`), a new window on that
   vault, showing the folder. Otherwise a new window on `P`.
2. `P` is a file inside some window's vault: that window, with the vault path (the deepest root
   that holds it).
3. `P` is a file whose nearest ancestor `A` holds `.ose/`: the window of `A`, made when there is
   none, with the path relative to `A`. Only `.ose`, never `CLAUDE.md`: a code repository is not a
   vault. A filesystem root (`D:\`, `/`) is never taken for a vault, whatever it holds.
4. Anything else: the window focused last (or a new one, with the normal root resolution, when
   there is none), with `abs:<P>` as an outside file, registered there.

On the first launch, when no `--root` is given, the first path chooses the first window's vault if
it is a folder or a file of a vault (rule 1 or 3): for a folder, the vault it belongs to (the nearest
`.ose/` at or above it), else the folder itself. Every path is then routed.

**Path identity** (M49) has one answer, `vaults::fold` and `vaults::same`: forward slashes and no
trailing slash; on Windows without case; on macOS without case and in NFC, since APFS and HFS+ ignore
both (Finder hands over NFD, a typed path is NFC); elsewhere as written. `Host::window_of_root` (at
most one window per vault), `route`, the recent list and the outside registrations all use it. A
path relative to a root (`vaults::relative`) is compared by whole segments after the fold and keeps
the file's own spelling below the root, NFC on macOS; it never counts characters, which would be
wrong when an NFD and an NFC spelling differ in length.

**Delivery.** A window that is booting queues its requests; the page takes them with `takeOpens`
after it has restored its session, and from then on an open is the `open` event. The window is
brought forward (unminimised, shown, focused). A second launch with `--root <dir>` and no path is
rule 1; with nothing at all, the window focused last comes forward.

```ts
type OpenRequest = { path: string /* vault path or abs: */, outside: boolean, kind: 'file'|'dir', line?: number }
```

Ose writes no registry key. `bundle.fileAssociations` (`.md` and `.markdown` as "Markdown
document", Editor, default; `.txt` as "Plain text", Editor, alternate) reaches only the macOS
bundle's Info.plist; Windows ships unbundled, and "Open with" is argv.

## Files outside the vault

A file opened from the OS or with "Open file…" that belongs to no vault opens in a tab of its own.
The page names it `abs:` and the absolute path with forward slashes, the drive letter in capitals,
no `\\?\` prefix, NFC on macOS: `abs:D:/Notes/todo.md`, `abs:/Users/h/Notes/a.md`.

`outsideOpen(path)` registers the file for the window that asked, for the window's life. Inside that
window's vault it answers the vault path with `inside: true` and registers nothing. A folder is
`bad_arg`. Registration allows:

- reads and saves of that file, through the commands marked **A**. `saveFile` on it keeps no
  version, and does not recreate a folder that is gone (`not_found`);
- read-only media under its folder, recursively, through the `vault` origin at
  `/~abs/<percent-encoded absolute path>`, so the images of an outside note show;
- a watch of its folder, not recursive, whose changes to a registered file go to that window as
  `fs` changes with the `abs:` path: `modify` while the file is there, `delete` when it is not (a
  rename arrives as a delete).

Refused on them: versions (`unsupported`), and rename, move, trash, copy, links and attachments,
which take vault paths only (`escapes_vault`). `importOutside(from, to)` copies a registered file's
bytes into a new vault file, create-only.

## Text in any encoding

A file that is not UTF-8 is detected, decoded, and saved back in its own encoding (M52). Nothing is
converted without being asked. Detection is conservative:

1. valid UTF-8, with or without a byte-order mark, is UTF-8;
2. a UTF-16 byte-order mark is UTF-16LE or UTF-16BE;
3. a UTF-8 byte-order mark is UTF-8, whatever follows it;
4. mostly UTF-8 is UTF-8: at least one well-formed multibyte character and no more malformed
   sequences than those, a character cut short at the very end not counted. A UTF-8 note with one
   stray byte or a truncated tail is damaged UTF-8, and opens read-only as `lossy`; it is never
   editable windows-1252 mojibake, whose next accented keystroke would mix two encodings;
5. anything else is what `chardetng` guesses, decoded with `encoding_rs`.

`readFile` answers `encoding` (the Encoding Standard's name: `UTF-8`, `UTF-16LE`, `UTF-16BE`,
`windows-1252`, `Shift_JIS`, …; each is also a label the host accepts), `bom`, and `lossy`. The
byte-order mark stays inside the text as U+FEFF for every encoding, as UTF-8's always has, so an
untouched file round-trips byte for byte by construction. `lossy` is true when the text does not
encode back to the same bytes (a malformed sequence, or a byte the encoding cannot map back): the
page opens it read-only. `readFile(path, { encoding })` forces a decoding; one that meets a
malformed sequence is `not_utf8`.

`saveFile(…, { encoding })` encodes back (UTF-8 when absent). A character the encoding cannot hold
is `unencodable`, and nothing is written. A save in a non-UTF-8 encoding over a file whose bytes do
not read back exactly in it is `lossy`, and nothing is written. A save as UTF-8 over bytes that are
not valid UTF-8 is `lossy` too, unless it says `convert: true`: converting a file is always an
explicit command (`page.save-utf8` is the one that sets it), never what a caller that forgot
`encoding` gets. A new file, or a UTF-8 one, needs no flag. UTF-16 is encoded by the host:
`encoding_rs` has no UTF-16 encoder. A conflict's `disk.text` is decoded in the save's encoding.

`stat(path, { sniff: true })` says `text: true` for UTF-8 as before (no NUL, valid, a character cut
by the 8 KB edge allowed), for damaged UTF-8 by rules 3 and 4 (answered as UTF-8), for a UTF-16
mark, or for a guess whose decode round-trips and holds no control character but tab, line breaks,
form feed and escape; `encoding` says which.

`readText` stays UTF-8 only.

## Layout

The standard layout (X4). `frontendDist` is `../dist`: the shell copied verbatim from `shell/`, and
the four library bundles with their stylesheets under `dist/ose/`. `devUrl` is
`http://127.0.0.1:5173`. The window opens `index.html` from Tauri's own asset protocol, with the CSP
of `tauri.conf.json`; the import map is a static script in `shell/index.html`, which Tauri hashes
into `script-src` at build time. The `vault` origin stays: Tauri's asset protocol would lose the
hide rule and the confinement.

The policy (`connect-src` carries `'self'`: the shell fetches its own `keys.json`):

```json
{ "default-src": "'self'", "script-src": "'self'", "style-src": "'self' 'unsafe-inline'",
  "img-src": "'self' vault: http://vault.localhost data: blob:",
  "font-src": "'self' data:",
  "media-src": "'self' vault: http://vault.localhost blob:",
  "connect-src": "'self' ipc: http://ipc.localhost vault: http://vault.localhost",
  "worker-src": "'self' blob:",
  "frame-src": "vault: http://vault.localhost",
  "object-src": "'none'", "base-uri": "'none'", "form-action": "'none'" }
```

In dev (`npm run tauri dev`, a binary built without Tauri's `custom-protocol` feature) the window
loads `devUrl`, the Vite dev server, with the dev bridge off; that is the live loop for the shell.
A production binary is built by the Tauri CLI (`npm run tauri:build`), which turns that feature
on; a bare `cargo build` is a dev binary that looks for the dev server. `build.rs` names `dist/`
for cargo, which does not see a change of the embedded files by itself.

The wave-2 layout is gone with its pieces: the `ose` and `app` origins, the index rewrite, the
host-built CSP and import map, `load_window` and `--shell` (shell.rs). The `app` scheme is registered
again only for the one hidden window of "The old origin", and serves nothing else.

## The vault origin

`vault` serves each window its own vault read-only (the handler is told which webview asked), so an
`<img src>` or a PDF frame can point at a file in the tree. Tauri maps it to
`http://vault.localhost/…` on Windows and `vault://localhost/…` elsewhere.

- It answers `application/pdf` for a `.pdf`, which is what lets the web view's viewer draw it.
  Every answer carries `X-Content-Type-Options: nosniff`, and a file that could run script as a
  document (`.html`, `.htm`, `.xhtml`, `.svg`, `.xml`, `.xsl`) also carries
  `Content-Security-Policy: sandbox`.
- **Ranges.** `Range: bytes=a-b`, `bytes=a-` and `bytes=-n` are answered with a 206,
  `Content-Range` and only that slice, read with a seek, so a video seeks. No answer carries more
  than 4 MB: an open range (`bytes=0-` is how Chromium's media and PDF readers start, and
  `bytes=N-` is every seek) or a wide one is answered with its first 4 MB, a shorter 206 that
  HTTP allows, and the reader asks again for the rest. A range that starts past the end is a 416
  with `Content-Range: bytes */<length>`. A GET with no range, or with several ranges or another
  unit, gets the whole file up to 64 MB, and past that the first 4 MB as a 206. Every answer says
  `Accept-Ranges: bytes`. `HEAD` answers the headers alone.
- **Off the UI thread.** The handler is registered as asynchronous and reads on a blocking
  worker. The synchronous form is answered inside WebView2's request callback, on the UI thread,
  where one big read froze every window and the IPC with it.
- **Outside media.** `/~abs/<percent-encoded absolute path>` serves a file under the folder of an
  outside file the window opened; anything else under `/~abs/` is a 404.

## Flags

```
--root <path>     the vault, when it is a folder that exists
--log <file>      also append the host and UI lines to this file, with every command's name
--version         print `ose <version> (<short sha>, <date>)`, or `(dev build)` locally, and exit
<path>…           files and folders to open (see "OS opens")
```

An unknown flag is ignored in silence, so an old shortcut still starts the app. The retired
`--shell <dir>` swallows its folder and says so in the log, so it is never taken for a vault. A path that is not
there is dropped with a log line when it is routed.

## The vault root

For the first window, in order, the first that answers:

1. `--root <path>`, when it is a directory;
2. the first path of the launch, when it is a folder or a file of a vault (see "OS opens");
3. the nearest ancestor of the executable that looks like a vault (it holds `.ose/` or a
   `CLAUDE.md` and does not hold `src-tauri/`), the executable's own folder first, never a
   filesystem root (a stray `.ose` at the top of a drive must not turn the disk into a vault);
4. `OSE_ROOT`;
5. the remembered root, one line in `<app config dir>/vault`;
6. nothing: the host logs `no vault: the shell will ask for a folder`, and `pickVault` opens the
   native dialog when the page asks.

A window made later with no vault named (rule 4 of "OS opens" with no window) takes steps 3 to 5,
skipping a vault already open in another window. Whatever is opened goes to the top of the recent
list.

## Single instance

A second launch hands its argv and its folder to the copy that holds the lock and exits inside
`builder.build()`, before a line of the second process runs; the running copy routes what it was
given (see "OS opens"). The lock is probed before the plugin is installed and the handover is said
out loud in the log, because a copy holding the lock can be a ghost and "the app does not start and
the log says nothing" is the one case a person cannot diagnose. When testing a build, check first
that no other `ose.exe` runs: a launch handed to someone's running copy opens a window inside their
process.

## The watcher

`notify` on a window's vault root, recursive, through `notify-debouncer-full` (H9): about 150 ms of
quiet per path, what happened to a path in that time merged into one change, and the two halves of
a rename paired by the file's id on Windows and macOS (by the kernel's cookie on Linux), so a rename
made in Explorer or Finder arrives as one rename. The id cache walks the vault under the one hide
rule, never through a link and never inside `.git` or `.ose`. What the debouncer lets go within
50 ms goes out as one `fs` event, to that window only:

```
{ changes: [{ path, kind: 'create'|'modify'|'delete'|'rename', to?, dir?, hidden? }], lost?, rescan? }
```

The kind is decided at flush time from the debounced event plus whether the path still exists.
`dir: true` marks a folder that is still there; `hidden: true` a dotfile, anything inside a
dotfolder, or a file with the system's hidden flag (M16). Excluded paths are never reported. An
atomic save is the page's `modify`. A move into the vault's `.trash` or out of it is a `delete` and
a `create`. A flood is flushed rather than accumulated. `lost` says the vault folder itself went
away (and `lost: false` that it came back).

`rescan: true` says "you may have missed events: re-read what you show": when the backend flags an
event with Rescan, when the Windows backend gives up on `ReadDirectoryChangesW` (notify only writes
a `log::error!`, which `lib.rs`'s log hook counts; every running watcher sees the count move and
restarts, since the record does not say which watch died), when the debouncer reports an error, and
once after every restart that followed one.

A rename the watcher paired moves the file's history and drafts with it, but only when it is a real
move (`from` gone, `to` there).

## Paths

A vault path is forward slashes, relative, no leading slash; on Windows a backslash is a separator
too. It is taken literally: nothing is trimmed and nothing is redirected. A `..` segment is
`escapes_vault`, and on Windows a segment the system would silently read as another name, one
ending in a dot or a space, or a device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`,
`LPT1`-`LPT9`, with any extension), is `bad_name`. A drive letter or a NUL in a segment is
`escapes_vault`, and so is an `abs:` path given to a command that takes vault paths only.

**NFC on macOS (M49).** Every name and path the host sends out (`list`, `tree`, `search`, the watcher,
`trashList`, outside opens, `abs:` paths) is in Normalization Form C on macOS: APFS hands back the
NFD a Finder rename wrote, while a link typed on the keyboard is NFC, and the two would never
compare equal. Paths coming in are used as given, since APFS lookups ignore normalisation. Windows
is untouched. (`vault::to_nfc` is the pure half, tested on every platform.)

`rename` never replaces (M50): `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` on Windows,
`renamex_np(RENAME_EXCL)` on macOS. A case-only rename of one file goes through a temporary name.

## What is listed

One rule, `hide.rs`, answers for every path: **excluded**, **hidden** or **shown** (H16, D7). It
takes the vault root per call (the app's own entry at the root of each vault is worked out once and
kept), so several windows on several vaults each get their own. `list`, `tree`, `search` and the
watcher all ask it, and the dev bridge has one port of it (`dev/files.mjs`).

- **Excluded**, never listed, walked, searched or reported: any segment named `.ose` or `.git`, in
  any case; the vault bin's sidecars, `.trash/.info` at the root; at the vault root only, the
  running executable's own entry when it sits there, and `ose.exe`, `ose.pdb`, `ose.exe.new`,
  `ose.exe.old`, `Ose.app`, `Ose.app.old`, `ose-update.zip`, `ose-update-tmp`,
  `WebView2Loader.dll` and their pre-1.0 `os.*` twins; anywhere, a temp file of the atomic writer
  (`.<name>.<pid>.<n>.tmp`) or of a case-only rename (`.<name>.<pid>.case`), an Office owner file
  (`~$…`) and a LibreOffice lock (`.~lock.…#`).
- **Hidden**, listed only with `{ hidden: true }`: a name starting with a dot, or the system's hidden
  flag.
- **Shown**: everything else.

`tree` and `search` walk with the `ignore` crate, its own filters all off, at most 24 folders deep,
never into a link.

```ts
type Entry = {
  name: string, path: string, kind: 'dir'|'file', ext: string, mtime: number, size: number,
  hidden: boolean,
  link?: 'file'|'dir'|'broken'|'loop'|'outside',  // only on a symlink or a junction
  readable?: false,                                // a folder the host could not open
  children?: Entry[],                              // `tree` only; never under a link
}
```

`search`: every term must appear in the file or its path; `path:` and `file:` filter; `limit`
counts files, 0 is no cap; `chan` lets a newer query cancel an older one on the same channel. A
link's content is never read, and the vault bin is never searched.

## Copying

`copyPath(from, to)` → `{ path, files, leftOut? }`: a file or a whole folder, byte for byte,
create-only; links copied as links (a folder symlink the system will not let the process create
becomes a junction on Windows); a file symlink that cannot be made is left out and named in
`leftOut`; a folder cannot be copied into itself; a folder copy that fails half-way removes what it
made.

`createNewBinary(path, base64)` → `{ path, hash }`: bytes into a new file, decoded before anything is
created, opened exclusively, written and synced in one call; a write that fails removes the file it
made, so a failed import never leaves an empty file behind.

## Trash

Nothing is ever deleted outright. `trash(path, { mode })` → `{ id, where }`: `mode: 'vault'` to
`.trash` inside the vault (with a sidecar in `.trash/.info` recording the original path and the
time), otherwise the system's bin, and `.trash` when the volume has none. `id` is null for the macOS
Trash, which an app cannot read back.

- `trashWhere(path, { mode? })` → `{ where }`: where `trash` would put it, with `mode` when given and
  the vault's setting otherwise, so a confirmation can name the real destination.
- `trashList()` → `TrashItem[]`, newest first: `.trash`, plus the system bin's items from this vault
  on Windows and Linux.
- `trashRestore(ids)` → `{ restored, failed }`; a taken place is `exists`, never overwritten.

```ts
type TrashItem = { id: string, name: string, original: string, deletedAt: number,
                   kind: 'dir'|'file', size: number, where: 'system'|'vault', known?: false }
```

## Local state

What belongs to this machine and not to the vault is kept outside it and never synced:

- `<app config dir>/local/app.json`: this machine, every vault (`localGet('app')`);
- `<app config dir>/local/vaults/<vaultKey>.json`: this machine, one vault (`localGet('vault')`).

`localSet` replaces the whole object, at most 1 MB. The host's own keys are never shown to the page
and never overwritten by it: `window`, `theme` and `legacyOrigin` in `app.json`, and `window` in a
vault's object (the geometry of a window other than `main`). An unset theme is the system's: no
window's theme is forced at startup.

## The old origin

Up to wave 2 the page was served from the `app` origin (`http://app.localhost` on Windows,
`app://localhost` elsewhere); it is now Tauri's own (`http://tauri.localhost`). `localStorage`
belongs to an origin, so two keys the old page kept there would be lost with the upgrade:
`os.journal.draft`, the unsent composer text of the 1.0.0 journal plugin that the planner's
`recoverOldDraft` rescues, and `os.theme`, the theme the person chose.

On the first launch after the upgrade, once per machine, the host opens a hidden window on the old
origin (legacy.rs). The `app` scheme serves that window only: a page and a script that read the two
keys and post them back to the same origin, no IPC. The host keeps what came back in `app.json`
under `legacyOrigin` (`{tried, done, values?, error?, applied?}`), then writes each value into the
new origin's `localStorage` where that key is still empty, by evaluating one line in a window whose
page has loaded, and marks it `applied`. Nothing already set under the new origin is overwritten.
`tried` is written before the window opens, so the attempt is made once and never again; the hidden
window closes when the answer comes and after ten seconds in any case. The log says what happened
(`old origin: …`), and the rescued text stays in `app.json` for as long as that key is there.

## Epoch

Each window holds an epoch: 1 when it is made, one more on every vault it adopts. `rootInfo` and
`vaultInfo` answer it. A mutating command naming another epoch than its window's does nothing and
fails with `stale_vault`. A caller that names none (a read) is let through. An `abs:` path is not a
vault's and is not checked against the epoch.

## The hash

FNV-1a, 64 bits, over the file's raw bytes, as 16 lowercase hex digits: `""` is `cbf29ce484222325`,
`"a"` is `af63dc4c8601ec8c`. A fingerprint, not a defence; the page carries what `readFile` and
`saveFile` answered and compares by equality.

## Writes

Every file the host writes goes through `vault::write_atomic` (C3): a temp file beside the target,
synced; a rename onto the target, retried with backoff for about two seconds when a scanner or a
sync client holds it; bytes that reached the disk are never deleted (a rename that still fails sets
them aside as `<stem>.unsaved-<stamp>.<ext>` and says where); the folder fsynced on unix.

## Files

- **`readFile`** and **`saveFile`**: see "Text in any encoding" for `encoding`. `saveFile` compares
  and writes in one call under a process-wide lock per path (M2). `expectedHash` is required:
  `null` means the file must not exist, a string that the disk must still hold those bytes. When
  the disk already holds the text the answer is `saved` with `unchanged: true`. On a mismatch
  nothing is written and the disk is answered. Right before the rename the target is read once
  more: an outside write made meanwhile wins, as a conflict. The replaced bytes become a version
  (`version: 'save'` tiered, `'conflict'` forced, `'none'`), except on an outside file. Every
  outcome goes to the log.
- **`createNew(path, text?)`**, **`copyFile(from, to)`**: exclusive creates; `exists` in any case the
  filesystem folds; `bad_name` for a name the filesystem would refuse.
- **`appendLine(path, line)`**: one line, with the file's own line ending, the file and its folders
  made when missing. A file that is not UTF-8 (UTF-16, windows-1252, damaged) is `not_utf8` and
  left as it was, as with `replaceLine`: the line is UTF-8 and would break or mix it.
- **`replaceLine(path, index, expected, next)`**: line `index` becomes `next` only while it still
  reads `expected`; its separator and every other byte stay. A byte-order mark is not part of
  line 0: it is compared without it and kept in the output.

## Drafts

The buffer of a page that could not be written (C4, D5), kept per machine at
`<app local data>/drafts/<vaultKey>/<pathKey>.json`, outside every vault. An outside file's draft is
filed under `drafts/outside/`, keyed by its `abs:` path. A draft holds `path`, `text`,
`baselineHash`, `mode` (`rich`, `live` or `source`), `exact`, `rev` and `at` (set by the host).
`draftList` answers this window's vault's drafts and every outside file's, without their text, newest
first. `draftDrop(path, { ifRev })` drops only a draft at that edit or before it. A rename moves the
drafts with the file.

## Versions

`.ose/history/<vault path>/<id>.<reason>[-s].<ext>`, tiered (H10, D10): under an hour every version,
then the newest of each hour for a day, of each day for thirty days, then the file's newest only;
a session's first version and every non-`save` one stay thirty days; the whole history under
200 MB. A non-forced keep is at most one per file per minute; identical bytes are never kept twice.
A rename moves a file's history; a trash leaves it.

## The log

Every build writes `<app log dir>/ose.log` (M54), rotated at 2 MB with three files kept;
`platform().logPath` says where. The `log` crate's warnings and errors go there too. `--log <file>`
adds every command's name. The page writes with `log(text, level)`.

## Browser keys

WebView2's browser accelerator keys are off in every window (`AreBrowserAcceleratorKeysEnabled =
false`, M53): F5 and Ctrl+R would reload the page under unsaved work.

## Drag out

`tauri-plugin-drag` is registered (capability `drag:default`), and the page starts a native drag of
files with it (`startDrag({ item, icon, mode: 'copy' })`). On Windows the plugin calls
`DoDragDrop` with `DROPEFFECT_COPY` as the only allowed effect, so a drop onto Explorer copies,
even on the same volume, and the vault file stays. `platform().dragIcon` is a PNG of the app's
icon that the host writes once into the app's data folder, for the drag image. Drag in is the
page's own HTML5 drop (X8); nothing of it reaches the host but `createNewBinary`.

## Print

`printToPdf` and `showPrintUI`, in the window that asked. On Windows both are WebView2's own
(`ICoreWebView2_7::PrintToPdf`, `ICoreWebView2_16::ShowPrintUI`), A4 portrait, margins of zero (the
stylesheet's `@page` governs), backgrounds off (with them on, WebView2 paints the page box with the
theme's background). With no `path`, `printToPdf` asks where through the native save dialog and
answers `{ cancelled: true }` on cancel. On macOS `printToPdf` is `unsupported` and `showPrintUI`
opens the system dialog, whose PDF menu saves the page. Nothing calls `window.print()`, which does
not return in WebView2.

## The dev bridge

`dev/bridge-plugin.mjs`, with `dev/files.mjs`, is the same surface in Node for the browser dev
server: the same command names over `POST /__bridge/<name> {"args": [...]}`, the same answers, errors
as `[code] message`, the same hash and hide rule. Node has no system bin, so its trash always goes
to `.trash`. With `OSE_DEV_FAULTS=1` it also answers `devFault(spec)` for the no-loss suite; the exe
has no such command.

## Building

```
cd D:\ose
npm ci
npm run tauri:build                 # npm run build, then the release exe with Tauri's custom-protocol
.\src-tauri\target\release\ose.exe --version
npm run tauri dev                   # the app over the dev server, reloading as files change
```

`npm run tauri:build` resolves to `tauri build --no-bundle` on Windows (one executable, no
installer) and to `--bundles app` on macOS. `npm run ship` builds and copies `ose.exe` to the vault
root, with `WebView2Loader.dll` beside it when a local MinGW build made one.

## Signing on macOS

CI signs `Ose.app` ad hoc unless the repository has two secrets, in which case it signs with one
stable self-signed identity (M51). With a stable identity macOS recognises a new build as the same
app: "Open Anyway" is asked once, not after every update. To make it, once, on a Mac:

1. Keychain Access → Keychain Access menu → Certificate Assistant → Create a Certificate…
2. Name it `Ose Code Signing`, Identity Type **Self Signed Root**, Certificate Type **Code
   Signing**, and Create.
3. In Keychain Access, under My Certificates, right-click the new certificate → Export… → save it
   as `ose-signing.p12` with a password.
4. `base64 -i ose-signing.p12 | pbcopy`
5. On GitHub: the repository → Settings → Secrets and variables → Actions → New repository secret:
   `MACOS_CERT_P12_BASE64` with the clipboard, and `MACOS_CERT_PASSWORD` with the password.

The macOS job then imports the `.p12` into a keychain of the run's own, reads the identity's common
name and passes it to tauri as `APPLE_SIGNING_IDENTITY`. Keep the `.p12` somewhere safe: a new
certificate is a new identity, and "Open Anyway" is asked once more.

## CI

`.github/workflows/build.yml`: Windows (MSVC, one self-contained file) runs `npm ci`, `npm test`,
`npm run typecheck`, `npm run lint`, `npm run build`, the no-loss suite in Chromium, `cargo test`
(which includes `bindings_are_current`) and `cargo clippy -- -D warnings`, checks the build's
output, stamps `OSE_BUILD_SHA` / `OSE_BUILD_DATE`, runs `npm run tauri:build`, asserts the
`--version` line and uploads `ose-windows`. macOS (`macos-14`) runs the tests, clippy (reporting
only), the signing identity step, `npm run tauri:build`, the `--version` assert, `codesign
--verify`, and uploads `ose-macos-arm64.zip` packed with `ditto`. A push to `main` publishes both to
the rolling `latest` prerelease; a failed macOS build publishes Windows alone.
