# lib

The rice's shared library: files that more than one module needs, living beside the modules
rather than inside one of them. Today that is `drills.js` and `drills.css`, the pieces the
Maths and Informatique modules both draw.

It exists because the two modules had written the same code twice — `h`, `append`, `clear`,
`duration`, `clockText`, `plural`, the eight-tone chip, the list row, the arrow keys, the
error box, the quiet link — and had then drifted apart on every one of them: two row heights,
two greys for the number, two meanings for the accent edge, two clocks ticking at two rates
into two files. One file, one look.

## The rules

- `lib/` imports only from `ose:*` and from its own folder. It never imports a module, and no
  module imports another module: a module imports `lib/`.
- It is plain ES modules and plain CSS. No bundler, no npm, no CDN, no inline script.
- Every colour, size and space is a token from the kernel's `ui.css`. No hex. No bare pixel
  beyond the 1px and 2px borders the design system already writes as numbers. Both themes.
- It draws; it does not decide. Nothing in `lib/` knows a file name, a route, a data shape or
  a module id. What to show is the module's business; how it looks is the lib's.
- It never touches the vault. No `ose.files`, no `ose.state`, no `ose.run`.
- A name is **added**, never changed in meaning. `drills.js` is written against
  `work/contracts/drills-lib.md`; a change in meaning would be a new name.
- Keyboard for everything: every list walks with the arrows, every menu opens with Shift+F10.

## How a module imports it

From a file in `modules/<name>/lib/`:

```js
import { h, clear, list, chips, tones, createClock, mountClock } from '../../lib/drills.js'
```

From the module's own entry (`modules/<name>/index.js`) it is `../lib/drills.js`. The rice is
served whole, so the path is a plain relative one in the browser and in the host alike
(`app://localhost/lib/drills.js`).

The stylesheet is not linked by the module. Call it once, from `activate` or from the first
mount:

```js
import { ensureStylesheet } from '../lib/drills.js'
ensureStylesheet()
```

It adds `<link data-shared="drills">` once and never removes it — the lib is shared, so the
module that deactivates cannot know whether the other one is still on screen. A module's own
stylesheet is still its own, still added and removed by its entry, and still wins where the
two meet (it is linked after).

## What is in `drills.js`

| group | names |
| --- | --- |
| DOM | `h` `append` `clear` |
| words | `plural` `duration` `clockText` `ymd` `stamp` `median` |
| chips | `tones` `chip` `chips` |
| the list | `list({ root, rows, onOpen, menu, empty })` |
| the clock | `createClock({ onTick, onBank, bankEvery, gapS })` `mountClock(clock, el, { budgetS })` |
| page pieces | `titleLine` `metaLine` `paneLabel` `controls` `verdict` `errorBlock` `pathLine` |
| the page | `focusMode(on)` `ensureStylesheet()` |

Two of these carry a rule worth knowing before you call them.

**`tones(names)`** assigns `t0`…`t7` by sorted position, never by a hash. A hash spreads bits,
not colours: with eight buckets and five family names, three of five came out the same pink.
Sorted position gives a list of up to eight names eight different colours, every time. Build
the map once for the page and pass it to every `chips()` call on it, so a name is one colour
on the list, in the meta line and in a table.

**`createClock`** is one object with one owner. The page that creates it stops it in `unmount`,
on every path, and `stop()` is the only thing that stops it — a pass, a pause and leaving all
go through it. It banks every ten ticks, so a reload costs ten seconds and not the visit; it
stops itself when the document goes hidden and starts again only if it was running; and a tick
that finds more than `gapS` since the last one drops the gap, so a closed lid does not come
back as an hour of work. Elapsed is always a `Date.now()` delta, never a tick count.

## The classes

Every one is prefixed `drill-`, and the full list is in the contract. The three that carry a
decision:

- `.drill-row.done` is an **opaque** ground: `--ok-soft` painted over `--bg` once by a flat
  gradient layer. It has to be opaque because a chip's own translucent ground stacked on a
  translucent row ground fell to 3.65:1 in dark.
- `.drill-chip` is opaque the same way, so a chip is the same colour on a plain row, on a done
  row and on a hovered row. Every tone measures ≥ 4.80:1 in light and ≥ 4.83:1 in dark, on
  both grounds; the table is in `work/reports/S.md`.
- `.drill-pane-label` has **no** rule under it. Whitespace groups; boxes, not rules.

Three more were settled after Q re-ran the reproductions, and each number here was measured
live in the page, in both themes:

- **Focus mode hides the sidebar without moving anything.** `html.drill-focus .sidebar` is
  `visibility: hidden` and the sidebar keeps its width, so the space stays held and
  `.page-col` — `margin: 0 auto` — sits at the same x before, during and after a session
  (356 px, 356 px, 356 px; the old `display: none` moved it 130 px). The subtree leaves the
  tab order with it, and the resizer goes too. The title bar's own fold is a different
  switch: it still folds for real, and it still works the moment a session ends.
- **A link inside the error block wears the block's ink.** `.drill-error .drill-link` is
  `--err-ink`, the head's own colour: on `--err-soft` the plain `--fg-3` reads 4.22:1 in
  light, under the line. 6.11 light / 5.10 dark at rest; hover goes to `--fg` (12.40 / 9.81),
  not to `--accent-ink`, which reads 4.44 there; disabled is `--fg-2` at full opacity
  (5.20 / 6.11) instead of an err ink faded to .7, which reads 2.55 / 3.16.
- **`.drill-clock.over` is `--warn-ink`**, not `--accent-ink`: the accent means "the one you
  are on" everywhere else in the app and says nothing about time. 6.25 light / 8.78 dark
  on `--bg`.

## Adding to it

Add a name, announce it in `work/inbox/M/` and `work/inbox/N/`, and write the reason in the
comment above it. Do not change what a name means: the two modules are written against these
shapes, and a silent change of meaning is a bug in a module nobody edited.
