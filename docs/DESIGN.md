# os editor: design system

Read this before writing any UI. Every module must look like it was made by one hand.

## The brief, in one line

Notion's space and calm, drawn with the discipline of an old Win32 control-room application, in
Claude's colours. Think of a 1990s plant-control panel redrawn by Anthropic's design team.

## Personality

- **Space.** Content breathes. The page column is 720px wide, centred, with 80px of air above the
  title. Nothing is cramped, ever. Every padding, margin and gap is a step of the spacing scale
  in `tokens.css` (`--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 24, `--sp-6` 32,
  `--sp-7` 48; `--sp-half` for a deliberate 2px optical nudge, with a comment saying why). A
  bare pixel value in a module stylesheet is a bug. Panels sit at `--sp-3` to `--sp-4`.
- **Boxes, not rules.** Whitespace groups things. A 1px hairline is for the edge of a box or the
  bottom of a bar, never a ladder of dividers between rows. Two things that are the same kind
  of thing get the same component: one bar height (`--panelhead-h`, or `--barhead-h` for the
  palette's input row and a dialog's foot), one row height (`--row-h`), one section label, one
  empty state.
- **Precision.** 1px hard borders. Square corners: `--radius` is 2px and that is the maximum
  anywhere (menus, buttons, inputs, cards, chips). No drop shadows except on floating menus and
  the command palette, and those use a hard 1px border plus a flat offset shadow
  (`0 8px 24px rgba(0,0,0,.18)`), never a soft blur glow.
- **Two typefaces, strict roles.**
  - Chrome (title bar, status bar, sidebar section labels, palette hints, chips, table headers,
    metadata): `var(--font-mono)` at 11px to 12px, often uppercase with `letter-spacing: .06em`.
    This is the control-room voice.
  - Content (editor, views, chat text, dialogs): `var(--font-ui)` at 15px, line-height 1.6.
  - Page titles and H1 only: `var(--font-title)` (a serif, Claude's brand voice). Never use the
    serif for anything else.
- **Claude's colours, exactly.** Terracotta accent `#D97757` is the only saturated colour in the
  chrome. Kraft `#D4A27F` for secondary warmth. Ivory/paper surfaces in light mode, near-black
  warm surfaces in dark mode. Colour means something: accent = interactive or current, olive =
  success or done, amber = attention, brick = error. Never decorate with colour.
- **Flat.** No gradients, no glassmorphism, no rounded pills, no emoji as icons. Icons are
  16px stroked SVG, 1.5px stroke, `currentColor`, drawn inline. Keep them sparse.
- **Motion.** 120ms ease-out on hover and open states, nothing longer. No bouncing, no slides.
  Respect `prefers-reduced-motion`.

## Tokens

All colours, fonts, and sizes come from `src/styles/tokens.css`. Never write a hex colour in a
module stylesheet. Light is the default on `:root`; dark is `:root[data-theme="dark"]`. The
theme attribute is set by the shell; modules only read tokens.

Key tokens (see the file for the full list):

```
--bg          page surface            --fg      primary text
--bg-2        sidebar / panels        --fg-2    secondary text
--bg-3        hover, chrome, chips    --fg-3    muted text, placeholders
--border      1px lines               --border-strong  focused or emphasised lines
--accent      terracotta              --accent-fg  text on accent
--accent-soft tinted accent surface   --sel     text selection
--ok --warn --err --amber             semantic
--font-ui --font-mono --font-title
--radius (2px)  --titlebar-h (36px)  --statusbar-h (24px)  --sidebar-w (260px)
--page-w (720px)  --page-pad-top (80px)
--code-key --code-str --code-num --code-fn --code-type --code-var --code-punc --code-com
              code-block highlighting, each measured >= 4.5:1 on --bg-2 in both themes
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

## Layout

```
┌─────────────────────────────────────────────────┐
│ titlebar 36px  [os] path/breadcrumb    ─  ☐  ✕   │
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

## Editor page

Notion, not a text editor. Title is an editable H1 in `--font-title` 34px. Body `--font-ui`
16px, line-height 1.65, paragraphs separated by 4px of margin (Notion style), not blank space.
Block handle and slash menu on the left gutter, visible on hover only. Headings H2 22px, H3 18px
in `--font-ui` semibold. Task checkboxes are 16px squares with 1px `--border-strong`, filled
`--accent` with a white check when done, text struck through in `--fg-3`. Images are full column
width, square corners, 1px border. Code blocks in `--font-mono` 13px on `--bg-2`. Tables have
1px borders and mono header cells. Links, and any accent-coloured text, are `--accent-ink`
(`--accent` itself is 2.96:1 on the page and is for surfaces, borders and the hover underline),
underline on hover only.

## Views (week, habits, journal, tasks)

Same page column and title treatment as an editor page so switching between a page and a view
does not feel like changing app. Dense data (the week grid, the habit matrix) uses mono 11px
labels and 1px grid lines in `--border`. Colour blocks in the week grid use the semantic tokens
at low opacity with a 2px left bar in the full colour.

## Language

The UI is in English. Hassan's files are in French and English; never translate file content.
Labels are short and lowercase in chrome ("pages", "views", "scratch"), Title Case in dialogs.

## Checklist before you say a module is done

- Both themes checked, no colour that is not a token.
- Keyboard: every action reachable, focus visible, Esc closes what Enter opened.
- Hover states on every interactive element, 120ms.
- Nothing wraps or clips at 1280x800, and nothing breaks at 1024x700 or at 2560x1440.
- No console errors, no layout shift when data loads (reserve space, then fill).
