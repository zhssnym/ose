# The plugin template

Copy this folder into `<vault>/.ose/plugins/`, rename it, press Ctrl+R. The copy runs as it is:
one command, one view, one tile, one settings section, one stylesheet. Nothing has to be deleted
first. A name starting with `_` is never loaded, which is why this copy is inert where it sits.

What to change, in order:

1. `index.js`: `name` and `description` (what a person sees on the home card and in Settings),
   then `paths`: the name of the folder or file this plugin needs, and one sentence of `hint`
   saying what must be in it. Never write a path.
2. `index.js`: the view's `title` and `order` (the stock six use 10 to 60), then the four
   registrations at the bottom of `activate`. Delete what you do not need.
3. `style.css`: rename the `.tpl-` prefix to your own.
4. This file: say what the plugin does and what it writes.

The whole contract is `docs/PLUGINS.md` in the Ose repository.
