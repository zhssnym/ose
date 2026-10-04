# Ose: the road to v1

The punch list. Hassan adds what is still obvious to him; an item is done when it is merged
and he has seen it in the installed app, and then it leaves this list.

## Before launch: decisions

- [ ] Releases: keep "every merge to main is a release", or release only on demand
      (a button in GitHub Actions) once v1 is out.

## Launch (v1)

- [ ] Version 1.0.0 in package.json and release.yml (from 0.9.<run>), one release with notes.
- [ ] Release files with stable names (`Ose-windows-setup.exe`, `Ose-mac.dmg`) beside the
      versioned ones, so a download link never goes stale.
- [ ] Landing page online: the Vercel project linked to the new repository, serving `site/`
      (ose.hassanshahir.com).
- [ ] Check on a Mac: the traffic lights over the title bar, the install, an update.
- [ ] Check an update end to end on Windows: installed version offers Restart, restarts newer.

## Later, maybe

- [ ] Snap Layouts on hover of the maximise button (Windows), if missed.
