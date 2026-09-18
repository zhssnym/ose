# Ose: design system

Read this before writing any UI. The app, the shell and every plugin must look like they were
made by one hand.

**Vocabulary.** The **app** is `ose.exe`, the whole thing. The **shell** is the interface inside
it: title bar, tabs, sidebar, palette, settings, home. A **plugin** is local code in the vault,
under `.ose/plugins`, that draws one view inside the app. There is no other word.

## The brief, in one line

Notion's space and calm, drawn with the discipline of an old Win32 control-room application, in
Claude's colours. Think of a 1990s plant-control panel redrawn by Anthropic's design team.

## Personality

- **Space.** The chrome breathes. The page column is 720px wide, centred, with 80px of air above
  a view's title (a page of the user's own writing is a document and takes 48px; see "A page as
  a document"). Nothing is cramped, ever. Every padding, margin and gap is a step of the spacing scale
  in `tokens.css` (`--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 24, `--sp-6` 32,
  `--sp-7` 48; `--sp-half` for a deliberate 2px optical nudge, with a comment saying why). A
  bare pixel value in a plugin stylesheet is a bug. Panels sit at `--sp-3` to `--sp-4`.
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
  - Chrome (title bar, status bar, sidebar section labels, palette hints, chips, table headers,
    metadata): `var(--font-mono)` at 11px to 12px, often uppercase with `letter-spacing: .06em`.
    This is the control-room voice.
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

## Tokens

All colours, fonts, and sizes come from `src/kernel/styles/tokens.css`, served as part of
`ui.css`. Never write a hex colour in a plugin stylesheet; the shell's `theme.css` is the one
place a token is overridden. Light is the default on `:root`; dark is `:root[data-theme="dark"]`.
The theme attribute is set by the shell; plugins only read tokens.

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
--radius (2px)  --titlebar-h (36px)  --statusbar-h (24px)  --sidebar-w (260px)
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
- **Section label.** Mono 11px uppercase `--fg-3`, letter-spacing .06em, 16px top margin.
- **Divider.** 1px `--border`. Full bleed inside panels.
- **Panel header.** 32px tall, mono 12px, bottom border, title left, actions right.
- **Scrollbars.** 12px wide, square thumb `--border-strong`, no buttons, track transparent (`--bg-2` inside panels), in every
  scrollable area (see `base.css`).
- **Tooltips.** Mono 11px, `--fg` on `--bg-3`, 1px border, no arrow, 300ms delay.
- **Empty states.** One short sentence in `--fg-3`, mono, centred. No illustrations.
- **The missing-path box.** What a view is given when the file or folder it asked for is not
  there, or when several things match the name. The kernel draws it, into the element the view
  handed to `ose.paths.get(key, { el })`, so every plugin asks the same question the same way; a
  plugin never writes one of its own. A column of `--sp-2` gaps on `--bg-2`, 1px `--border`,
  `--sp-4` of padding, at most 34rem wide, spanning every column of whatever grid it lands in:
  `.path-box`, with `.path-box-title` (the label verbatim, `--fg`), `.path-box-hint` and
  `.path-box-what` (`--fg-2`, the name in mono inside a `code`), `.path-box-near` over
  `.path-box-picks` with one `.path-box-pick` button per candidate, and `.path-box-actions`
  holding the primary `.path-box-choose`. Every control is a real button, focus lands on
  Choose…, and the box wraps rather than assuming a page width: a Day tile is a third of a
  column.
- **A Settings › Plugins row.** Per plugin a heading line, `.set-plug`: the name in `--fg`, the
  description in mono `--fg-3`, the state at the end in `--fg-3` or `--err`, with the error
  under it on its own line (`.set-plug-why`, `--err`). Under it one `.set-path` row per declared
  path, on the same grid as any settings row: `.set-path-name`, `.set-path-value` (the path, or
  `missing` / `ambiguous` as `.set-path-bad` in `--err`), `.set-path-note` for the hint, and
  `.set-path-act` holding Choose… and Reset. The section's own buttons sit in `.set-plug-act`.

## Layout

```
┌─────────────────────────────────────────────────┐
│ titlebar 36px  logo path/breadcrumb   ─  ☐  ✕   │
├──────────┬──────────────────────────────────────┤
│ sidebar  │ main                                 │
│ 260px    │ page (editor) or view                │
│ resizable│                                      │
├──────────┴──────────────────────────────────────┤
│ statusbar 24px  READY · path · 412 words · saved │
└─────────────────────────────────────────────────┘
```

The window has no native frame. The title bar is ours and must feel like part of the app: same
surface as the sidebar (`--bg-2`), bottom border, app mark in mono, window buttons 46px wide and
full height, glyphs drawn as 10px stroked SVG, close button hover `--err` with white glyph.

## A page as a document

A page the user wrote is a document, not a web page. The reference is a maths handout typed in
Word: one serif face, compact, justified, rigid, square. It applies to page CONTENT and nothing
else: the block editor's column (`.ed .milkdown`), the page title strip, everything drawn
through `render()` (`.md-render`: a drill's statement, a journal entry, a tile), and paper. The
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
- **Size and leading.** The body is Settings' `Body text` (16px by default) at `--lh-body`,
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

Two commands, both on the host and neither through the browser's print dialog, which never
returns in WebView2. `page.export-pdf` (Ctrl+Shift+P; Ctrl+P is the palette) asks for a file
with the native save dialog and writes the PDF through WebView2's own engine; `page.print`
opens the Windows print dialog, where Microsoft Print to PDF also lives. Neither changes the
theme: `src/editor/print.css` holds every `@page` and `@media print` rule of the app, and it
turns the palette black on white from either theme, so no rule elsewhere writes a print colour
and syntax colour prints black. `@page` is A4 with `--print-margin` on every side; the body is
`--print-fs` of `--font-doc` at `--print-lh`, which puts about 52 lines on the sheet and follows
Settings' `Page face`. Backgrounds are off (the host would otherwise paint the sheet in the
theme's own ground), so a done task prints as a ticked outline and a bullet is drawn with a
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

## Code

One palette, one set of token colours, everywhere code is shown: a fenced block inside a page, a
file of code open as a page, a `codeEditor` in a plugin's panel, and a fenced block in read-only
rendered markdown. The colours are the `--code-*` tokens and nothing else, from the same
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

## Views (day, week, month, journal, drills)

The same page column as an editor page. A view's title is the document face at `--fs-doc-title`,
bold and left, with no box around it: the box belongs to a document's own title, and the view is
the app talking rather than the user's writing, so its controls, labels, counts and tables keep
the chrome faces (`--font-ui` at `--fs-ui`, `--font-mono` at `--fs-chrome`). One rule for all
six, at the top of `plugins/_lib/view.css`; nothing in a plugin names a family or sets a size in
px. A note a view shows rather than draws goes through `render()` and is a document like any other.
Dense data (the week grid, the habit matrix) uses mono 11px labels and 1px grid lines in
`--border`. Colour blocks in the week grid use the semantic tokens
at low opacity with a 2px left bar in the full colour.

## Language

The UI is in English. Hassan's files are in French and English; never translate file content.
Labels are short and lowercase in chrome ("pages", "views", "scratch"), Title Case in dialogs.

## Checklist before you say a plugin is done

- Both themes checked, no colour that is not a token.
- Keyboard: every action reachable, focus visible, Esc closes what Enter opened.
- Hover states on every interactive element, 120ms.
- Nothing wraps or clips at 1280x800, and nothing breaks at 1024x700 or at 2560x1440.
- No console errors, no layout shift when data loads (reserve space, then fill).
