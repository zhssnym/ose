# The host

The host is the Rust half of Ose, in `src-tauri/`: a Tauri 2 app that owns the windows, the
vault's files, the watcher, and everything the app keeps on this machine. The page (core, editor,
views, shell) never touches the disk itself. It asks the host through typed commands, and the
host answers with data or with one error type. The vault's own files are the only thing in the
vault: the host writes nothing else into it.

## Modules

```
src-tauri/
  tauri.conf.json   identifier, version (from ../package.json), CSP, bundle, updater endpoint and key
  tauri.dev.json    the overlay `npm run app:dev` applies: "Ose Dev", com.zhssnym.ose.dev
  capabilities/     the window API, events, updater and restart the page may use (`main`, `w*`)
  build.rs          tauri-build, the Windows manifest linked into every target, the CI stamp
  src/main.rs       the binary: plugins, the `vault` scheme, window and run events, setup, menu
  src/lib.rs        `Host`, the persistent log, the `[code] message` error helpers
  src/commands.rs   every command; bindings.rs registers them and writes the TypeScript
  src/error.rs      `HostError`;  args.rs  `ose [--root p] [--log f] [--version] [path…]`
  src/windows.rs    one window per vault, building windows, geometry, routing OS opens
  src/vault.rs      paths confined to the root, list, tree, search, hash, atomic writes, the root
  src/files.rs      the save path;  encoding.rs  text that is not UTF-8
  src/watcher.rs    the watcher;  hide.rs  the one hide rule
  src/drafts.rs, versions.rs, state.rs, local.rs, vaults.rs   what is kept on this machine
  src/trashbin.rs   the trash;  outside.rs  files outside every vault
  src/protocol.rs   the `vault` scheme;  print.rs  PDF and print (WebView2, Windows only)
  src/platform.rs   opening URLs, revealing files, the version line
  src/spell.rs      spellcheck as underlines only: on macOS, underlines on and autocorrect off
```

The page's side is `src/core/bridge/`: `bindings.ts` (generated), `tauri.ts` (the adapter over
the bindings and Tauri's window API), `commands.ts` (the command contract, kept by hand),
`index.ts` (the facade the core calls), `errors.ts` and `tauri-urls.ts`.

## Commands

Every command is a `#[tauri::command]` in `commands.rs`, with serde structs in and out. Its JS name
is the camelCase of the Rust name (`read_file` is `readFile`). tauri-specta collects them in
`bindings.rs`, which both registers them with Tauri and writes `src/core/bridge/bindings.ts`, so a
command cannot be registered and missing from the bindings. The bindings are never edited by hand:
the test `bindings_are_current` fails when they are out of date, and

```
OSE_WRITE_BINDINGS=1 cargo test --manifest-path src-tauri/Cargo.toml bindings
```

writes them again. A change of a command changes the Rust, the bindings, `commands.ts` and the
facade together.

| Group | Commands |
|---|---|
| vaults and windows | `rootInfo`, `vaultInfo`, `pickVault`, `openVault`, `openVaultWindow`, `recentVaults`, `forgetVault`, `platform`, `quit`, `log` |
| listing | `tree`, `list`, `stat`ᴬ, `exists`ᴬ, `search` |
| files | `readText`ᴬ, `readFile`ᴬ, `saveFile`ᴬ, `createNew`, `createNewBinary`, `copyFile`, `importOutside`, `appendLine`, `replaceLine`, `writeText`, `appendText`, `writeBinary`, `readBinary`ᴬ, `mkdir`, `rename`, `copyPath` |
| trash | `trash`, `trashWhere`, `trashList`, `trashRestore` |
| drafts | `draftWrite`ᴬ, `draftList`, `draftRead`ᴬ, `draftDrop`ᴬ |
| versions | `versionKeep`, `versionList`, `versionRead`, `versionRestore` |
| state | `getState`, `setState`, `localGet`, `localSet` |
| platform | `openExternal` (http, https, mailto), `openPath`ᴬ, `reveal`ᴬ, `printToPdf`, `showPrintUI`, `pickFile` |
| outside files | `outsideOpen`, `takeOpens` |

The conventions:

- A path is a vault path, with forward slashes. The commands marked ᴬ also take `abs:<path>` for
  a file outside the vault that this window registered with `outsideOpen`. On any other command an
  `abs:` path is `escapes_vault`, and an unregistered one is `not_registered`.
- Every command finds its window's state from the window that invoked it.
- A mutating command's options carry `epoch?`. Each window's epoch starts at 1 and goes up by one
  every time the window adopts a vault; a command naming another epoch is `stale_vault`, so the
  last save of a page from a vault that was just left never lands in the one that replaced it.
- `tree`, `search`, `copyPath` and the trash run on a blocking worker, never on the async runtime.
- `search(query, {limit, chan, hidden})`: every term must be in the file or its path. `limit`
  counts files (100 by default, 0 for none); a newer search on the same `chan` makes an older
  one answer `stale`.
- `printToPdf` and `showPrintUI` are WebView2's own and Windows only (`unsupported` elsewhere);
  the page calls `window.print()` only where the host answers `unsupported` (macOS), since in
  WebView2 it is Edge's preview, with its header and footer, and it blocks the renderer. Export
  to PDF is `ose.paper.pdf`, Print is `ose.paper.dialog`. The sheet is `src/editor/print.css`.
- Every failure is logged as `cmd <name> failed: <code> <message>`; `--log <file>` also traces
  each command's name.

## Errors

Every refusal is a `HostError`, sent as `{code, message}`. The codes: `not_found`, `exists`,
`not_utf8`, `unencodable`, `lossy`, `stale_vault`, `no_vault`, `write_failed`, `bad_arg`,
`bad_name`, `escapes_vault`, `not_registered`, `unsupported`, `io`. The page acts on the code and
shows the message. Below the commands, modules still return `Result<_, String>` with a
`[code] message` prefix; `HostError::from` reads the code back, and a missing or unknown code is
`io`. In the page, `src/core/bridge/errors.ts` turns the answer into an `Error` with `.code`.

## Events

The host emits to one window at a time:

- `fs`: `{changes: [{path, kind, to?, dir?, hidden?}], rescan?, lost?}`, where `kind` is `create`,
  `modify`, `delete` or `rename` (with `to`). `rescan: true` means something may have been missed
  and the page re-reads what it shows; `lost: true` means the vault folder went away, and
  `lost: false` that it came back.
- `open`: `{requests: [{path, outside, kind, line?}]}`, an OS open for this window after its first
  `takeOpens`.

Closing goes through the page: the adapter prevents the close, sends a `window` `{closing: true}`
notice to its own subscribers, awaits every editor's last save, then destroys the window.
`quit` and the macOS menu's Quit close every window that way; the app exits when none is left.

## The vault root

A window's vault is any folder; it needs no marker. The first window's root is, in order:

1. `--root <path>`, when it is a folder;
2. a path the OS handed this launch: a folder, or a file inside a vault (that vault, found as
   OS opens find it, below);
3. the nearest ancestor of the executable that looks like a vault (it has `.ose/` or a
   `CLAUDE.md`, and no `src-tauri/`), never a drive root;
4. the `OSE_ROOT` environment variable;
5. the remembered root, one line in `<config>/vault`;
6. otherwise none, and the shell shows the chooser (recent vaults, Choose folder…).

The root the app opens goes to the top of the recent vaults (`<config>/vaults`, ten lines).

## Windows

One window per vault, never two on one root (compared case-folded on Windows and macOS). Labels
are `main`, then `w2`, `w3`, …; the capability covers `main` and `w*`. Every window is built by
`windows::build`: 1280 by 800, at least 480 by 360, hidden until the page has loaded, the theme's
background painted first, HTML5 drag and drop (Tauri's own drop handler is off), no zoom hotkeys.
On Windows there are no decorations and the page draws its own window buttons; on macOS the title
bar is `Overlay` with a hidden title, so the traffic lights sit over the page's toolbar. `main`
keeps its bounds in `local/app.json`, any other window in its vault's local object; a new window
with nothing saved opens 32 px down and right of the focused one.

A second launch is caught by `tauri-plugin-single-instance` (the first plugin), which hands its
arguments to the running process. **OS opens** (`windows::route`): a folder opens in the window
that has it, or in the window whose vault holds it, or in a new window; a file inside a window's
vault opens there; a file inside a vault with no window opens a window on that vault; anything
else opens as an outside file in the window focused last. Nothing in a vault marks it, so "a vault"
is one the app knows (`windows::vault_finder`): the deepest of the recent vaults and the
remembered root that holds the file, else, for a vault an older Ose marked and this one never
opened, the nearest ancestor holding `.ose/`. Never a `CLAUDE.md`: a code repository is not a
vault. On macOS, Finder's opens arrive as
`RunEvent::Opened` and wait for the first window if they come before it.

## Files

- **The hash** is FNV-1a 64 over the raw bytes, as 16 hex digits (`vault::hash`). The page never
  computes one: it carries what `readFile` and `saveFile` answered.
- **`saveFile(path, text, {expectedHash, version, encoding})`** compares the disk with
  `expectedHash` and writes in one call, under one lock per path. A missing `expectedHash` means
  "the file must not exist". A mismatch writes nothing and answers `{status: 'conflict', disk}`;
  success is `{status: 'saved', hash, mtime}`. Right before the rename the target is read once
  more, so an outside writer (an agent, a sync client) that wrote meanwhile wins and the page sees
  the conflict. The replaced bytes are kept as a version after the write (none for an outside
  file); a version that cannot be kept never fails the save.
- **Atomic writes** (`vault::write_atomic`): a temp file `.<name>.<pid>.<n>.tmp` beside the
  target, synced, then renamed over it. A rename refused by a scanner or sync client is retried
  for about two seconds. Bytes on disk are never thrown away: a rename that still fails moves the
  temp file to a visible `<stem>.unsaved-<stamp>.<ext>` and the error says where. A vault folder
  that is gone is `no_vault`, never recreated.
- **Creates never overwrite**: `createNew`, `createNewBinary`, `copyFile`, `copyPath`,
  `importOutside`, `rename` and `trashRestore` open the target exclusively.
- **`appendLine`** adds one line with the file's own line separator, adding a break first when the
  file does not end with one. **`replaceLine(path, index, expected, next)`** replaces one line only
  while it still reads `expected` (else `{status: 'conflict', actual}`). Both keep every other
  byte, line endings and a byte-order mark included.
- **`rename`** moves the file's versions and drafts with it.

## Encodings

`readFile` answers the text, its hash and the encoding it was decoded from. Valid UTF-8 (with or
without a BOM) is UTF-8, a UTF-16 BOM is UTF-16, mostly-UTF-8 bytes are damaged UTF-8, and
anything else is what chardetng guesses (encoding_rs decodes). A file is saved back in its own
encoding. A decode that does not round-trip is `lossy`: the file opens read-only and a save in its
encoding is refused; converting to UTF-8 is always an explicit command. A character the target
encoding cannot hold is `unencodable`, and nothing is written.

## The watcher

`notify` watches the root recursively through `notify-debouncer-full`: about 150 ms of quiet per
path, a path's changes merged into one, and the two halves of a rename paired by file id (Windows,
macOS), so a rename in Explorer or Finder arrives as one rename. Excluded paths are never
reported. Each change says whether it is a folder and whether it is hidden, so the tree patches one
row. The backend's rescan flag, a dead `ReadDirectoryChangesW` (notify only logs it; `lib.rs` turns
that log record into a restart), a debouncer error and every restart send `rescan: true`. The root
is checked every second for `lost`. A rename seen on disk moves the file's versions and drafts, as
one made in the app does. The page's own saves are reported too; the editor tells them apart by
the hash.

## The hide rule

`hide.rs` is the only place a name is special. **Excluded** (never listed, walked, searched or
watched): `.ose` and `.git` anywhere; at the vault root, the executable and what a build leaves
beside it (`ose.exe`, `Ose.app`, `WebView2Loader.dll`, the pre-1.0 `os.*` names, update
leftovers); the vault bin's `.trash/.info`; and the atomic writer's temp files. **Hidden** (listed
only with Show hidden items): dotfiles and the system's hidden attribute; `.trash` is hidden and
never searched. Everything else is shown. The walker is the `ignore` crate with its own filters
off (`.gitignore` means nothing to a vault), and links are never followed.

## What the app keeps on this machine

Nothing below is in the vault. A vault is keyed by `vaultKey`, the hash of its normalised absolute
root (lowercased on Windows and macOS).

A moved or renamed vault starts fresh: its settings, planner paths, versions, drafts and window
are keyed by its old path, so the app sees a new vault and the old folders stay behind. This is
deliberate: the only way to follow a vault that moves would be to write a marker into it, and
nothing of the app is written into the vault.

| Folder | Windows / macOS | Holds |
|---|---|---|
| data | `%LOCALAPPDATA%\com.zhssnym.ose\` / `~/Library/Application Support/com.zhssnym.ose/` | `vaults/<vaultKey>/state.json`, `history/<vaultKey>/…`, `drafts/<vaultKey>/…`, `drafts/outside/` |
| config | `%APPDATA%\com.zhssnym.ose\` / the same as data | `vault` (the remembered root), `vaults` (recent), `local/app.json`, `local/vaults/<vaultKey>.json` |
| log | `%LOCALAPPDATA%\com.zhssnym.ose\logs\` / `~/Library/Logs/com.zhssnym.ose/` | `ose.log`, rotated at 2 MB, keeping `ose.1.log` and `ose.2.log` |

The dev build (`npm run app:dev`) is `com.zhssnym.ose.dev`: its own folders, its own single-
instance lock, so it runs beside the installed app.

- **State** (`getState`, `setState`): the vault's settings and the planner's paths, one JSON
  object. A vault that still has `<root>/.ose/state.json` from an older Ose is read from there
  until the first write puts it in the data folder; the old file is left alone.
- **Local store** (`localGet`, `localSet`): `app` (this machine, every vault) and `vault` (this
  machine, this vault), whole objects of at most 1 MB. The keys `window` and `theme` of `app.json`,
  and `window` of a vault's object, belong to the host: the page never sees or overwrites them.
  The theme is mirrored there so the next launch paints the right background before any script.
- **Drafts**: one JSON file per page, `<pathKey>.json` (the hash of the vault path), carrying its
  vault root and path. A draft is kept until a save lands; `draftDrop(path, {ifRev})` removes only
  a draft at that edit or before it, under one lock for all draft commands.
- **Versions**: before a save replaces a file, its bytes go to
  `history/<vaultKey>/<path>/<id>.<reason>.<ext>`, the id the UTC time, the reason `save`,
  `conflict`, `reload` or `restore` (`-s` for a session's first). At most one per file per minute
  unless forced. Thinning per file: everything under an hour, the newest per hour under a day,
  the newest per day under thirty days, then only the newest; a session's first and every
  non-`save` version stay thirty days. At most 200 MB per vault, oldest first, never a file's
  newest nor one younger than a day. Versions an older Ose kept in the vault (`.ose/history`,
  or `.ose/versions` before that) are still listed and read, merged with these newest first, an
  id both hold listed once; they are never written, thinned, moved or deleted, and restoring one
  writes only the file.
- **Trash**: nothing is deleted outright. `trash` sends a path to the system's Recycle Bin or Trash,
  or to `.trash` at the vault root when the vault's setting `settings.trash` is `vault`, when the
  volume has no bin, or when the system refuses; a sidecar in `.trash/.info` remembers where it came
  from. The answer gives an id for `trashRestore`. The macOS Trash cannot be read back by an app:
  its items are restored from Finder.

## Files outside the vault

A file outside every vault (Open file…, or the OS) is named `abs:<absolute path>`: forward
slashes, the drive letter in capitals, no `\\?\` prefix, NFC on macOS. A window may touch only the
outside files it registered with `outsideOpen`, for its lifetime. That allows reads, saves and
drafts (the ᴬ commands), read-only media under its folder through the `vault` scheme at
`/~abs/<percent-encoded path>`, and a watch of its folder. Versions, rename, move, trash, links and
attachments are refused.

## The `vault` scheme

`protocol.rs` serves each window's vault read-only to the webview, so `<img src>` and friends can
point into the tree. Tauri maps the scheme to `http://vault.localhost/<path>` on Windows and
`vault://localhost/<path>` elsewhere (`src/core/bridge/tauri-urls.ts`); the CSP allows both. Ranges
are answered with 206 and no answer is longer than 4 MB, so video seeks; a GET with no range is
answered whole up to 64 MB. The handler runs on a blocking worker, never on WebView2's UI thread.

## Updates and releases

`tauri-plugin-updater` reads `https://github.com/zhssnym/ose/releases/latest/download/latest.json`
and checks the signature against `plugins.updater.pubkey` in `tauri.conf.json`. The page checks at
boot (`src/core/update.ts`), downloads in the background, and asks before installing and
restarting (`tauri-plugin-process`). Every push to `main` runs `.github/workflows/release.yml`,
which builds Windows (NSIS) and macOS (Apple silicon) with `tauri-action`, signs the update with
the secret `TAURI_SIGNING_PRIVATE_KEY`, and publishes release `v0.9.<run number>`; the version is
passed as a `--config` overlay, so every push is newer than the last.

There is one version: the built Tauri config's (`package.json`, or that overlay), which the host
reads through `package_info()` for `platform().version`, `ose --version` and the log's first line;
Cargo.toml's is kept equal to `package.json` and never reported. The release job also sets
`OSE_BUILD_SHA` (the commit) and `OSE_BUILD_DATE` (its commit day, UTC) for the build, read at
compile time (`platform::build_info`): `ose --version` prints `ose 0.9.42 (a45404e, 2026-09-15)`,
and a local build `(dev build)`.

## Testing

`cargo test --manifest-path src-tauri/Cargo.toml` runs the host's unit tests, each module's in the
module, on temporary folders; CI runs it on every pull request. The page's tests (`npm test`) use
stubs, never the host. The host itself is checked by running the app on a throwaway vault:
`npm run app:dev`, or `ose --root <folder> --log <file>` to trace every command.
