# The host

The host is the Rust half of `ose.exe`: a Tauri 2 window, the vault's filesystem and its one hide
rule, the watcher, the trash, file versions, the per-machine store, the three origins the app is
drawn from, and the single-instance rule. It draws nothing and knows nothing about views. It starts
no program of its own choosing: `run` is gone with the plugins, and handing a file, a folder or
a link to the system (`openPath`, `reveal`, `openExternal`) is all that leaves the process. The JavaScript reaches it through one Tauri
command, `rpc`, whose surface is `docs/KERNEL.md`.

```
src-tauri/src/
  main.rs       argv, the window, geometry, single instance, the menu (macOS), the protocols
  lib.rs        AppState, the epoch, the `rpc` dispatch, `gone()`, the persistent log
  args.rs       the four flags
  shell.rs      the `ose` and `app` origins, the index rewrite, the CSP, load_window, reload
  protocol.rs   the `vault` origin
  vault.rs      paths, listings, the tree, the search, copyPath, the root resolution, the hash,
                write_atomic
  hide.rs       the one hide rule: excluded, hidden, shown; link kinds; the walker
  files.rs      readFile, saveFile, createNew, copyFile, appendLine, replaceLine
  trashbin.rs   trash, trashWhere, trashList, trashRestore
  drafts.rs     unsaved buffers, per machine, outside the vault
  local.rs      the per-machine store: localGet, localSet, the window and the theme mirror
  watcher.rs    notify-debouncer-full on the root, one `fs` event per burst, rescan
  versions.rs   .ose/history, tiered
  print.rs      the PDF and the system print dialog (WebView2's on Windows, WKWebView's dialog on macOS)
  state.rs  vaults.rs  platform.rs      state.json, the recent vaults, open/reveal and the stamp
```

## The three origins

Tauri maps a custom scheme to `http://<scheme>.localhost/…` on Windows and `<scheme>://localhost/…`
on macOS and Linux. `shell.rs::origin()` is the one place that knows which.

- **`ose`** serves `dist-kernel/` out of the executable: `kernel.js`, `editor.js`,
  `planner.js`, `ui.js`, `ui.css`, `editor.css`, `planner.css`. GET only, CORS open,
  `no-store`.
- **`app`** serves the app itself, the shell, and nothing from the vault. The window opens on
  `<app origin>/index.html`.
- **`vault`** serves the vault's own files read-only, so an `<img src>` or a PDF frame can point
  at a file in the tree. It answers `application/pdf` for a `.pdf`, which is what lets the web
  view's viewer draw it. Every answer carries `X-Content-Type-Options: nosniff`, and a file that
  could run script as a document (`.html`, `.htm`, `.xhtml`, `.svg`, `.xml`, `.xsl`) also carries
  `Content-Security-Policy: sandbox`: it is shown, never executed. An `<img>` of an SVG is
  unaffected, and a PDF gets no sandbox, which the viewer would refuse.

The whole contract of the `app` origin is three rules:

1. Every path is a file of the shell: `<dir>/<path>` on disk when `--shell <dir>` was given,
   otherwise the embedded `shell/<path>`, with `no-store`.
2. `/` and `/index.html` are the shell's `index.html`, and it is the only file that is rewritten:
   the import map goes in after `<head>`, `<link data-ose="ui">`, `<link data-ose="editor">` and
   `<link data-ose="planner">` get the kernel origin's `ui.css`, `editor.css` and `planner.css`,
   and the response carries the `Content-Security-Policy`.
3. A missing file, a folder and a path that escapes its folder are all the same plain-text 404. No
   listing, no redirect, no guessing.

The import map names four modules: `ose:kernel`, `ose:editor`, `ose:planner` (Day, Week, Month and
Journal, built in) and `ose:ui`, each at the kernel origin. The CSP's hash is of exactly
the map's bytes, so a module added to the map changes the hash by construction.

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

`notify` on the root, recursive, through `notify-debouncer-full` (H9): about 150 ms of quiet per
path, what happened to a path in that time merged into one change, and the two halves of a rename
paired by the file's id on Windows and macOS (by the kernel's cookie on Linux), so a rename made in
Explorer or Finder arrives as one rename. The id cache it pairs with walks the vault under the one
hide rule, never through a link and never inside `.git` or `.ose`. What the debouncer lets go
within 50 ms goes out as one `fs` event:

```
{ changes: [{ path, kind: 'create'|'modify'|'delete'|'rename', to?, dir?, hidden? }], lost?, rescan? }
```

The kind is decided at flush time from the debounced event plus whether the path still exists, so
a path reported gone is gone when the event leaves. `dir: true` marks a folder that is still there
(for a rename, the new path); `hidden: true` a dotfile, anything inside a dotfolder, or a file with
the system's hidden flag. Together they let the tree patch one row instead of reading the vault
again (M16). Excluded paths (below) are never reported: the host's own writes into `.ose` (state,
history) and the vault bin's sidecars in `.trash/.info` are never events. An atomic save is the
page's `modify`: the debouncer reports the temp file renamed onto the page as the page removed and
created (it drops the rename, since it saw the temp file created), and a path removed and created
in one batch that is a file afterwards goes out as one `modify`, as does another editor's
delete-then-write. A move into the vault's `.trash` or out of it (a trash, a
restore) is a `delete` and a `create`, never a rename that an open page, the history or the drafts
would follow. A flood is flushed rather than accumulated. `lost` says the
vault folder itself went away (and `lost: false` that it came back).

`rescan: true` (with `changes: []` or alongside them) says "you may have missed events: re-read
what you show". It is sent when the backend flags an event with Rescan, when the Windows backend
gives up on `ReadDirectoryChangesW` (a buffer overflow during a checkout: notify only writes a
`log::error!`, which `lib.rs`'s log hook turns into a watcher restart), when the debouncer reports
an error, and once after every restart that followed one.

A rename the watcher paired moves the file's history and drafts with it, exactly as a rename
through the app does, but only when it is a real move (`from` gone, `to` there): an editor that
renames a file aside and writes a new one in its place keeps its history where it was.

## Paths

A vault path is forward slashes, relative, no leading slash; on Windows a backslash is a separator
too. It is taken literally (M49): nothing is trimmed and nothing is redirected. A `..` segment is
`[escapes_vault]` rather than folded into its parent, and on Windows a segment the system would
silently read as another name, one ending in a dot or a space, or a device name (`CON`, `PRN`,
`AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, with any extension), is `[bad_name]`. A drive letter or
a NUL in a segment is `[escapes_vault]`.

`rename` never replaces (M50): the move itself is `MoveFileExW` without
`MOVEFILE_REPLACE_EXISTING` on Windows and `renamex_np(RENAME_EXCL)` on macOS, so a file that
appears at the target between the look and the move is kept. A case-only rename (`Notes.md` to
`notes.md`) of one file goes through a temporary name; on a case-sensitive volume, where the two
names can be two files, `same_file` tells them apart and a different file there is `[exists]`.
Names read from disk are not normalised to NFC on macOS in this version.

## What is listed

One rule, `hide.rs`, answers for every path: **excluded**, **hidden** or **shown** (H16, D7).
`list`, `tree`, `search` and the watcher all ask it, and the dev bridge has one port of it
(`dev/files.mjs` `classify`).

- **Excluded**, never listed, walked, searched or reported, whatever the page asks: any segment
  named `.ose` or `.git`, in any case; the vault bin's sidecars, `.trash/.info` at the root; at
  the vault root only, the running executable's own entry when it sits there (the exe under
  whatever name it has, or the `.app` bundle it runs from; never its name when it runs from
  anywhere else, so a root folder `ose` is content on a Mac) and `ose.exe`, `ose.pdb`, `ose.exe.new`, `ose.exe.old`, `Ose.app`, `Ose.app.old`,
  `ose-update.zip`, `ose-update-tmp`, `WebView2Loader.dll` and their pre-1.0 `os.*` twins;
  anywhere, a temp file of the atomic writer (`.<name>.<pid>.<n>.tmp`) or of a case-only rename
  (`.<name>.<pid>.case`), an Office owner file (`~$…`) and a LibreOffice lock (`.~lock.…#`).
- **Hidden**, listed only with `{hidden: true}`: a name starting with a dot, or the system's hidden
  flag (`FILE_ATTRIBUTE_HIDDEN` on Windows, `UF_HIDDEN` on macOS; the dev bridge asks cmd for
  Windows' flag, `dir /a:h`, since Node's stat does not carry it). Hidden is judged by the entry's own name, so the inside of a dotfolder the page asked for
  by name is listed.
- **Shown**: everything else. Nothing is hidden by name: `App`, `app`, `dist`, `node_modules` and
  `_Archive` are folders like any other, and a `.unsaved-*` copy is an ordinary visible file.

`tree` and `search` walk with the `ignore` crate, its own filters all off (`.gitignore` means
nothing to a vault), at most 24 folders deep, and never into a link.

```ts
type Entry = {
  name: string, path: string, kind: 'dir'|'file', ext: string, mtime: number, size: number,
  hidden: boolean,
  link?: 'file'|'dir'|'broken'|'loop'|'outside',  // only on a symlink or a junction
  readable?: false,                                // a folder the host could not open
  children?: Entry[],                              // `tree` only; never under a link
}
```

- **`list(path, { hidden? })`** → `Entry[]`, folders first, then natural name order (runs of digits
  as numbers, the rest by lowercased character). `[not_found]` for a path that is not a folder or
  that the rule excludes; `[escapes_vault]` for a folder reached through a link whose target is
  outside the vault.
- **`tree({ hidden? })`** → the root `Entry`, `name` the vault's, `path` `''`, with `children`.
- **`stat(path, { sniff? })`** → `{ exists, kind, mtime, size, hidden, link?, text? }`. `text`, only
  with `sniff` and only for a file, is true when the first 8 KB hold no NUL and are valid UTF-8 (a
  byte-order mark is; a character cut by the 8 KB edge does not count against the file). It is how
  the page decides that any file with no known extension opens as text (H17).
- **`search(query, { limit, chan, hidden? })`**: unchanged in shape. A link's content is never
  read, only its name matched. The vault bin, `.trash` at the root, is never searched, hidden
  items or not: a trashed page is neither a result, a backlink nor a link to rewrite on a rename.

A link is described by its target: `kind` is what it points at, `link` says what kind of link.
`outside` when the target leaves the vault; `loop` for a folder link whose target is the link's
own folder or one of its ancestors; `broken` when nothing is there.

## Copying

**`copyPath(from, to, { epoch })`** → `{ path, files, leftOut? }`: a file or a whole folder, byte
for byte, into a new `to`, the missing folders made. Create-only: anything at `to` is `[exists]`,
and every file inside is opened exclusively. A link inside is copied as the link, never followed:
a junction as a junction, a symlink as a symlink, and on Windows a folder symlink the system will
not let the process create (no Developer Mode, not elevated) as a junction to the same folder,
which needs no privilege. A file symlink that cannot be made is left out, written to the log, and
named in `leftOut` (the vault paths of the links under `from` that were not copied, present only
when there are any), so the page can say the copy is not whole; copying such a link on its own is
`[io]`. A folder cannot be copied into itself (`[bad_arg]`), compared the way the filesystem
compares: case-insensitively on Windows and macOS, and through links by real paths. A folder copy
that fails half-way removes the new folder, which this call created and which holds nothing that
is not still at `from`. `files` counts the files and links written. It runs on a blocking worker.

## Trash

Nothing is ever deleted outright (M18). `trash(path, { mode, epoch })` → `{ id, where }`:

- `mode: 'vault'` puts the path in `.trash` inside the vault, as `.trash/<stamp>-<name>`, with a
  sidecar `.trash/.info/<stamp>-<name>.json` that records the original vault path and the time.
- Otherwise it goes to the system's bin: the Recycle Bin, the macOS Trash (through
  `NSFileManager`, no Finder, no AppleScript), the freedesktop trash. When the volume has no bin
  (Windows: a removable or network drive, or one `SHQueryRecycleBinW` cannot answer for, where the
  shell would delete for good), or the system refuses, it goes to `.trash` instead, and `where`
  says `'vault'`.

`id` is what `trashRestore` takes; its format is the host's business. It is `null` for the macOS
Trash, which an app cannot read back: those items are restored from the Finder.

- **`trashWhere(path)`** → `{ where }`: where `trash` would put the path now, with the vault's
  setting (`settings.trash` in `.ose/state.json`) and the volume's bin, so a confirmation can name
  the real destination.
- **`trashList()`** → `TrashItem[]`, newest first: `.trash` everywhere, plus the items of the system
  bin whose original path is inside the open vault on Windows and Linux (`trash::os_limited`). An
  item trashed before the sidecars existed is listed with its name at the vault root and
  `known: false`, which the Trash view shows as an unknown folder (the key is absent otherwise). A Recycle
  Bin item's name is its real one, extension and all: the bin displays `page` for `page.md` when
  Explorer hides known extensions, so the host reads the name from the bin's `$I` record (or the
  `$R` file's extension). Its folder is matched against the vault root as opened and as
  canonicalised, since the bin records the real path of a vault opened through a junction or a
  subst drive.
- **`trashRestore(ids, { epoch })`** → `{ restored: {id, path}[], failed: {id, error}[] }`. Each
  item goes back to its original path, the missing folders made again. One whose place is taken
  again is `[exists]` ("A file with that name is already there") and stays in the bin: nothing is
  overwritten.

```ts
type TrashItem = { id: string, name: string, original: string, deletedAt: number,
                   kind: 'dir'|'file', size: number, where: 'system'|'vault' }
```

`.trash` is a dotfolder: hidden, not excluded, so Show hidden items shows it; its `.info` sidecars
are excluded, and the bin is never searched. History and drafts stay where they are on a trash,
and are found again on a restore.

## Local state

What belongs to this machine and not to the vault is kept outside it and never synced (W5, M26):

- `<app config dir>/local/app.json`: this machine, every vault (`localGet('app')`);
- `<app config dir>/local/vaults/<vaultKey>.json`: this machine, one vault, filed under the same key
  as its drafts (`localGet('vault')`).

**`localGet(scope)`** → the object, `{}` when there is none. **`localSet(scope, value, { epoch })`**
→ `null`: the whole object replaced, at most 1 MB serialised (`[bad_arg]` otherwise), written with
the atomic writer in its mode for a file the app owns. The vault scope needs an open vault and
honours the epoch. Two keys of `app.json` are the host's own, `window` (the bounds) and `theme` (the
last resolved theme, the first paint's colour): the page never sees them and cannot overwrite them.

The window's bounds and the theme mirror are read from there, with the vault's old `state.json` as
the fallback of the first launch after the upgrade, and written there only. An unset theme is the
system's: the window is created with `theme: None`, its first background is the mirror's colour or
the system theme's, and the host never forces the window's theme at startup, so a page that follows
the system sees the system change.

`.ose/state.json` keeps what travels with the vault: pins, the planner's paths, the vault's
settings.

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

Every file the host writes, in the vault or out of it (pages, versions, `state.json`, drafts, the
local store, the trash sidecars), goes through `vault::write_atomic` (C3):

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
merging when the target has one already. A trash leaves the history where it is. `.ose` is
excluded from every listing, so a version is never a page.

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
`<app origin>/index.html`, which reloads the page and, with `--shell`, every file of the shell
from disk. The page calls it only after it has left the window (`ose.reload()`, "Reload window");
the host does not ask again. `run`, `runKill` and every other command of the plugin era answer
`[unknown_command]`.

`pickVault({ adopt })` opens the folder dialog; with `adopt: false` the folder is only chosen and
answered as `{ root, name }`, neither adopted nor recorded, so the page can leave the old vault
first.

`dev/bridge-plugin.mjs`, with `dev/files.mjs`, is the same surface in Node for the browser dev
server: the same commands, answers, error strings, hash and hide rule, with drafts, the local store
(`local/…`) and the log under `work/dev-appdata` (or `OSE_APPDATA`; `OSE_DEV_APPDATA` is the older
name). Node has no system bin, so the dev bridge's trash always goes to `.trash` and `trashWhere`
says `'vault'`. Node's stat does not carry Windows' hidden flag either, so the bridge asks cmd
(`dir /a:h /b`, one call per listing, or one per walk, answers kept for a second).

With `OSE_DEV_FAULTS=1` the dev bridge also answers `devFault(spec)`, for the no-loss suite:
`spec` is `{ cmd, path?, code, message?, times? }`, or `null` to clear. While a spec is armed, a
call of `cmd` (on `path` when one is named, compared with the call's first argument) fails with
`[code] message`; `times` counts down, and without it the fault holds until cleared. A test arms it
with `POST /__bridge/devFault` and the body `{"args":[spec]}`, from the page or from Node. The
kernel never calls it, and the exe has no such command.

## Building

```
cd D:\ose
npm ci
npm run build                       # dist-kernel/: the bundles, the stylesheets, shell/, index.html
cd src-tauri
cargo build --release               # src-tauri/target/release/ose.exe
.\target\release\ose.exe --version
```

`npm run build` is vite over `vite.kernel.config.js`: the entries (kernel, ui, md, ui.css, editor,
planner), nothing hashed, nothing inlined, and a `closeBundle` hook that runs
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
`ose.exe --root <vault> --shell D:\ose\shell`: edit a file in `shell/`, run Reload window
(`app.reload`) from the palette, no rebuild. A change to the kernel, the editor or the planner
is a `npm run build` and a `cargo build`.

## CI

`.github/workflows/build.yml` has two build jobs. Windows is MSVC, so the result is a single
self-contained file. Checkout, node 22, rust stable with clippy, rust-cache, `npm ci`, `npm test`
(H11: a failing test stops the build), `npm run build`, `npx playwright install chromium` and
`npm run test:e2e` (the no-loss suite in Chromium over the browser dev server), `cargo test` and
`cargo clippy -- -D warnings` in `src-tauri` (a warning fails the Windows build), a check that
`dist-kernel/` holds the bundles and `shell/index.html`, the `OSE_BUILD_SHA` /
`OSE_BUILD_DATE` stamp, `npm run tauri:build`, `ose.exe` staged at the workspace root, an assert
that `ose --version` matches `^ose 1\.\d+\.\d+ \(`, and the artifact `ose-windows`. A second job
publishes to the rolling `latest` prerelease and runs only on a push to `main`; a
`workflow_dispatch` on any ref stops after the artifacts. macOS runs on `macos-14` (Apple
silicon): the same steps, without the no-loss suite and with clippy reporting only, to `npm run tauri:build`, which bundles `Ose.app`, the same `--version`
assert, and `ose-macos-arm64.zip` packed with `ditto`. The release waits for both jobs but needs
only Windows: a failed macOS build publishes Windows alone.
