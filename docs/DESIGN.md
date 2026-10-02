# Ose: design system

Read this before writing any UI. The app, the shell, the editor and the planner must look like
they were made by one hand.

**Vocabulary.** The **app** is Ose in Chrome, the whole thing. The **shell** is the interface inside
it: toolbar, path bar, tabs, sidebar, folder view, palette, search, settings. The
**planner** is Day, Week, Month and Journal, built into the app (`src/planner`). A **view** is a
page of the app's own (Settings, Trash, the planner's four) rather than a file.

## The brief, in one line

A file manager and an editor that feel like one calm program: Explorer's openness, Notion's
space, the precision of a well-made desktop application, in Claude's colours. Nothing in the
chrome talks about the machinery; it talks about the files.

## Personality

- **Space.** The chrome breathes. The page column is 720px wide, centred, with 80px of air above
  a view's title (a page of the user's own writing is a document and takes 48px; see "A page as
  a document"). Nothing is cramped, ever. Every padding, margin and gap is a step of the spacing scale
  in `tokens.css` (`--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 24, `--sp-6` 32,
  `--sp-7` 48; `--sp-half` for a deliberate 2px optical nudge, with a comment saying why). A
  bare pixel value in a stylesheet is a bug unless it is geometry and says so. Panels sit at `--sp-3` to `--sp-4`.
- **Boxes, not rules.** Whitespace groups things. A 1px hairline is for the edge of a box or the
  bottom of a bar, never a ladder of dividers between rows. Two things that are the same kind
  of thing get the same component: one bar height (`--panelhead-h`, or `--barhead-h` for the
  palette's input row and a dialog's foot), one row height (`--row-h`), one section label, one
  empty state.
- **Precision.** 1px hard borders. Square corners: `--radius` is 2px and that is the maximum
  anywhere (menus, buttons, inputs, cards, chips). No drop shadows except on floating menus and
  the command palette, and those use a hard 1px border plus a flat offset shadow
  (`0 8px 24px rgba(0,0,0,.18)`), never a soft blur glow.
- **Four typefaces, strict roles.**
  - Chrome (the tree, the tabs, the path bar, settings rows, buttons in a
    dialog): `var(--font-ui)` at `--fs-ui`, in sentence case.
  - Things that are literally code or a path (a path in a note, a key cap, a search hit's line,
    a line number, a size in a column): `var(--font-mono)` at `--fs-chrome` or `--fs-chrome-sm`.
  - A view's own content, and every dialog: `var(--font-ui)` at 15px, line-height 1.6.
  - A view's title: `var(--font-title)` (a serif, Claude's brand voice). Never use it elsewhere.
  - Page content, and only page content: `var(--font-doc)`, Cambria. See "A page as a document".
- **Claude's colours, exactly.** Terracotta accent `#D97757` is the only saturated colour in the
  chrome. Kraft `#D4A27F` for secondary warmth. Ivory/paper surfaces in light mode, near-black
  warm surfaces in dark mode. Colour means something: accent = interactive or current, olive =
  success or done, amber = attention, brick = error. Never decorate with colour.
- **Flat.** No gradients, no glassmorphism, no rounded pills, no emoji as icons. Icons are
  16px stroked SVG, 1.5px stroke, `currentColor`, drawn inline. Keep them sparse.
- **Motion.** 120ms ease-out on hover and open states, nothing longer. No bouncing, no slides.
  Respect `prefers-reduced-motion`.
- **Sentence case, everywhere** (M27). Labels, headings, buttons, section names and group
  headings start with a capital and go on in lower case: "Show hidden items", "Recent", "Go to
  file". Nothing is uppercased by CSS and no label is letter-spaced. The chrome never shows an
  internal word: no `READY`, no `watch on`, no `view ›`, no host kind, no route key.
- **Real names.** A file is shown under its real name, extension and all, the same in the tree,
  the tab, the path bar, the window title, Go to file and search (W8). Settings' "Hide .md in
  names" strips `.md` for display only. A page's H1 is not a second name for its file.

## Tokens

All colours, fonts, and sizes come from `src/ui/styles/tokens.css`, served as part of
`ui.css`. Never write a hex colour in any other stylesheet; the shell's `theme.css` is the one
place a token is overridden. Light is on `:root`; dark is `:root[data-theme="dark"]`. The theme
attribute is set by `first-paint.js` before the first frame and by the core after it. The
default is **System**: with nothing chosen, the window follows the computer's light or dark
setting and changes when it does (M26).

Key tokens (see the file for the full list):

```
--bg          page surface            --fg      primary text
--bg-2        sidebar / panels        --fg-2    secondary text
--bg-3        hover, chrome, chips    --fg-3    muted text, placeholders
--border      1px lines               --border-strong  focused or emphasised lines
--accent      terracotta              --accent-fg  text on accent
--accent-soft tinted accent surface   --sel     text selection
--ok --warn --err --amber             semantic
--font-ui --font-mono --font-title --font-doc
--radius (2px)  --titlebar-h (36px)  --sidebar-w (260px)
--page-w (720px)  --page-pad-top (80px)  --doc-pad-top (48px)
--fs-doc-title (1.4x body)  --fs-doc-h1 (1.2x)  --fs-doc-h2 (1.1x)
--doc-gap (.3em)  --doc-gap-head (1.1em)  --doc-gap-label (.7em)  --doc-indent (1.4em)
--doc-pad-frame  --doc-pad-cell  --doc-pad-title
--doc-bar (2px)  --doc-frame (1.5px)  --doc-rule (1px)  --doc-title-rule (3px)
              the document scale and rhythm; the em ones follow the body size and the leading
--print-margin (2cm)  --print-measure (17cm)  --print-fs (11.5pt)  --print-lh (1.2)
--code-key --code-str --code-num --code-fn --code-type --code-var --code-punc --code-com
--code-ins --code-del
              code highlighting, each measured >= 4.5:1 on --bg and on --bg-2 in both themes.
              --code-ins and --code-del are a diff inside a fence, and --code-del also carries
              a token no grammar could read, under a wavy underline
--zoom        the root font size factor (90 to 150 %); every size token is written in rem so
              the whole window scales, and at 100 % each is the pixel value it names
```

## Components, canonical forms

- **Button.** 28px tall, 1px `--border`, `--bg`, mono 12px, padding 0 10px. Hover: `--bg-3`.
  Primary: `--accent` background, `--accent-fg` text, border same as background. Focus: 1px
  `--accent` outline with 2px offset. Disabled: 50% opacity, no hover.
- **Input.** Same height and border as button, `--bg` surface, `--font-ui` 13px. Focus border
  `--accent`.
- **Chip.** 20px tall, mono 11px, `--bg-3`, 1px `--border`, padding 0 6px. Semantic chips tint
  with `--accent-soft` etc.
- **List row (sidebar, palette, sessions).** 28px tall, 13px text, 8px horizontal padding, hover
  `--bg-3`, current row `--accent-soft` with a 2px `--accent` bar on the left edge. Never a
  rounded highlight.
- **Section label.** `--fs-chrome-sm`, sentence case, `--fg-3`, 16px top margin. One word or
  two: "Files", "Trash".
- **Divider.** 1px `--border`. Full bleed inside panels.
- **Panel header.** 32px tall, mono 12px, bottom border, title left, actions right.
- **Scrollbars.** 12px wide, square thumb `--border-strong`, no buttons, track transparent (`--bg-2` inside panels), in every
  scrollable area (see `base.css`).
- **Tooltips.** Mono 11px, `--fg` on `--bg-3`, 1px border, no arrow, 300ms delay.
- **Empty states.** One short sentence in `--fg-3`, sentence case, centred. No illustrations.
- **Save marks.** Unsaved changes are a 6px `--accent` dot, on the tab and beside the path.
  A page that could not be written, or changed on disk under unsaved text, gets the error mark
  instead: a 7px square in `--err`, square so it does not depend on telling two colours apart,
  with the editor's own sentence as the tooltip. The active tab's underline turns `--err` with it.
- **The page banner.** One sticky box at the top of the page column, `.ed-banner`: the editor's
  sentence and its actions as `.btn`s, reachable with Tab. `--err-soft` ground, `--err` border and
  `--err-ink` text for a page that is not saved, with `role="alert"`; `--warn-soft`, `--warn` and
  `--warn-ink` for a notice (recovered changes, a page opened as text). Never more than one.
- **The Rich | Source switch.** Two buttons side by side in the page meta line,
  `.ed-mode`: a hairline `--border` around them and between them, in the meta line's face,
  `--fg-3`; the pressed one (`aria-pressed="true"`) sits on `--bg-3` in `--fg`. Tab reaches each.
- **The outside mark.** A file outside the vault is said in words, never in a colour: "outside
  vault" after its name on its tab, `--fs-chrome-sm` in `--fg-3`, and "Outside
  the vault" as the first segment of the path bar, in `--fg-3`. Its tooltip is the whole
  absolute path.
- **A drop target.** A folder that will take a drop, in the tree or the folder view, wears the
  current row's form: `--accent-soft` with the 2px `--accent` bar. The folder view's background,
  when the drop lands in the folder itself, is `--accent-soft` inside a 1px `--accent` line.
- **A sticky error.** An error the user has to act on (a file that was not moved, a page that
  could not be saved) is a toast with no timer, a close button and its actions as real buttons,
  `role="alert"`. An information toast still leaves on its own.
- **The focus chip.** While a folder is in focus, a chip in the toolbar: mono 11px, `--accent-soft`
  with 1px `--border`, `focus` in `--accent-ink`, the folder's name, and a ×. The whole chip is
  one button that leaves focus.
- **The boot error page.** One column, at most 44rem: the title in `--err`, one sentence of how far
  the boot got, the error in a box on `--err-soft` with `--err-ink` text, the log path in mono, the
  stack under a disclosure, and **Copy details** / **Try again**. Every token there has the
  system colour behind it, because the core's stylesheet may be what failed to load.
- **The folder view.** A folder is a page like any other (`{type:'folder', path}`): a header with
  the folder's name and the item count, a small toolbar (New file…, New folder, Paste, Undo, the
  sort, Show hidden items), and one list with the columns Name, Type, Modified and Size. Rows are
  list rows; a hidden item is greyed, a link carries a small badge, folders come first, then
  everything by name. The folder's README (or `index.md`) is rendered read-only under the list, as a
  document.
- **The path bar.** In the toolbar, beside back and forward: the vault's name, then each
  folder, then the file's name, each segment a flat button in `--fg-2` that lights to `--fg` on
  hover, separated by a `/` in `--fg-3`.
- **The side panel.** A resizable column to the right of the page, `--bg-2`, with a panel header
  (`--panelhead-h`, the title in sentence case, a close button). Search lives in it: a field with
  its icon, one line of counts in `--fg-3`, hits grouped under a file line (name in `--fg`,
  folder in `--fg-3`), each hit a list row in mono with the terms in bold `--accent-ink` and the
  line number as the row's hint. The selected hit is `--accent-soft` with the 2px bar.
- **The Settings page.** A view, in the page column's air: the section list on the left as a
  vertical tab list of list rows (the current one `--accent-soft` with the 2px bar), the section's
  title in the view-title face, and its rows on the right. A row is the name and its control on
  one line and one sentence under it in `--fg-3`; the controls are segmented buttons (`.seg`:
  one hairline box, the pressed segment on `--accent`). Rows are grouped by whitespace, never by
  rules. Under a narrow column the section list goes across the top.
- **The Trash view.** A view listing what can be restored: name, original folder, when, and
  where it is (Recycle Bin, Trash, or .trash in this vault), with one sentence at the top saying
  honestly what is and is not listed. Restore is a button and a command; a refusal is a sentence,
  never a destructive offer.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ the platform's title bar, its own buttons                    │
├──────────────────────────────────────────────────────────────┤
│ toolbar 36px  ‹ ›  +  vault › folder › notes.md              │
├──────────┬─────────────────────────────────┬─────────────────┤
│ sidebar  │ tabs (from two)                 │ side panel      │
│ 260px    │ page, folder or view            │ (search)        │
│ resizable│                                 │ hidden until    │
│          │                                 │ opened          │
└──────────┴─────────────────────────────────┴─────────────────┘
```

The window's frame is the platform's (X9, D11): Windows draws its own title bar and buttons,
with Snap Layouts on maximise, and macOS its title bar and traffic lights. The app draws no
window button, no resize edge and no drag region. Under the frame, the toolbar is ours and must
feel like part of the app: same surface as the sidebar (`--bg-2`), bottom border, the fold, back,
forward and New file as flat icon buttons, then the path. The window is at least 480 by 360;
under 640px the sidebar folds away on its own and the toolbar and the page fit
without overflowing, in both themes.

## A page as a document

A page the user wrote is a document, not a web page. The reference is a maths handout typed in
Word: one serif face, compact, justified, rigid, square. It applies to page CONTENT and nothing
else: the block editor's column (`.ed .milkdown`), the page title strip, everything drawn
through `render()` (`.md-render`: a journal entry, a folder's README), and paper. The
chrome around it keeps `--font-ui` and `--font-mono`, and so do a view's own controls.

- **Face.** `--font-doc` (Cambria on Windows, Iowan Old Style on a Mac) for the body, the
  headings and the title. Code keeps `--font-mono` everywhere. Settings' `Page face` chooses
  between `document`, which is that serif, and `plain`, which makes `--font-doc` resolve to
  `--font-ui`: one attribute on `<html>` (`data-face`) and one rule in `tokens.css`, so
  everything wearing the face moves at once, paper included. Only the family moves; the sizes,
  the rhythm, the frames, the rules and the maths face are the document's either way.
- **Space.** A blank line separates two blocks, and a run of N blank lines between two blocks is
  N minus 1 empty paragraphs of space: each is a real block the caret goes into, Backspace takes
  away and typing fills. Enter twice at the end of a paragraph leaves one line of space, as in
  Word, and nothing takes it back afterwards. An empty paragraph is one line tall and carries no
  marker, no rule and no padding of its own.
- **Size and leading.** The body is Settings' `Text size` (16px by default) at `--lh-body`,
  which Settings offers as 1.25, 1.35 or 1.5, the default 1.35. Everything else is a ratio of
  the body, so one setting moves the whole page.
- **Scale.** Title `--fs-doc-title`, bold, centred, in a box with a double rule
  (`3px double var(--fg)`, square, `width: fit-content` so it hugs a short title and wraps a
  long one). H1 `--fs-doc-h1` bold, H2 `--fs-doc-h2` bold, H3 bold at the body size, H4 and
  below bold italic. No second family, no grey heading, no letter-spacing.
- **Rhythm.** `--doc-gap` between paragraphs, `--doc-gap-head` above a heading, and
  `--doc-gap-label` above a paragraph that opens with a bold run-in label
  (`p:has(> strong:first-child)`), which is the gap a person leaves by hand before writing
  "Démonstration.". A gap never sits against the inside of a frame, a cell or a list item.
- **Alignment.** Justified, `hyphens: none`, as Word sets a page. List items and table cells
  read left: they are short measures and would open rivers.
- **Lists.** Items touch. The marker hangs in `--doc-indent`: a `.3em` dot in the text colour at
  the first level, a hollow `.4em` ring inside one, `1.` in the text face for an ordered list,
  right-aligned so 1. and 10. end together. A task row takes `.35em` more indent, because a
  checkbox is a wider mark than a dot. A list row is exactly as tall as its text line.
- **Frames and bars, not air.** `>` is a BAR: `--doc-bar` solid `--fg` down the left, italic, no
  tint and no box. `>>` is a FRAME: a square `--doc-frame` box, upright, `--doc-pad-frame`
  inside; markdown has no second quote mark, so a frame arrives as a blockquote nested in a
  blockquote and the outer one draws nothing. `---` is a solid `--doc-rule` in the text colour.
  A table is a real grid: `--doc-rule` solid `--fg` around every cell, `--doc-pad-cell` inside,
  header cells bold at the body size on no background.
- **Corners.** `border-radius: 0` on everything in page content: code blocks, inline code,
  tables, images, frames, the title box. `--radius` is the chrome's, and a task checkbox keeps
  it because a checkbox is a control.
- **Links** underlined, `--accent-ink` on screen, the text colour on paper.
- Both themes. Tokens only, no hex outside `tokens.css`.

Task checkboxes are 16px squares with 1px `--border-strong`, filled `--accent` with a white
check when done, text struck through in `--fg-3`. Images are full column width with a 1px
border. The block handle and the slash menu stay in the left gutter, on hover only, in the
chrome's face: they are not part of the document.

## Print and PDF

Two commands, both Chrome's print dialog. `page.export-pdf` (Ctrl+Alt+P; Ctrl+Shift+P is the
palette) opens it with the page's title as the document's, so Save as PDF suggests the page's
name; `page.print` opens it as it is. Neither changes the theme: `src/editor/print.css` holds every `@page` and `@media print` rule of the app, and it
turns the palette black on white from either theme, so no rule elsewhere writes a print colour
and syntax colour prints black. `@page` is A4 with `--print-margin` on every side; the body is
`--print-fs` of `--font-doc` at `--print-lh`, which puts about 52 lines on the sheet and follows
Settings' `Page face`. Backgrounds are off (Chrome's default; with them on a sheet could take
the theme's own ground), so a done task prints as a ticked outline and a bullet is drawn with a
border rather than a fill. Only the page content goes on paper: the scrolling containers are
flattened, no chrome, no meta line, no handles (the image block's button and drag bar included),
no placeholders, no caret. A heading, and a run-in label that opens a paragraph of its own rather
than a list item, carry `break-after: avoid`; a frame, a bar, a display formula and a picture
carry `break-inside: avoid`; a table and a code block do not, because they are as long as the
author made them and a block taller than the sheet empties the sheet before it: they break
between rows and between lines, and each fragment closes its own box. Text carries
`orphans: 2; widows: 2`. A picture takes the measure at its own proportions, capped short of the
printable height so that its label stays on the sheet with it. A table column is never narrower
than its longest word, so no word is cut in two. Inline code is plain mono in the text colour
with no box around it, and code inside a block is set at a ratio of the body, at the body's
leading. The sheet number is in the bottom margin, mono at 9pt. Deliberate space (an empty
paragraph) prints as the empty line it is.

The page view (Settings › Appearance › Page layout, `Pages`, or `Toggle page view` in the palette) shows
the same sheet while writing. The page column becomes the A4 sheet on a `--bg-3` desk, with the
print margin, the print size and the print leading, so a line breaks on screen where it breaks on
paper; the meta line moves into the top margin, out of the flow, because paper does not carry it.
`src/editor/sheets.ts` walks the blocks with the break rules above and draws a dashed rule, with
the number of the next sheet in the right margin, wherever a sheet ends. Nothing moves in the
document: the rules are an overlay, so the file and the editing are the same in both layouts.
The window's zoom scales the sheet as one object.

## Code

One palette, one set of token colours, everywhere code is shown: a fenced block inside a page, a
file of code open as a page, a `codeEditor` in a view, and a fenced block in read-only rendered
markdown. The colours are the `--code-*` tokens and nothing else, from the same
families as the rest of the palette rather than a borrowed theme: keyword in the terracotta
line, string in the olive, type in the amber, function in the blue, number in the one purple the
week grid uses. An identifier with no role keeps the body colour, which is what a calm block of
code looks like; a decorator, a shebang or a doctype takes the keyword ink, because that is what
it is.

A file of code is a small editor and says so: line numbers, a `--bg-3` stripe under the caret's
line while it holds the caret, the bracket under the caret in `--bg-4`, the other occurrences of
whatever is selected on `--bg-3`. A page of prose has none of them. In rendered markdown a
Python transcript keeps its shape: the `>>>` prompt in the comment ink, the code after it
coloured, the interpreter's answer in the body colour, because output is not code.

## Views (Settings, Trash, Day, Week, Month, Journal)

The same page column as an editor page. A view's title is the document face at `--fs-doc-title`,
bold and left, with no box around it: the box belongs to a document's own title, and the view is
the app talking rather than the user's writing, so its controls, labels, counts and tables keep
the chrome faces (`--font-ui` at `--fs-ui`, `--font-mono` at `--fs-chrome`). The planner's
furniture (the title row with its previous / today / next group) is in `src/planner/planner.css`;
nothing in a view names a family or sets a size in px. A note a view shows rather than draws goes
through `render()` and is a document like any other. A view whose file is not chosen yet says so
in one quiet line pointing at Settings › Planner, never in a red box.
Dense data (the week grid, the habit matrix) uses mono 11px labels and 1px grid lines in
`--border`. Colour blocks in the week grid use the semantic tokens
at low opacity with a 2px left bar in the full colour.

## Language

The UI is in English. Hassan's files are in French and English; never translate file content.
Labels are short and in sentence case everywhere, chrome and dialogs alike ("Recent", "Show
hidden items", "Move to the Recycle Bin"). A sentence names what really happens: the Recycle Bin
when it is the Recycle Bin, `.trash in this vault` when it is that.

## Checklist before you say a surface is done

- Both themes checked, no colour that is not a token.
- Keyboard: every action reachable, focus visible, Esc closes what Enter opened.
- Hover states on every interactive element, 120ms.
- Nothing wraps or clips at 1280x800, and nothing breaks at 1024x700, at 2560x1440, or at the
  480x360 minimum window.
- No console errors, no layout shift when data loads (reserve space, then fill).
