# _lib

Plain files more than one plugin needs, living beside the plugins rather than inside one of them.
A name in `.ose/plugins` starting with `_` is never loaded, so this folder is not a plugin: it is
files, and a plugin imports one of them.

It exists because a plugin may never import another plugin (docs/PLUGINS.md rule 1) and because
the alternative is a copy per plugin that drifts: day and week had written the same block, the
same hour column and the same chip twice, and had ended up with two row heights and two greys.

## What is here, and who imports it

| file | what | imported by |
| --- | --- | --- |
| `timetable.js` | `TIMETABLE` (the grid constants) and `parseTimetable`: one H1 per weekday, one line per block | day, week |
| `plans.js` | the monthly plan and the systems log: `planDir`, `planPath`, `resolvePlanPath`, `isGoalLabel`, `isGapLine`, `parseMonthlyPlan`, `parseHabits`, `applies`, `parseSystemsLog` (alias `parseSystems`), `logKey`, `systemsFor` | day, month |
| `tasks.js` | the task line: `TASK_MARK`, `PRIORITY_RANK`, `parseTaskLine`, `parseTasks`, `toggleTaskLine` | day |
| `nav.js` | the `‹ today ›` group of a chronological view and its keys: `navHtml`, `bindNav` | day, month |
| `view.js` | `pathInto(ose, key, el)`: `ose.paths.get` with the part left holding the kernel's box and nothing stale beside it | day, week, month, journal |
| `view.css` | the typography of a view, one rule: `.view-title` on a view's `<h1>`, `.view-prose` on anything drawn out of the vault's own words, the chrome for everything else. Imported, not linked: `@import '../_lib/view.css';` is the first line of every plugin's `style.css` | all four |

## The rules

- `_lib` imports only `ose:*` and its own folder. It never imports a plugin, and it never reaches
  into one.
- Plain ES modules and plain CSS. No bundler, no npm, no CDN.
- Every colour, size and space is a token from the kernel's `ui.css`. No hex, no bare pixel
  beyond the 1px and 2px borders the design system already writes as numbers. Both themes.
- `view.js` draws; it does not decide. Nothing there knows a file name, a route or a plugin id.
  The parsers know a **format** and nothing else: pure text in, data out, no DOM and no vault
  path.
- Nothing here touches the vault. No `ose.files`, no `ose.state`, no `ose.run`. `view.js` takes
  the `ose` it is handed as an argument and calls `paths.get` on it; it holds none.
- A name is **added**, never changed in meaning: the plugins are written against these shapes,
  and a silent change is a bug in a plugin nobody edited.
- Keyboard for everything: every list walks with the arrows, every menu opens with Shift+F10.

## How a plugin imports it

From the plugin's own entry, `../_lib/<file>.js`; from a file one folder deeper,
`../../_lib/<file>.js`. Both are ordinary relative URLs on the app origin
(`<app origin>/plugins/_lib/<file>.js`), served from `<vault>/.ose/plugins/_lib/` like any plugin
file.

```js
import { parseTimetable, TIMETABLE } from '../_lib/timetable.js'
import { pathInto } from '../_lib/view.js'
```

A plugin's own `style.css` is still its own, linked and unlinked by the loader, and still wins
where it and `view.css` meet.
