# Ose: the road to v1

The punch list. Hassan adds what is still obvious to him; an item is done when it is merged
and he has seen it in the installed app. When nothing is left under **UI polish**, we do
**Launch**.

## UI polish

- [ ] (add what you notice here)

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
