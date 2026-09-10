# ose on Tauri: the host rewrite (branch `tauri`)

The web UI, CONTRACT.md and DESIGN.md are unchanged and are the application. This document
describes the second host: Tauri 2 with a Rust backend, replacing `host/` (.NET, Windows only)
so one codebase ships `os.exe` on Windows and `os.app` on macOS (Apple silicon). The bridge API
the web side uses is exactly the one in CONTRACT.md; only the adapter and the host change.

## Layout

```
src-tauri/
  Cargo.toml              package `ose`, bin `os`, tauri 2, serde, serde_json, notify, trash, walkdir, opener
  tauri.conf.json         window "main", decorations false, no default menu, min 720x480
  tauri.macos.conf.json   platform merge: decorations true, titleBarStyle "Overlay", hiddenTitle true
  capabilities/default.json   core window permissions for the main window
  icons/                  generated from the terracotta "os" mark (tauri icon)
  src/main.rs             entry: parse args, build the app, register the `rpc` command and the vault protocol
  src/lib.rs              modules, AppState, run()
  src/args.rs             --root <path>, --log <file>, --selftest
  src/vault.rs            root resolution, paths, fs commands, search, trash, hidden names
  src/state.rs            <root>/.ose/state.json get/set (atomic write), window bounds, theme
  src/protocol.rs         `vault` URI scheme serving files read-only from the root with mime types
  src/watcher.rs          notify + 150ms debounce -> event "fs"
  src/platform.rs         open_external, reveal, platform info
  src/selftest.rs         (optional) helpers for --selftest logging
src/bridge/tauri.js       the adapter (invoke + listen + window API)
src/bridge/index.js       picks tauri.js when window.__TAURI_INTERNALS__ exists, else webview.js, else http.js
selftest.html             second Vite entry: runs every bridge command, logs PASS/FAIL through `log`, then winClose
.github/workflows/build.yml   Windows + macOS builds, artifacts, rolling prerelease
```

## The RPC

One Tauri command, mirroring the .NET Bridge.cs dispatcher so the web adapter stays trivial:

```rust
#[tauri::command]
async fn rpc(app: tauri::AppHandle, state: tauri::State<'_, AppState>, cmd: String, args: Vec<serde_json::Value>)
    -> Result<serde_json::Value, String>
```

`cmd` is the bridge method name in camelCase exactly as CONTRACT.md lists them: `rootInfo`,
`tree`, `list`, `stat`, `exists`, `readText`, `writeText`, `appendText`, `writeBinary`, `mkdir`,
`rename`, `trash`, `search`, `openExternal`, `reveal`, `getState`, `setState`, `log`,
`pickVault`, `vaultInfo`, `forgetVault`, `updateCheck`, `updateDownload`, `updateApply`, plus
`platform` (returns `{os: "windows"|"macos"|"linux", version, exe, root}`). Window commands
(`winMinimize` ... `winSetTheme`) are NOT routed through rpc: the adapter uses the Tauri window
API directly. Unknown `cmd` -> `Err("unknown command: <cmd>")`. Every error is a plain string.

Each Rust module exposes `pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>>`
and `lib.rs` tries vault, state, platform in that order; `None` means "not mine".
`Ctx` carries the `AppHandle` and the `AppState` (root: PathBuf, log: Option<Mutex<File>>,
watcher handle) so modules do not import each other.

Argument shapes and return shapes are those of CONTRACT.md (the .NET host's `Bridge.cs` and
`Vault.cs` are the reference implementation; port them, do not redesign). Paths in and out are
vault-relative with forward slashes; anything resolving outside the root is an error
`path escapes the vault: <p>`. Text is UTF-8 and comes back byte for byte: a BOM and the line endings are kept (the editor strips and restores the BOM itself). Hidden names:
`.git .obsidian .claude .vscode .trash node_modules App .tmp.driveupload .makemd .space os.exe
os.pdb .ose` and any name starting with a dot (`.ose` holds the state file). `_Archive` is not
hidden. Sorting: folders first then natural numeric (the web side re-sorts anyway).

## Events (app.emit, listened with `listen` in the adapter)

```
"fs"      { changes: [{ path, kind: "create"|"modify"|"delete"|"rename", to? }] }   debounced 150ms, hidden paths filtered
"claude"  { id, event }   event = the CLI's stdout line parsed as JSON, or {type:"stderr", text}, or {type:"exit", code}
```

Window events come from Tauri itself; the adapter turns `onResized`/`onFocusChanged` into the
contract's `{event:"window", data:{maximized, focused}}` and `onCloseRequested` into
`{closing:true}`: the adapter prevents the close, dispatches `closing`, waits 400ms, then
calls `getCurrentWindow().destroy()`.

## Root resolution

`--root <path>` if it is a directory; else the executable's folder or the nearest ancestor
holding `.ose/` or `CLAUDE.md` (never one that also holds `src-tauri`; on macOS the walk
climbs out of `os.app/Contents/MacOS`); else `OSE_ROOT`; else the remembered root, one line in
`app_config_dir()/vault`, read in `setup` once the app handle exists; else the app starts with
no root and the UI asks. `AppState.root` is `RwLock<Option<Root>>` read at call time through
`root()` / `require_root()`; the `vault` protocol, every rpc, the window-close save and the
watcher all follow a root picked later. `pickVault` runs `tauri-plugin-dialog`'s native folder
picker from Rust only (`main.rs pick_folder`, handed to the library as `AppState.picker`), so
no capability entry exists for it. The plugin — and tauri's default `common-controls-v6` —
need the Common Controls v6 manifest in every executable; `build.rs` compiles
`windows-app.manifest` with `embed_resource::compile_for_everything` and asks tauri-build to
leave its own manifest out, which is what lets the library's test harness load on Windows.
Only `--selftest` still exits (2, with a message box) when no root is found.

## Vault protocol

`register_uri_scheme_protocol("vault", ...)`: path = the URL path percent-decoded, resolved
inside the root, GET only, `Content-Type` by extension (png jpg jpeg gif webp svg pdf md txt
json), 404 otherwise. The adapter's `assetUrl(path)` returns `http://vault.localhost/<encoded>`
on Windows and `vault://localhost/<encoded>` on macOS and Linux (Tauri's platform rule).

## Self-update (update.rs)

Stamp: CI sets `OSE_BUILD_SHA` / `OSE_BUILD_DATE` on the build step; `build_info()` reads them
with `option_env!` (build.rs re-runs when they change). `os --version` prints
`os 0.1.0 (a7d42de, 2026-09-09)` or `os 0.1.0 (dev build)`; on Windows it attaches to the
parent console first so the line lands in the terminal that asked.

Layout: everything beside the executable — Windows `<dir>/os.exe{,.new,.old}`; macOS the
folder holding `os.app`: `os-update.zip`, `os-update-tmp/`, `os.app.old`.

Windows swap: `os.exe` → `os.exe.old` (renaming a running image is allowed), `os.exe.new` →
`os.exe`, spawn `os.exe` with the original argv (`CREATE_NEW_PROCESS_GROUP`), save the window
geometry, 400 ms, exit. macOS swap: `ditto -x -k zip os-update-tmp/`, `os.app` → `os.app.old`,
`tmp/os.app` → `os.app`, remove tmp and zip, `open -n os.app --args <argv>`, exit. Any failure
after the first rename restores `.old`.

Relaunch and single instance: the relaunched build is started with `--after-pid <pid>` and
waits for that process to exit before it builds the app, otherwise the single-instance plugin
would hand the launch to the old build, which is exiting; a build relaunched without the flag
waits until `.old` can be removed (the old image unlocks at exit) instead.

Cleanup: `setup` runs `finish_previous` on a thread — removes `.old`/`.new`/zip/tmp, retrying
for 5 s because on Windows `.old` stays locked until the parent that spawned us exits. A build
that will not start leaves `.old` beside it for a manual rename back.

`tests/swap.rs` (Windows) copies the built executable twice into a temp folder, holds one
running with `--hold`, runs the swap against it and checks the names before and after.

`os --update` runs the whole loop with no window: check, download when behind, swap, relaunch;
the relaunched build runs the same argv, logs itself up to date and exits 0. Exit 1 with the
reason in the log on any failure. It is what a script uses, and what proved the assembled
loop on a machine where the dialog could not be clicked.

## Window

Windows and Linux: `decorations: false`, shadow true, our title bar with drag through the
adapter's `winStartDrag` -> `startDragging()`, resize edges through `startResizeDragging`.
macOS: `decorations: true`, `titleBarStyle: "Overlay"`, `hiddenTitle: true`: the traffic lights
stay native and the web title bar leaves 78px free on the left and shows no window buttons
(the shell reads `bridge.platform` and applies `.mac` on `<html>`). Theme: `setTheme` on the
window plus the state file; first paint colour comes from `backgroundColor` in tauri.conf set
from the saved theme at startup (dark `#1A1917`, light `#FAF9F5`). Bounds and maximised state
restored from `state.json` `window` and saved on close; validated against the available
monitors. Minimum 720x480.

## Self-test

`os --selftest --root <vault> --log <file>` loads `selftest.html` instead of `index.html`. The
page imports the bridge facade, runs every command (mutating ones only when
`<root>/.selftest` exists), reports each as `PASS`/`FAIL` through the `log` command, and
finally calls `bridge.win.close()`. CI runs it on both runners against a fake vault
(`ci/fake-vault/` with CLAUDE.md, Inbox.md, a `.selftest` marker, a few md files and a png)
and fails the job on any FAIL line.

## Dev, build, ship

- `npm run dev` unchanged (browser + Node bridge). The vault root for dev and for `ship` comes
  from `OSE_ROOT` or from `ose.config.json` (`{"root": "D:/os"}`, gitignored), default the
  parent folder as before.
- `npm run tauri:dev` runs `tauri dev` (needs a local Rust toolchain; may not exist on Hassan's
  PC), `npm run tauri:build` runs `tauri build --bundles none` on Windows (single `os.exe` in
  `src-tauri/target/release/`) and `tauri build --bundles app` on macOS (`os.app`).
- `scripts/ship.mjs` copies `os.exe` from the Tauri output to `<root>/os.exe`.

## CI (.github/workflows/build.yml)

On push to `main` and `tauri`, and on tags `v*`: two jobs. `windows-latest`: setup node 22,
rust stable, `npm ci`, `npm run build`, `tauri build --bundles none`, run the self-test against
`ci/fake-vault`, upload `os.exe`. `macos-14`: same with target `aarch64-apple-darwin`,
`--bundles app`, self-test, `ditto -c -k --keepParent os.app os-macos-arm64.zip`, upload.
Then a release job: on `main`, update the rolling prerelease `latest` with exactly those two
assets; on the `tauri` branch, the rolling prerelease `tauri-preview`; on a `v*` tag, a normal
release. Use `softprops/action-gh-release` with `tag_name` forced to the rolling name and
`prerelease: true`. Cache cargo and npm.

## Ownership for this batch

- toolchain agent: local Rust build feasibility only (rustup + zig or gnu); reports, installs
  nothing system-wide, touches no repo file except an optional `.cargo/config.toml`.
- rust-core agent: `src-tauri/` skeleton, Cargo.toml, tauri.conf*, capabilities, icons,
  main.rs, lib.rs, args.rs, vault.rs, state.rs, protocol.rs.
- rust-claude agent: watcher.rs, claude.rs, platform.rs (+ their registration lines are given
  to the core agent through this file: each module's `handle` and `start` signatures below).
- web agent: `src/bridge/tauri.js`, `src/bridge/index.js`, `selftest.html`, vite multi-entry,
  package.json scripts and deps, the `.mac` title bar rule in the shell.
- ci agent: `.github/workflows/build.yml`, `ci/fake-vault/`, `ose.config.json` support in
  `dev/bridge-plugin.mjs` and `scripts/ship.mjs`, README.md for the repo.

Shared signatures (so the two Rust agents can work blind of each other):

```rust
// lib.rs (core agent)
pub struct AppState { pub root: PathBuf, pub log: Option<Mutex<std::fs::File>>, pub claude: claude::Sessions, pub watcher: Mutex<Option<watcher::Handle>> }
pub struct Ctx<'a> { pub app: &'a tauri::AppHandle, pub st: &'a AppState }
pub fn log_line(st: &AppState, s: &str);

// watcher.rs (claude agent)
pub struct Handle { /* stops on drop */ }
pub fn start(app: tauri::AppHandle, root: PathBuf) -> Handle;      // emits "fs"

// claude.rs (claude agent)
pub struct Sessions { /* Mutex<HashMap<String, Session>> */ }   impl Default
pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>>;  // claudeInfo/Start/Send/Interrupt/Stop/Transcript
pub fn kill_all(st: &AppState);

// platform.rs (claude agent)
pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>>;  // openExternal, reveal, platform
pub fn find_claude() -> Option<PathBuf>;
pub fn transcript_dir(root: &Path) -> PathBuf;

// vault.rs / state.rs (core agent)
pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>>;
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String>;  // used by claude.rs for cwd
```

## Batch 12 (2026-09-10)

### Single instance

`tauri-plugin-single-instance` is registered first, before every other plugin. A second `os`
hands its argv and cwd to the running process and exits; the callback in `main.rs` decides what
the launch meant. `--root <dir>` naming the folder that is already open, or no `--root` at all,
means "show me the window": unminimize, show, focus. Another folder is adopted through
`vault::adopt` — remembered, watched, recorded in the recent list — and the webview is told on
the `vault` event to reload itself into it, because every module read its world from the root at
boot. Two vaults side by side in two windows is out of scope; the plugin is per app id.

### The close path

`bridge.quit()` and `RunEvent::ExitRequested` both end in `window.close()`, never in
`app.exit()`. `close()` raises `CloseRequested`, which the adapter prevents; it fans out
`{closing: true}`, waits for every handler's promise to settle — with a floor of 400 ms and no
ceiling — and destroys the window only then. A handler resolving `false` (the editor, when the
last save needs an answer) leaves the window open. Destroying the last window raises
`ExitRequested` again, this time with no window to find, and the app exits.

`RunEvent::Exit` writes the window geometry and theme, so even a quit that never reaches the
save path keeps the window where it was.

### Recent vaults

`<app config dir>/vaults`, one absolute path per line, newest first, at most ten. Written by
`vaults::record` from three places: `pickVault`, `openVault` and `setup` (whatever root the app
resolved for itself). Read by `recentVaults`, which adds `exists` and `current` per row.
Compared case-insensitively on Windows and byte for byte elsewhere. `vaults.rs` handles
`recentVaults`, `openVault` and `forgetVault(path)` and is dispatched before `vault.rs`, which
still owns `forgetVault()` with no argument.
