# Ose: design system

Read this before writing any UI. The shell, the editor and the views must look like they were
made by one hand.

**Vocabulary.** The **shell** is the interface: title bar and tabs, sidebar, status bar,
palette, search, Settings (docs/SHELL.md). A **view** is a page of the app's own rather than a
file: Home, Settings, Execution, Planner, Journal. A **page** is a file open in the editor.

## The brief

A file tree and an editor that feel like one calm desktop program. The chrome is quiet, near
black and white, and talks about the files, never about the machinery; the page is the thing on
screen. Colour is rare and always means something.

## Personality

- **Space.** The page column is 720px wide, centred, with 80px of air above a view's title (a
  document takes 48px; see "A page as a document"). Every padding, margin and gap is a step of
  the spacing scale (`--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 24, `--sp-6` 32,
  `--sp-7` 48; `--sp-half` 2 for a deliberate optical nudge, with a comment saying why). A bare
  pixel value in a stylesheet is a bug unless it is geometry and says so.
- **Boxes, not rules.** Whitespace groups things. A 1px hairline is the edge of a box or the
  bottom of a bar, never a ladder of dividers between rows. The same kind of thing gets the same
  component: one bar height (`--panelhead-h`; `--barhead-h` for the palette's input row and a
  dialog's foot), one row height (`--row-h`), one section label, one empty state.
- **Precision.** 1px hard borders. `--radius` is 2px and that is the maximum anywhere. No drop
  shadows except on floating menus and the palette, which use a 1px border plus
  `--shadow-menu`, never a soft glow.
- **Typefaces, strict roles.**
  - Chrome (sidebar, tabs, status bar, settings rows, dialog buttons): `--font-ui` at `--fs-ui`.
  - What is literally code or a path (a key cap, a line number, a search hit, the status bar's
    path, a size): `--font-mono` at `--fs-chrome` or `--fs-chrome-sm`.
  - Dialog and view content: `--font-ui` at `--fs-content`.
  - `--font-title`, the serif, for the chrome's own page title (`.page-title`, e.g. Settings).
  - Page content, and only page content: `--font-doc`. See "A page as a document".
- **Colour.** Neutral surfaces: warm paper in light, Notion-like neutral greys in dark. One
  accent, terracotta (`--accent`), used sparingly for the current or interactive thing: a focus
  ring, a primary button, the current row's glyph, a drop target. Olive means success, amber
  attention, brick error. Never decorate with colour.
- **Flat.** No gradients, no glass, no pills, no emoji as icons. Icons are 16px stroked SVG,
  1.5px stroke, `currentColor`, inline, and sparse.
- **Motion.** `--t-fast` (120ms ease-out) on hover and open states, nothing longer, no bouncing
  or slides. `prefers-reduced-motion` sets it to 0.
- **Sentence case everywhere.** Labels, headings, buttons and section names: "Show hidden
  items", "Go to file". Nothing uppercased by CSS, no letter-spacing on labels. The chrome never
  shows an internal word: no route key, no host kind, no `READY`.
- **Real names.** A file is shown under its real name, extension and all, the same in the tree,
  the tab, the status bar, the window title, Go to file and search. Settings' "Hide .md in names"
  strips `.md` for display only. A page's H1 is not a second name for its file.

## Tokens

Every colour, font and size comes from `src/ui/styles/tokens.css`; the shared components are in
`src/ui/styles/base.css`; `src/ui/ui.css` imports both. No hex value anywhere else (the one
exception is `src/editor/print.css`, which turns the palette black on white for paper). The
shell's `src/shell/theme.css` is the one place a token is overridden, and it is empty.

Light is on `:root`, dark on `:root[data-theme="dark"]`. `first-paint.ts` sets the theme before
the first frame and the core keeps it after. With nothing chosen the theme is System and follows
the computer. `:root[data-os="mac"]` swaps the font stacks for the Mac's own.

```
--bg --bg-2 --bg-3 --bg-4    page, sidebar and bars, hover and chips, selected
--fg --fg-2 --fg-3           text, secondary, muted (each measured >= 4.5:1 where it is used)
--border --border-strong     1px lines, emphasised lines and scrollbar thumbs
--accent --accent-hover --accent-fg --accent-soft --accent-ink   the one accent
--ok --warn --err --info (+ -soft, -ink)   semantic; -ink is text on the -soft ground
--amber --c-*                the views' families (week grid)
--code-*                     syntax colours, each >= 4.5:1 on --bg and --bg-2 in both themes
--font-ui --font-mono --font-title --font-doc --font-math
--fs-chrome-sm 11  --fs-chrome 12  --fs-ui 13  --fs-content 15  --fs-body 16  --fs-title 34
--lh-body                    1.25, 1.35 (default) or 1.5, from Settings
--fs-doc-title --fs-doc-h1 --fs-doc-h2       1.4x, 1.2x, 1.1x the body
--doc-gap --doc-gap-head --doc-gap-label --doc-indent --doc-pad-*   the document rhythm, in em
--doc-bar --doc-frame --doc-rule --doc-title-rule                   the document's lines
--radius 2px  --titlebar-h 36  --statusbar-h 22  --panelhead-h 32  --barhead-h 44
--row-h 28  --ctl-h 28  --sidebar-w 260px  --page-w 720  --page-pad-top 80  --doc-pad-top 48
--print-margin --print-measure --print-fs --print-lh                paper
--shadow-menu --scrim --t-fast --focus
```

Every size a person reads is in rem, and the root font size is `--zoom` (90 to 150 %), so the
whole window scales; at 100 % each is the pixel value named above. Hairlines, radii and the
sidebar's width stay in px.

## Components

- **Button** (`.btn`). `--ctl-h` tall, 1px `--border`, `--bg`, mono `--fs-chrome`. Hover
  `--bg-3`. Primary: `--accent` ground, `--accent-fg` text. `.sm` is the small one in settings
  rows. Focus: the `--focus` ring. Disabled: 50 % opacity, no hover.
- **Input** (`.input`). Same height and border as a button, `--font-ui`; focus border `--accent`.
- **Chip** (`.chip`). 20px, mono 11px, `--bg-3`, 1px `--border`. Semantic chips sit on the
  `-soft` ground with the `-ink` text.
- **List row** (`.row`, palette and pickers). `--row-h`, hover `--bg-3`, current
  `--accent-soft` with a 2px `--accent` bar on the left, active (keyboard) `--bg-4`. Never a
  rounded highlight.
- **Tree row** (sidebar). `--row-h`, folders in `--fg`, files in `--fg-2`. The current file is
  `--fg` with its glyph in `--accent`; a selected row is `--bg-4`; hidden items and links are
  greyed in `--fg-3`.
- **Section label** (`.section-label`). `--fs-chrome-sm`, sentence case, `--fg-3`: "Views",
  "Vault", "Scratchpad". In focus mode the Vault label becomes "Focus" in `--accent` plus the
  folder's name and a × that leaves it: same row, no extra line.
- **Panel header** (`.panel-head`). `--panelhead-h`, title left, actions right.
- **Scrollbars.** 12px, square `--border-strong` thumb, no buttons, transparent track
  (`--bg-2` in the sidebar). The tab strip has none; it scrolls with the wheel.
- **Tooltips** (`[data-tip]`). Mono 11px, `--fg` on `--bg-3`, 1px border, no arrow, 300ms delay.
- **Empty states** (`.empty`). One short sentence in `--fg-3`, centred. No illustrations.
- **Tabs.** Small cards in the title bar, text in `--fg-3`; hover `--bg-3`; the active tab
  sits on `--bg-3` in `--fg`. The close × shows on every card. A tab being dragged is faded; a
  file dragged from the sidebar shows a ghost tab with a dashed `--border-strong` outline. The
  last Home tab shakes when asked to close.
- **The error mark.** A page that could not be saved, or changed on disk under unsaved text,
  wears a 7px square in `--err` on its tab, square so it does not depend on telling colours
  apart, with the editor's sentence as the tooltip; the name turns `--err-ink`. Unsaved changes
  get no mark: the status bar says so in words.
- **Status bar.** `--statusbar-h`, `--bg-2`, top hairline, `--fs-chrome-sm` in `--fg-3`. Fields
  are separated by a `·`. The mode choice (Rich · Source) lights the current one in `--fg`. A
  bad save state is a button in `--err` or `--warn`. The path at the right is mono, cut at its
  start, `--fg` on hover.
- **The page banner** (`.ed-banner`). One sticky box at the top of the page column with the
  editor's sentence and its actions as buttons: `--err-soft`, `--err`, `--err-ink` and
  `role="alert"` for a page that is not saved; `--warn-soft`, `--warn`, `--warn-ink` for a
  notice. Never more than one.
- **Outside the vault.** Said in words, never a colour: "outside vault" after the name on the
  tab, `--fs-chrome-sm` in `--fg-3`, with the absolute path as the tooltip.
- **Drop target.** The folder row a drop would land in: `--accent-soft` with a 2px `--accent`
  bar inside its left edge.
- **Sticky error.** An error the user must act on is a toast with no timer, a close button and
  real buttons for its actions, `role="alert"`. Information toasts leave on their own.
- **The file card.** A file Ose does not show (image, PDF, binary) gets one box in the page
  column on `--bg-2`: the name in mono, size, type and date, one sentence, and the ways out as
  buttons, the first one primary.
- **Side panel.** A resizable column right of the page, `--bg-2`, a left hairline, a panel
  header with the title and a close button. Search lives in it: a field, one line of counts in
  `--fg-3`, hits grouped under a file line, each hit a mono row with the terms in bold
  `--accent-ink` and the line number as its hint.
- **Settings.** A view: the section list on the left as list rows, the section's title, and its
  rows on the right. A row is the name and its control on one line and one sentence under it in
  `--fg-3`. Controls are segmented buttons (`.seg`, one hairline box, the pressed segment on
  `--accent`). Rows are grouped by whitespace, never by rules.
- **The boot error page.** One column, at most 44rem: the title in `--err`, how far the boot got,
  the error in a box on `--err-soft`, the log path in mono, the stack under a disclosure, **Copy
  details** and **Try again**. Every colour there has a system colour behind it, because the
  stylesheet may be what failed.

## Layout

```
+-------------+--------------------------------------------------+
| mark    [<] | tab | tab | +                         _  []  x   |  title bar, --bg-2
+-------------+-------------------------------+------------------+
| sidebar     | page column, --bg             | side panel       |
| 260px       | 720px, centred                | (search)         |
+-------------+-------------------------------+------------------+
| status bar, --bg-2                                             |
+----------------------------------------------------------------+
```

There is no system title bar on Windows and Linux: the title bar is ours, `--titlebar-h`,
`--bg-2` with a bottom hairline. Its corner over the sidebar is as wide as the sidebar and
carries its right border up. On Windows and Linux the window buttons are flat, the bar's full
height, with close turning `--err` on hover; on macOS the traffic lights sit over the bar's
left end. The window is at least 480 by 360; under 640px the sidebar folds away and the title
bar and the page fit without overflowing, in both themes.

## A page as a document

A page the user wrote is a document, not a web page. The reference is a maths handout typed in
Word: one serif face, compact, justified, rigid, square. It applies to page content and nothing
else: the editor's column, the page title, everything drawn through `render()` (a journal entry
in a view), and paper. The chrome around it keeps `--font-ui` and `--font-mono`.

- **Face.** `--font-doc` (Cambria on Windows, Iowan Old Style on a Mac) for body, headings and
  title. Code keeps `--font-mono`. Settings' Page face `Plain` sets `data-face="plain"` on
  `<html>`, which makes `--font-doc` resolve to `--font-ui`; only the family moves.
- **Space.** A run of N blank lines between two blocks is N minus 1 empty paragraphs, each a real
  block the caret goes into. Enter twice leaves one line of space, as in Word. An empty
  paragraph is one line tall and carries no marker, rule or padding.
- **Size and leading.** The body is Settings' Text size (16px by default) at `--lh-body`;
  everything else is a ratio of the body.
- **Scale.** Title `--fs-doc-title`, bold, centred, in a `--doc-title-rule` double rule, square,
  `width: fit-content`. H1 `--fs-doc-h1` bold, H2 `--fs-doc-h2` bold, H3 bold at body size, H4
  and below bold italic. No second family, no grey heading.
- **Rhythm.** `--doc-gap` between paragraphs, `--doc-gap-head` above a heading, `--doc-gap-label`
  above a paragraph that opens with a bold run-in label. No gap against the inside of a frame,
  a cell or a list item.
- **Alignment.** Justified, `hyphens: none`. List items and table cells read left.
- **Lists.** Items touch. The marker hangs in `--doc-indent`: a dot, a hollow ring one level
  down, `1.` right-aligned for ordered lists. A task row takes a little more indent.
- **Frames and bars.** `>` is a bar: `--doc-bar` solid `--fg` down the left, italic, no tint.
  `>>` (a blockquote in a blockquote) is a frame: a square `--doc-frame` box, upright. `---` is a
  `--doc-rule` in the text colour. A table is a real grid of `--doc-rule` lines, header cells
  bold on no background.
- **Corners.** `border-radius: 0` on everything in page content; `--radius` is the chrome's,
  and a task checkbox keeps it because it is a control.
- **Links** underlined, `--accent-ink` on screen, the text colour on paper.

Task checkboxes are 16px squares, 1px `--border-strong`, filled `--accent` with a check when
done, the text struck through in `--fg-3`. Images take the column width with a 1px border. The
block handle and the slash menu sit in the left gutter, on hover only, in the chrome's face.

## Print and PDF

`page.export-pdf` (Ctrl+Alt+P) opens the print dialog with the page's title as the document's
name; `page.print` opens it as it is. `src/editor/print.css` holds every `@page` and
`@media print` rule and turns the palette black on white from either theme. `@page` is A4 with
`--print-margin`; the body is `--print-fs` of `--font-doc` at `--print-lh`, about 52 lines a
sheet. Only page content prints: no chrome, no handles, no placeholders. Headings keep with
what follows; frames, bars, display formulas and pictures do not break inside; tables and code
blocks break between rows and lines. A picture is capped short of the sheet so its label stays
with it. The sheet number is in the bottom margin, mono 9pt.

The page view (Settings › Appearance › Page layout, or `app.layout`) shows the same A4 sheet
while writing, on a `--bg-3` desk, with the print margin, size and leading, so lines break where
they will on paper. `src/editor/sheets.ts` draws a dashed rule where each sheet ends, as an
overlay: nothing in the document moves.

## Code

One set of colours everywhere code is shown (a fence in a page, a code file, rendered
markdown): the `--code-*` tokens, from the palette's own families. Keywords in terracotta,
strings olive, types amber, functions blue, numbers purple; an identifier with no role keeps the
body colour. A code file is a small editor and says so: line numbers, a `--bg-3` stripe under
the caret's line, the matching bracket on `--bg-4`. A page of prose has none of them.

## Views

The same page column as a page. A view's title is the document face at `--fs-doc-title`, bold,
left, with no box: the box belongs to a document's own title. The view's controls, labels,
counts and tables keep the chrome faces. The views' furniture is `src/views/views.css`, which
names no family and sets no size in px. A note a view shows goes through `render()` and is a
document like any other. A view whose file is not chosen yet says so in one quiet line pointing
at Settings › Views, never in a red box. Dense data (the week grid) uses mono 11px labels and
1px `--border` lines; colour blocks use the `--c-*` families at low opacity with a 2px bar in
the full colour.

## Language

The UI is English; file content is never translated. Labels are short and in sentence case. A
sentence names what really happens: "the Recycle Bin" when it is the Recycle Bin, "`.trash` in
this vault" when it is that.

## Before a surface is done

- Both themes checked; no colour that is not a token.
- Keyboard: every action reachable, focus visible, Esc closes what Enter opened.
- Hover on every interactive element, at `--t-fast`.
- Nothing wraps or clips at 1280x800, nothing breaks at 1024x700, 2560x1440 or 480x360.
- No console errors, no layout shift when data loads (reserve the space, then fill it).
