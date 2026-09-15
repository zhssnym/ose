# App: Ose

## What this is

Ose (On Site Editor; the French imperative "dare") is a headless kernel and a folder of plain
files. The kernel is the executable, `ose.exe` or `Ose.app`: files, the watcher, processes,
routing, the editor components, the update loop, and no interface. The interface is the rice,
`<vault>/.ose/app`, plain ES modules and CSS edited in place like dotfiles and reloaded with
Ctrl+R. Workflows are modules inside the rice, native only, written against one versioned API
(`ose.api`), operating on data that stays where it is in the vault. A vault is any folder;
the files are the database; an agent (Claude Code, run on the vault from outside) reads and
edits the same files with no adapter, and writes modules against `docs/MODULES.md`.

The kernel ships as one portable file that normally lives at the root of its vault, asks for
a folder when it has none, shows one sentence when the vault has no rice, and updates itself
in place from the repo's `latest` release. There is no installer.

## Layout

```
README.md           one paragraph, Hassan's, not edited by the editor's tooling
docs/
  KERNEL.md         the hoses: everything a rice or a module can call, versioned as ose.api
  RICE.md           the interface as files: layout, loading, the fallback, the rules
  MODULES.md        a module: manifest, entry, lifecycle, rules, the template
  CONTRACT.md       the history of the interfaces, batch by batch, up to round three
  DESIGN.md         the visual system: tokens, components, the look
  TAURI.md          the host design
  OSE.md            the long-form introduction
cockpit/            the stock rice: index.html, shell/, keys.json, theme.css, modules/{day,week,month,journal,_template}
src/
  kernel/           ose:kernel (registry, bridge, router, links, sources, settings core, state,
                    theme, keys, watch, run, schedule, the module loader and its facade),
                    ose:ui (dialogs, pickers, menu, toast, icons; ui.css = tokens + base),
                    ose:md (the parsers)
  editor/           ose:editor: markdownPage, codeEditor, render (Crepe, CodeMirror, marked)
  bridge/, selftest.js   the host self-test page's own bridge
vite.kernel.config.js   builds the four bundles, the fallback page and the self-test into dist-kernel/
vite.config.js      the browser dev server: serves cockpit/ with ose:* aliased to the sources
dev/                bridge-plugin.mjs: the Node host for the browser; test-server.mjs
src-tauri/          the kernel's host in Rust: vault fs, watcher, run, the ose/app/vault origins,
                    the rice loader, single instance, self-update
ci/fake-vault/      the vault the self-test runs against in CI, with its own small rice
dist-kernel/, src-tauri/target/   build outputs, ignored
```

## How to run it

```
npm install
npm run build          # the kernel bundles into dist-kernel/ (0.5 s)
npm run dev            # http://127.0.0.1:5173: the stock rice in a browser over the Node host, vault D:\os
npm run dev:test       # http://127.0.0.1:5174, the same against work/vault (a throwaway copy)
```

The host (Tauri 2, Rust; rustup gnu per user, MinGW for the linker; `cargo` at
`~/.cargo/bin`): `cargo build --release` in `src-tauri`, then
`ose.exe --rice D:\ose\cockpit --root <vault>` to run the repo's rice, or plain `ose.exe`
beside a vault whose `.ose/app` holds one. `ose --no-rice` (or Shift at launch) shows the
fallback page; `ose --version`; `ose --update` runs the update loop with no window;
`ose --selftest --root ci/fake-vault --log <file>` runs the host self-test. The headless flags
run outside the single-instance group. Shipped binaries come from CI
(`.github/workflows/build.yml`): every push to `main` publishes `ose.exe` and
`ose-macos-arm64.zip` to the rolling `latest` release. See docs/TAURI.md.

A new vault starts by copying `cockpit/` to `<vault>/.ose/app`.

## Rules for working in this folder

- Read `docs/KERNEL.md` before touching the kernel, `docs/RICE.md` before the rice,
  `docs/MODULES.md` before a module, and `docs/DESIGN.md` before any UI. A hose is added,
  never changed in meaning; a breaking change is `ose.api = 2`. Every document lives in
  `docs/`; the root `README.md` is one paragraph and stays as it is.
- The kernel never draws. Its two pages (the fallback, the self-test) are the only HTML it
  ships. Nothing in the kernel knows a view, a module or a file name of the rice.
- The rice and the modules are plain files: no bundler, no npm, no CDN, no inline script
  (the CSP forbids it), imports only from `ose:*` and their own folder. A module reads and
  writes only under the folders its manifest names and keeps no data outside the vault.
- Markdown fidelity is non-negotiable. The editor must never rewrite a file it did not edit, and
  a user edit must not reformat the rest of the file. Hassan's conventions: `-` bullets, `_`
  emphasis, H1 and body text, no runs of blank lines, LF endings, UTF-8 without BOM.
- Never write to a real vault file while testing. Use `work/vault` and clean up.
- No new dependency without a reason written in the commit message. The kernel bundles carry
  Milkdown Crepe and kit, marked, DOMPurify and CodeMirror's language pack; the host has one
  plugin beyond Tauri's, single-instance.
- Colours, fonts and sizes come from the tokens in `ui.css` only. No hex values elsewhere.
  Spacing from the scale; no bare pixel paddings.
- Both themes, every time. Keyboard reachable, every time: every action has a command, every
  command is in the palette, and nothing needs the mouse.
- Minimal and old-school. Boxes, not rules; whitespace does the grouping; the same thing gets
  the same treatment everywhere. Leave room for the user.
- The app is English; file content is never translated.

## What is deliberately not here

- No AI surface. No terminal, no chat pane, no MCP server. Claude Code is run on the vault from
  outside; `CLAUDE.md` in the vault points at `docs/MODULES.md` and that is the integration.
- No interface in the binary, no marketplace, no third-party modules, no sandbox beyond the
  data and run guards. Every module is written against the contract by whoever owns the vault.
- No database, no index files, no cache of vault content on disk. Everything is recomputed
  from the files at startup.
- No sync, no accounts. One network call: the update check against the repo's own `latest`
  release, ten seconds after boot and every six hours, off by a switch in settings. `ose.run`
  starts programs, never the network.
- One page at a time in the column, with back and forward; the tab strip is the rice's list of
  open routes over that one route, not editors kept alive, and it is not restored on restart.
- No startup route. The app opens on the dashboard (one card per module) and the sidebar; the
  user picks. Nothing the user last looked at is restored.
- Every path the stock views read is a source in settings, each with a sentence saying what it
  must contain and a red `missing` when it does not exist.
- No drag-to-reorder in the tree: order comes from names. No math: a bare `$` stays a `$`.
- No installer and no code signing: a portable binary that swaps itself in place, trusting
  HTTPS to the repo's own release.
