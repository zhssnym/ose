# ose

ose is the desktop editor for a personal file tree. One window: a sidebar with the vault, a page
column that is either a markdown file in a block editor or a custom view, and a pane that runs
Claude Code on the same folder. It ships as a single binary placed at the root of the vault, so
moving the folder moves the editor with it.

The files are the database. Every page is a plain markdown file on disk, edited in place, with
line endings and formatting preserved; the editor keeps no index, no cache and no second copy of
anything. The only state it owns is its own (window bounds, theme, last route, sessions), and
that lives in a state file inside the vault. There is no sync, no account and no network call
apart from the Claude CLI's own.

The web UI is vanilla JavaScript with Vite and Milkdown Crepe. It talks to a host through one
small bridge API, documented in `CONTRACT.md`, and there are two implementations of that
bridge: a Node one used by the dev server, and the Tauri 2 host in `src-tauri/` (Windows and
macOS, described in `TAURI.md`). `DESIGN.md` holds the visual system.

## Running it in development

```
npm install
npm run dev
```

That serves the UI at http://127.0.0.1:5173 with a Node implementation of the bridge over the
real vault, with hot reload. Nothing is mocked: edits in the browser write to the files.

## Choosing the vault root

The dev server and `npm run ship` resolve the vault in this order:

1. the `OSE_ROOT` environment variable (`OS_ROOT` is still accepted as the older name),
2. `ose.config.json` at the root of this repository,
3. the parent folder of this repository, which is the layout when ose sits inside the vault.

`ose.config.json` is per machine and gitignored. Create it after cloning:

```json
{
  "root": "D:/os"
}
```

The built binary resolves its own root differently, at runtime: `--root <path>` if given, else the
folder holding the executable when that folder contains `CLAUDE.md`, else a walk up
from there, else `OSE_ROOT`.

## Building locally

The host is Tauri 2 (Rust). With a Rust toolchain installed (on Windows without admin rights:
rustup per user with the gnu host, plus MinGW from `winget install BrechtSanders.WinLibs.POSIX.UCRT
--scope user` for the linker tools):

```
npm run tauri:dev      # dev window against the Vite dev server
npm run tauri:build    # release binary in src-tauri/target/release/ (os.app on macOS)
npm run ship           # builds, then copies os.exe to <root>/os.exe
```

Local Windows builds link with MinGW; CI builds with MSVC. Both work; CI is the source of the
shipped binaries.

## Self-test

The host accepts `--selftest --root <vault> --log <file>`. It loads a page that calls every
bridge command against the given vault, writes one `PASS` or `FAIL` line per command to the log,
ends with `SELFTEST DONE` and closes the window. `ci/fake-vault/` is the fixture it runs against:
a tiny vault with a `.selftest` marker that allows the mutating commands to run.

## Releases

`.github/workflows/build.yml` builds on every push to `main` and `tauri` and on `v*` tags. The
Windows job produces `os.exe`, the macOS job an Apple silicon `os.app` zipped as
`os-macos-arm64.zip`, and both run the self-test against the fixture vault and fail on any `FAIL`
line. A release job then publishes exactly those two files:

- push to `main`: the rolling prerelease tagged `latest`,
- push to `tauri`: the rolling prerelease tagged `tauri-preview`,
- a `v*` tag: a normal release on that tag.

The rolling tags are deleted and recreated on each build so they point at the commit that
produced the binaries.

## Installing a build

Windows: download `os.exe`, put it at the root of the vault and run it. It needs the WebView2
runtime, which is part of Windows 11 and of any recent Windows 10; on a machine without it,
install the Evergreen runtime from Microsoft.

macOS: download `os-macos-arm64.zip`, unzip it and put `os.app` next to the vault folder. The app
is unsigned and unnotarised, so the first launch has to be right click, Open, then Open again in
the dialog. Double clicking it before that shows a warning that the developer cannot be verified.
Apple silicon only.
