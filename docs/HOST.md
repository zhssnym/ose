# The host

The host is the Rust half of `ose.exe`: a Tauri 2 window, the vault's filesystem, the watcher,
file versions, processes, the three origins the app is drawn from, and the single-instance rule.
It draws nothing and knows nothing about views or plugins. The JavaScript reaches it through one
Tauri command, `rpc`, whose surface is `docs/KERNEL.md`.

```
src-tauri/src/
  main.rs       argv, the window, geometry, single instance, the menu (macOS), the protocols
  lib.rs        AppState, the `rpc` dispatch, `gone()`
  args.rs       the four flags
  shell.rs      the `ose` and `app` origins, the index rewrite, the CSP, load_window, reload
  protocol.rs   the `vault` origin
  vault.rs      paths, the vault filesystem, what is hidden, the root resolution
  watcher.rs    notify on the root, debounced into one `fs` event
  versions.rs   .ose/versions
  run.rs        starting a program, streamed line by line
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
  view's viewer draw it.

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
--log <file>      append the host and UI lines to this file
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
brings the window forward; another folder is adopted, the previous vault's processes are killed
and the window is loaded back into the shell, so nothing in the page can swap the plugins under
itself. The lock is probed before the plugin is installed and the handover is said out loud in the
log, because a copy holding the lock can be a ghost and "the app does not start and the log says
nothing" is the one case a person cannot diagnose.

## The watcher

`notify` on the root, recursive, hidden paths filtered, changes debounced 150ms into one `fs`
event. A rename arrives as two events with nothing joining them, so the pair is matched by arrival
order; the kind that goes out is decided at flush time from the raw kind plus whether the path
still exists. A flood is flushed rather than accumulated, and a batch it could not keep up with
carries `lost`, which tells the page to re-read rather than trust the list.

## Versions

Before a save changes a vault file, its previous content is kept under
`.ose/versions/<rel path>/<timestamp>.md`, where the file's own name is a folder, with a cap per
file and per vault, and at most one version per file per five minutes. Nothing is overwritten in
place: every write goes to a temp file beside the target and is renamed onto it, so a file is
either the old bytes or the new ones. `.ose` is hidden from the tree, so a version is never a page.

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

## RPC

One Tauri command carries the whole surface. A name no handler claims answers `null` rather than
an error, and the first call of each such name writes one line,
`rpc <name>: this host has no such command any more, answering null`. That is what lets the kernel
and the host be changed one at a time.

`reloadShell` is the one command the shell's Ctrl+R reaches: it navigates the main window back to
`<app origin>/index.html`, which reloads the page and therefore every plugin from disk. The host
still answers to the 0.5.0 spelling of that name as well, so a kernel that has not been renamed
keeps working.

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
`ose.exe --root <vault> --shell D:\ose\shell`: edit a file in `shell/`, press Ctrl+R, no rebuild.
The same goes for a plugin, with no flag at all.

## CI

`.github/workflows/build.yml` is one Windows job on MSVC, so the result is a single
self-contained file. Checkout, node 22, rust stable, rust-cache, `npm ci`, `npm run build`, a
check that `dist-kernel/` holds the bundles and `shell/index.html`, the `OSE_BUILD_SHA` /
`OSE_BUILD_DATE` stamp, `npm run tauri:build`, `ose.exe` staged at the workspace root, an assert
that `ose --version` matches `^ose 1\.\d+\.\d+ \(`, and the artifact `ose-windows`. A second job
publishes to the rolling `latest` prerelease and runs only on a push to `main`; a
`workflow_dispatch` on any ref stops after the artifact. No macOS job: the macOS code in the Rust
sources stays, unbuilt.
