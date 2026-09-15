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

## Round four (2026-09-15): the kernel

### The rename

The executable is `ose.exe` on Windows and `Ose.app` on macOS. Version 0.4.0.

```
Cargo.toml          package `ose`, [[bin]] name = "ose", version 0.4.0
tauri.conf.json     productName "Ose", mainBinaryName "ose", window title "Ose"
release assets      ose.exe, ose-macos-arm64.zip
                    plus os.exe and os-macos-arm64.zip, byte for byte the same, so a 0.3.x
                    build in the field can still find the asset it looks for. Drop the two
                    duplicates once no 0.3.x remains (a comment in build.yml says so).
ose --version       ose 0.4.0 (a7d42de, 2026-09-15)   |   ose 0.4.0 (dev build)
```

The old name keeps working in three places, because a portable app that renames itself would
otherwise orphan every copy already on disk:

- **On disk.** The layout the update uses is built from the running executable's *own* file
  name, whatever it is. A copy still called `os.exe` swaps `os.exe` → `os.exe.old`,
  `os.exe.new` → `os.exe` and stays `os.exe`; a copy called `ose.exe` does the same with its
  own name. A swap never renames the file it found.
- **In the release.** `update.rs` `check()` and `download()` accept an asset named `ose.exe`
  **or** `os.exe` on Windows, `ose-macos-arm64.zip` or `os-macos-arm64.zip` on macOS, and
  prefer the new name when both are published. The macOS swap accepts a bundle called
  `Ose.app` or `os.app` inside the zip and renames it to whatever the running bundle is
  called.
- **In the vault.** `vault.rs` hides both sets of names, so neither binary nor its update
  leftovers appear in the tree: `ose.exe ose.pdb ose.exe.new ose.exe.old Ose.app Ose.app.old
  ose-update.zip ose-update-tmp` and the same six with `os`. Matching is case-insensitive, so
  `OSE.EXE` and `os.app` are covered.

### Kernel origins and the rice loader

### Three origins

```
ose.localhost     the kernel's embedded assets (dist-kernel/, compiled into the executable)
app.localhost     <vault>/.ose/app, or the folder given by --rice <dir>
vault.localhost   the vault's own files, as before
```

On Windows a custom scheme is served at `http://<scheme>.localhost/...`; on macOS and Linux at
`<scheme>://localhost/...`. That is Tauri's rule, not ours, and it is why nothing in a rice
file ever spells an origin: `platformInfo` reports all three
(`kernelOrigin`, `appOrigin`, `vaultOrigin`, no trailing slash) and the host rewrites the
rice's `index.html` on the way out.

**`ose` (the kernel).** `dist-kernel/` is `frontendDist` in `tauri.conf.json`, so `tauri build`
embeds it and the protocol handler serves it through the app's asset resolver. GET only. Mime
type from the extension (the table in `protocol.rs`). `Access-Control-Allow-Origin: *`,
`Cache-Control: no-store`. A missing name is 404. `/` and `/index.html` both give the fallback
page.

**`app` (the rice).** Files under the rice folder, read at request time. GET only. Path
percent-decoded, then resolved with the same containment check the vault uses: a request whose
path escapes the folder is **404**, never a redirect and never a listing. A directory is 404
(no directory listing, no implicit `index.html` inside a subfolder); the bare `/` is the rice's
`index.html`. `Cache-Control: no-store` on everything, so Ctrl+R shows the file you just saved.
`Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: Content-Security-Policy`,
so a page on another origin — the self-test is one — can read the policy the host applied.

`index.html` is the one file that is rewritten in flight:

1. the import map is inserted immediately after `<head>` (or at the very top of the document
   when there is no `<head>`):

   ```html
   <script type="importmap">{"imports":{
     "ose:kernel":"<kernel origin>/kernel.js","ose:editor":"<kernel origin>/editor.js",
     "ose:ui":"<kernel origin>/ui.js","ose:md":"<kernel origin>/md.js"}}</script>
   ```

2. `<link data-ose="ui">` gets `href="<kernel origin>/ui.css"` and `<link data-ose="editor">`
   gets `href="<kernel origin>/editor.css"`, whatever href they carried (or none).
3. the response carries

   ```
   Content-Security-Policy: default-src 'none';
     script-src <kernel> <app> 'sha256-…';
     style-src <kernel> <app> 'unsafe-inline';
     img-src <kernel> <app> <vault> data: blob:;
     font-src <kernel> <app> data:;
     media-src <kernel> <app> <vault> blob:;
     connect-src <kernel> <app> <vault> <ipc> ipc:;
     worker-src <kernel> <app> blob:;
     frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
   ```

   Three origins, inline styles, and nothing from the network at all. `<ipc>` and `ipc:` are
   Tauri's own invoke channel, which the injected bootstrap `fetch`es; they are the only
   non-origin entries.

   **A rice's own code lives in files, never in an inline `<script>`.** `script-src` carries no
   `'unsafe-inline'`: the one inline script in the page is the import map the host itself
   injected, and it is allowed by the sha256 of exactly its own text. This is deliberate. It is
   what docs/RICE.md asks for anyway ("a rice file imports `ose:*` and its own files"), and it
   means a `<script>` smuggled into a markdown file cannot run even if it ever gets past the
   renderer's sanitiser. An inline `<style>`, and `style="…"` on an element, are fine.

### What the window loads

At `setup`, in order:

1. no vault → the kernel's fallback page (it is what draws `Open folder`);
2. `--no-rice`, or Shift held at launch → the fallback page. Windows reads
   `GetAsyncKeyState(VK_SHIFT)` through `windows-sys`; macOS reads
   `NSEvent::modifierFlags` through `objc2-app-kit`; on Linux nothing is read and the flag is
   the only way.
3. a rice is present → `app.localhost/index.html`. "Present" is
   `<rice>/index.html` is a file **and** `<rice>/cockpit.json` either does not exist or parses
   and has `requires <= ose.api` (1). A `cockpit.json` that is not valid JSON, or that requires
   a later api, is a refusal with the reason in the log and on the fallback page.
4. otherwise the fallback page.

The rice folder is `<vault>/.ose/app`, or `--rice <dir>` (absolute, or relative to the current
directory), which also works with no vault at all.

**The five-second timer.** When the window is sent to the rice the host arms a 5 s timer. The
kernel calls `riceReady` the moment `ose.ready` resolves, which cancels it; `riceFailed(reason)`
falls back at once. If neither arrives the host logs
`rice: no riceReady within 5s, falling back` and navigates the window to the kernel's
`index.html`. The fallback page calls `riceReady` too, so it never bounces to itself.

### New rpc

```
riceInfo()   -> { dir, source, present, disabled, requires, why, api }
    dir       absolute, or null with no vault and no --rice
    source    'vault' | 'arg' | 'none'
    present   a rice is there and this kernel can load it (step 3's first test)
    disabled  --no-rice, or Shift held at launch
    requires  the number in cockpit.json, or null when there is no cockpit.json
    why       why a rice that is there was refused, or null. The two reasons are
              "cockpit.json is not valid JSON: …" and
              "cockpit.json requires ose.api <n>; this kernel is 1"
    api       the kernel's own ose.api, 1
  The window went to the rice exactly when `present && !disabled`.

reloadRice() -> null    reloads the window's current page (Ctrl+R). It reloads whatever is
                        loaded, except that a reload asked for from the fallback page re-runs
                        the decision: creating `.ose/app/index.html` and pressing Ctrl+R is how
                        a person gets from the fallback into their new rice.
riceReady()  -> null    cancels the fallback timer
riceFailed(reason) -> null   navigate to the fallback page now, with the reason logged
platformInfo() gains kernelOrigin, appOrigin, vaultOrigin and api
readBinary(path) -> base64   (docs/KERNEL.md `ose.files.readBinary`; the counterpart of
                        writeBinary, added here because vault.rs is this package's file)
```

The log says what was decided, in one line, on every launch — including `--selftest`, which has
a page of its own and never calls the loader:

```
rice: loading D:\vault\.ose\app (from vault)
rice: the fallback page (--no-rice or Shift at launch)
rice: the fallback page (no index.html in the rice folder)
rice: the fallback page (cockpit.json requires ose.api 2; this kernel is 1)
rice: no riceReady within 5s, falling back
```

### Command line

```
--rice <dir>    serve this folder as the rice instead of <vault>/.ose/app
--no-rice       load the kernel's fallback page whatever the vault holds
```

`--root`, `--log`, `--selftest`, `--version`, `--update`, `--after-pid` are unchanged.
Shift held at launch is `--no-rice`.

### `run`

One rpc pair, and the bridge event `run`.

```
run(id, cmd, args, opts)  -> { id, pid }      resolves when the process has started
    opts: { cwd, timeout, env, input, allow }
    cwd      vault-relative, contained in the vault; default the vault root. With no vault
             open the process's own current directory.
    timeout  ms, default 60000, 0 or negative means the default. At the timeout the process
             tree is killed and `done` carries `timedOut: true`.
    env      merged over the process environment and over the UTF-8 floor
             PYTHONUTF8=1, PYTHONIOENCODING=utf-8, LANG=C.UTF-8, LC_ALL=C.UTF-8.
             A value of null removes a variable.
    input    written to stdin, which is then closed. Absent means stdin is closed at once.
    allow    the program names this caller may run (a module's module.json `run`).
runKill(id)               -> boolean          true when a process with that id was running
```

`cmd` is **a program name resolved on PATH, or a vault-relative path to a file inside the
vault**, and never a shell: no `cmd.exe /c`, no `sh -c`, no argument string that a shell would
split. `args` is a list of strings passed through untouched. On Windows the child gets
`CREATE_NO_WINDOW`, so nothing flashes.

**The allow rule.** A program may run when its name is in the per-call `allow` **or** in
`settings.run.allow` in `.ose/state.json` (a list of program names, default empty — the rice
itself may run nothing until the user allows it). Neither is `Err("not allowed: <cmd>")`. The
name compared is the file name without a directory and without `.exe`/`.bat`/`.cmd`, lowercased
on Windows, so `allow: ["python"]` covers `python`, `python.exe` and `tools/python.exe` and
does not cover `python3` — name a program exactly as you mean to run it.

**Streaming.** stdout and stderr are read on their own threads and emitted line by line:

```
event "run"  { id, stream: "stdout" | "stderr", line }        no trailing newline, CR stripped
event "run"  { id, done: true, code, timedOut }               code is null when killed
```

Lines are decoded as UTF-8 lossily, so a program that writes Latin-1 gives replacement
characters rather than an error. A final partial line with no newline is emitted before `done`.

Every process the host started is killed when the app exits, when the vault changes, and on
`runKill`. Ids are the caller's; a second `run` with a live id is `Err("run id in use: <id>")`.

### The dev host

`dev/bridge-plugin.mjs` implements `run`, `runKill`, `riceInfo` and `reloadRice` with the same
shapes: Node's `spawn`, the same UTF-8 floor, the same allow rule read from the same
`settings.run.allow` in the same `state.json`, the same `run` events over the existing SSE
channel. `reloadRice` is a no-op in the browser (F5 is the reload) and answers `null`.
`riceInfo` reports the dev rice folder: `OSE_RICE` if set, else `<repo>/cockpit` if it exists,
else `<vault>/.ose/app`, with `source` `'arg'`, `'arg'` and `'vault'` respectively.

### The self-test

`ose --selftest --root <vault> --log <file>` navigates to `<kernel origin>/selftest.html`.
Four checks join the existing ones:

- `platformInfo` — the three origins are there, carry no trailing slash, and have this
  platform's shape (`http://x.localhost` on Windows, `x://localhost` elsewhere).
- `riceInfo` — the shape, and the decision.
- the `app` protocol serves the rice's `index.html` with the import map carrying the kernel
  origin, the `data-ose="ui"` link rewritten, and a `Content-Security-Policy`; and it refuses
  to escape — `/../x`, `/%2e%2e/x` and `/../../CLAUDE.md` all answer 404 while `/` answers 200.
  Skipped when no rice is present.
- `run` — a program in neither allow list is refused with `not allowed: <cmd>`; then
  `python -c "print('é')"` (or `python3`, or `node -e`, or SKIP when none is on PATH) comes
  back as exactly `é` with `code` 0 and `timedOut` false; then `runKill` kills a sleeping
  child, the `done` event arrives, and a second `runKill` on the same id answers false.

CI runs three windows on each runner:

1. `ose --selftest --root ci/fake-vault --log …` with `ci/fake-vault/.ose/app` in place — the
   whole page above, and the job fails if the app-protocol checks did not run (which is how a
   missing fake rice is caught rather than silently skipped).
2. `ose --root ci/fake-vault --log …` with **no** `--selftest`: the window really goes to the
   rice. The fake rice imports `ose:kernel` through the injected import map, checks that its
   `<link data-ose="ui">` now points at the kernel origin, logs `rice ok (api 1, …)` and quits
   itself. The job fails on a missing `rice ok` or on any `falling back`.
3. `ose --selftest --no-rice --root ci/fake-vault --log …`: the same page again, plus the log
   line `rice: the fallback page (--no-rice or Shift at launch)`.

Plus `ose --version`, asserted to match `^ose 0\.\d+\.\d+ \(`, from the binary CI is about to
publish.
