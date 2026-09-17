# The module template

Copy this folder, and the copy is a working module: one command, one view, one tile, one
settings section, one stylesheet. Nothing here has to be deleted before it runs.

## What to change

1. `module.json`
   - `id` — the folder name, lowercase, `[a-z0-9-]`. The folder and the id must match.
   - `name`, `description` — what a person sees in settings.
   - `data` — every vault folder this module may read **and write**. Non-empty means only
     those folders; empty means read the whole vault and write nothing at all. The kernel
     refuses anything else, in the page and again in the host.
   - `run` — program names the module may start (`[]` means none), `routes` — the patterns it
     owns, `view` — the sidebar order of its view.
2. `index.js` — `HOME` at the top, then the four registrations in `activate`.
3. `template.css` — rename the prefix with the id.
4. `README.md` — this file: say what the module does and what it writes.
5. Add the id to the rice's `cockpit.json` `modules` array (the stock rice names its modules
   rather than listing the folder, which is one request instead of a directory walk).

## The rules that are not negotiable

- Import only `ose:*` and files inside this folder. Never the rice, never another module: two
  modules talk through `ose.bus` and commands.
- `activate(ose)` is handed the **facade**, not the kernel. Registration and subscription only;
  no process, no network, no heavy read — it runs while the window is opening.
- Read and write only under `data`. Module state lives beside the data it describes
  (`state.json`, `log.jsonl`), in a dotfolder when it should stay out of the tree.
- Draw only into the element you are handed. Never the sidebar, never the palette.
- Every action is a command; both themes; keyboard reachable; English UI.
- One stylesheet, added as a `<link>` in `activate` and removed in `deactivate`. Never
  `import './x.css'` — the rice has no bundler.

## What the kernel takes back for you

Commands, views, tiles, routes, settings sections, watches, schedules and running processes are
all tagged with the module id: `ose.modules.unload('<id>')` releases every one of them and then
calls `deactivate()`. What is left for `deactivate` is what you put in the document yourself —
here, the stylesheet.

## A module that throws

`activate` throwing is not fatal to anything but the module: whatever it registered is rolled
back, the module is listed as `disabled` with the reason in settings, a toast says so, and the
rest of Ose is untouched.

The full contract is `docs/MODULES.md` and `docs/KERNEL.md` in the Ose repository.
