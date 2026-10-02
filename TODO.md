# Ose: the road to v1

The punch list. Hassan adds what is still obvious to him; an item is done when it is merged
and he has seen it in the installed app. When nothing is left under **UI polish**, we do
**Launch**.

## UI polish

Wave 2 (2026-10-02):

- [ ] Focus mode not shown anywhere: no chip at the top, no "Focus:" label in the sidebar.
- [ ] Title bar like VS Code: only back/forward and a centred box with the current place
      (click it: Go to file). No sidebar chevron, no logo, no "+".
- [ ] A better way to collapse the sidebar (toggle at the right of the title bar, drag the
      edge closed, Ctrl+\).
- [ ] Drag-select: press beside the blocks and drag a rectangle to select blocks, images,
      attachments.
- [ ] Click an image to see it enlarged.
- [ ] Settings › Help: how to use Ose, and every shortcut.
- [ ] No browser leftovers ("Open in a browser tab" and the like).

Found during the tidy-up:

- [ ] Go to file shows "Shift+Enter makes the file" at its foot: a shortcut hint outside Help.
- [ ] Settings › Planner: rename to match `views` (or keep "Planner" as the word users see).
- [ ] The dev build calls itself 1.0.0 (src-tauri's version) and offers the old 1.0.3 release:
      one version for the page and the host, from package.json.
- [ ] A link to a folder (a page route that turns out to be a folder) reveals it in the
      sidebar but then still hands the folder to the editor (router.ts `mountPage`: no return
      after `tree:reveal`).
- [ ] Leftovers to cut: the router's `start` option (the column is just blank with no tab),
      `ose.vault.onChange` (never fires), `reopenClosed` alias, the one-time `migrateLocal`
      that still runs at every boot.
- [ ] The host's version is Cargo.toml's 1.0.0 (`--version`, the log, `platform()`); the build
      stamp (`OSE_BUILD_SHA`/`OSE_BUILD_DATE`) is never set, so every release says "(dev build)".
- [ ] File history an older Ose kept in the vault's `.ose/history` is never read or moved to the
      app's data folder now (versions.rs).
- [ ] Opening a file from the OS when no window is on its vault: vault detection looks for a
      `.ose/` marker the app no longer creates, so the file opens as "outside vault".
- [ ] A moved or renamed vault starts with no state, versions or drafts (the key is the path).
- [ ] Drag-out leftovers: `drag.png`, `platform().dragIcon`, a "Drag out" comment, no plugin.

## Before launch: decisions

- [ ] Signing for strangers: Apple Developer account ($99/year) to notarize the Mac app, or the
      landing page explains "Open Anyway". Windows SmartScreen warns until the app has a
      download history either way.
- [ ] History: keep it and tag v1.0.0 (recommended), or squash once into a single commit (also
      removes the old commit email from the public history).
- [ ] Releases: keep "every merge to main is a release", or release only on demand
      (a button in GitHub Actions) once v1 is out.

## Launch (v1)

- [ ] Version 1.0.0 in package.json and release.yml (from 0.9.<run>), one release with notes.
- [ ] Release files with stable names (`Ose-windows-setup.exe`, `Ose-mac.dmg`) beside the
      versioned ones, so a download link never goes stale.
- [ ] Landing page: a static page in `site/`; the Vercel project builds only that folder
      (ose.hassanshahir.com), with direct download buttons.
- [ ] Delete the old `latest` pre-release (the Sep 26 desktop build) from the releases page.
- [ ] Check on a Mac: the traffic lights over the title bar, the install, an update.
- [ ] Check an update end to end on Windows: installed version offers Restart, restarts newer.

## Later, maybe

- [ ] Files outside the vault (Open file…): cut or keep.
- [ ] Drag files in from Explorer/Finder: cut or keep.
- [ ] Snap Layouts on hover of the maximise button (Windows), if missed.
- [x] Tidy the house (branch `tidy`): dead code out, `src/ui`, `src/views`, the shell in
      TypeScript in `src/shell`, one Vite build, no `ose:*` nicknames, docs rewritten.
