# _lib

Plain files more than one plugin needs, living beside the plugins rather than inside one of them.
A name in `.ose/plugins` starting with `_` is never loaded, so this folder is not a plugin: it is
files, and a plugin imports one of them.

It exists because a plugin may never import another plugin (docs/PLUGINS.md rule 1) and because
the alternative is a copy per plugin that drifts: the two drill plugins had written the same row,
the same clock and the same chip twice, and had ended up with two row heights, two greys and two
clocks ticking at two rates.

## What is here, and who imports it

| file | what | imported by |
| --- | --- | --- |
| `table.js`, `table.css` | `drillTable(el, { columns, rows, onOpen, empty })`: the bordered, square table both drill indexes are, one tab stop, the keyboard starting on the row marked `here` | maths, nsi |
| `drills.js` | the drill page: DOM helpers (`h`, `append`, `clear`), words (`plural`, `duration`, `clockText`, `stamp`), `errorBlock`, `createClock` and `mountClock`, `titleLine`, `metaLine`, `paneLabel`, `controls`, `verdict`, `focusMode`, `ensureStylesheet` | maths, nsi |
| `drills.css` | every rule those pieces need, all prefixed `drill-`; linked by `ensureStylesheet()`, never by a plugin | maths, nsi |
| `timetable.js` | `TIMETABLE` (the grid constants) and `parseTimetable`: one H1 per weekday, one line per block | day, week |
| `plans.js` | the monthly plan and the systems log: `planDir`, `planPath`, `resolvePlanPath`, `isGoalLabel`, `isGapLine`, `parseMonthlyPlan`, `parseHabits`, `applies`, `parseSystemsLog` (alias `parseSystems`), `logKey`, `systemsFor` | day, month |
| `tasks.js` | the task line: `TASK_MARK`, `PRIORITY_RANK`, `parseTaskLine`, `parseTasks`, `toggleTaskLine` | day |
| `nav.js` | the `‹ today ›` group of a chronological view and its keys: `navHtml`, `bindNav` | day, month |
| `view.js` | `pathInto(ose, key, el)`: `ose.paths.get` with the part left holding the kernel's box and nothing stale beside it | day, week, month, journal |
| `view.css` | the typography of a view, one rule: `.view-title` on a view's `<h1>`, `.view-prose` on anything drawn out of the vault's own words, the chrome for everything else. Imported, not linked: `@import '../_lib/view.css';` is the first line of every plugin's `style.css` | all six |

## The rules

- `_lib` imports only `ose:*` and its own folder. It never imports a plugin, and it never reaches
  into one.
- Plain ES modules and plain CSS. No bundler, no npm, no CDN.
- Every colour, size and space is a token from the kernel's `ui.css`. No hex, no bare pixel
  beyond the 1px and 2px borders the design system already writes as numbers. Both themes.
- `drills.js` and `view.js` draw; they do not decide. Nothing there knows a file name, a route or
  a plugin id. The parsers know a **format** and nothing else: pure text in, data out, no DOM and
  no vault path.
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
import { h, clear, list, chips, tones, createClock } from '../../_lib/drills.js'
```

The drills stylesheet is not linked by the plugin. Call it once, from `activate` or from the
first mount:

```js
import { ensureStylesheet } from '../_lib/drills.js'
ensureStylesheet()
```

It adds `<link data-shared="drills">` once and never removes it: the file is shared, so the plugin
that deactivates cannot know whether the other one is still on screen. A plugin's own `style.css`
is still its own, linked and unlinked by the loader, and still wins where the two meet.

## Two rules worth knowing before you call them

**`tones(names)`** assigns `t0` to `t7` by sorted position, never by a hash. A hash spreads bits,
not colours: with eight buckets and five family names, three of five came out the same pink.
Sorted position gives a list of up to eight names eight different colours, every time. Build the
map once for the page and pass it to every `chips()` call on it, so a name is one colour on the
list, in the meta line and in a table.

**`createClock`** is one object with one owner. The page that creates it stops it in `unmount`, on
every path, and `stop()` is the only thing that stops it: a pass, a pause and leaving all go
through it. It banks every ten ticks, so a reload costs ten seconds and not the visit; it stops
itself when the document goes hidden and starts again only if it was running; and a tick that
finds more than `gapS` since the last one drops the gap, so a closed lid does not come back as an
hour of work. Elapsed is always a `Date.now()` delta, never a tick count.

## Three decisions in `drills.css`

- `.drill-row.done` is an **opaque** ground: `--ok-soft` painted over `--bg` once by a flat
  gradient layer. It has to be opaque because a chip's own translucent ground stacked on a
  translucent row ground fell to 3.65:1 in dark.
- `.drill-chip` is opaque the same way, so a chip is the same colour on a plain row, on a done row
  and on a hovered row. Every tone measures at least 4.80:1 in light and 4.83:1 in dark, on both
  grounds.
- `.drill-pane-label` has **no** rule under it. Whitespace groups; boxes, not rules.

Focus mode takes the sidebar out of the layout: `html.drill-focus .sidebar` is `display: none`,
the same switch and the same two elements as the shell's own fold, so the main area during a
session IS the window and a session centred in it is centred on the window. It was
`visibility: hidden` until the fourth wave, which held the sidebar's 260px and put the maths
question on x = 794 of a 1328px window whose middle is 664 — the "not centred" the owner saw.
The price is that the column moves sideways when a session starts and ends, which is a mode
change and is allowed to look like one. The subtree leaves the tab order with it, and the
resizer goes too. The title bar's own fold is a different switch and still folds for real.
