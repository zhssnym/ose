# Live

Live is the third way to edit a markdown page, beside Rich (Milkdown Crepe) and Source (plain
CodeMirror). It is CodeMirror 6 over the whole file, frontmatter and H1 included, with the
markup hidden off the caret's line by decorations: the page reads as a document, and the line
being edited shows the characters it is made of. It is modelled on how ixora, ink-mde and
Obsidian's live preview do it.

Live is opt-in (wave 3, X1). The switch in the meta line and the status bar field is Rich, Live
and Source; the machine setting `editorMode` picks the default for a markdown file never opened
before, and each file remembers the mode it was last left in (`src/editor/modes.ts`). Rich
stays the default until D1 is decided.

## The one rule: the file text is the only truth

Live holds the file's text and nothing else. A save writes

```
applyFormat(view.state.doc.toString(), liveFormat)
```

and nothing else: the text CodeMirror holds, with the two things it cannot hold put back by the
tested helpers of `src/editor/source.ts`: the byte-order mark and the separator each line had
(`\r\n`, `\r`, `\n`). There is no serializer, no model, no conversion. The decorations only
draw; a widget bug is a display glitch, never a changed byte.

The format field (`liveFormat`, `src/editor/live/state.ts`) follows the document. A text put in
from outside (`setText`, `replaceMinimal`) brings its own shape. An edit replaces the text of the
lines it touched, gives the separators *between* them the file's usual ending, and leaves every
other line with its own text and its own separator. So however many edits came before, a CRLF
line in a mostly-LF file keeps its CRLF until the user edits that very line. A file with no mark
and nothing but `\n` is plain and its field is never touched.

What this guarantees, and what `tests/live/properties.test.js` measures on the corpus and on 300
generated files with every kind of ending:

1. `liveText(liveState(t)) === t`, byte for byte;
2. after any sequence of user edits, every line the edits did not touch is byte-identical in what
   a save writes, separator included;
3. `liveDecorations` never throws and never changes the document;
4. a checkbox click changes exactly one byte.

One known limit: undoing the deletion of a line in a mixed-ending file gives the restored line
the file's usual ending, not the one it had (the format follows edits, and an undo is an edit).

## Files

```
src/editor/live/
  index.js      the one module outside live/ imports: createLiveView, liveState, liveText,
                liveDecorations, toggleTaskAt, LIVE_COMMANDS. Hands the widgets in.
  view.js       createLiveView: the EditorView, its extensions, the LiveView handle page.js uses
  state.js      the format field, liveState / liveText / liveDecorations (pure, for the tests),
                the task marker helpers and toggleTaskAt
  syntax.js     the language: CommonMark + GFM + wikilinks, embeds and frontmatter; callouts
  reveal.js     the reveal rule and the focus field
  inline.js     the inline decorations (a view plugin, over the visible ranges)
  blocks.js     the block decorations (a state field): the frontmatter fold and block widgets
  tasks.js      the checkbox and bullet widgets
  commands.js   run(id) for LIVE_COMMANDS, the Live keymap, and Enter / Backspace in lists and quotes
  complete.js   the `[[` completion of the vault's pages
  cellhtml.js   inline markdown to sanitised HTML for widgets that draw text (table cells)
  registry.js   the widget types, collect(), and the guard every widget's output goes through
  live.css      the look, tokens only
  widgets/      images, tables, maths, code, paste (their own doc notes below)
```

## The reveal rule

A range is **revealed** (its raw markup shown) while the editor has focus, or its find panel is
open, and some selection range touches one of its lines. The find panel counts as focus because
it holds the focus while it selects: a match in a drawn table, a hidden link URL or the folded
frontmatter is shown raw with its highlight, so Replace never acts on text nobody can see. A block construct asks about its whole extent, so a
frontmatter block, a table, a maths block, a fenced code block or a callout is revealed whole as
soon as one of its lines is. Unfocused, nothing is revealed and the page reads as a document.

The styling of what markup marks stays either way: a heading keeps its size and a bold run its
weight when the caret is on them; only the markup appears, dimmed (`cm-live-mark`).

Focus is state (`focusField`), not a DOM question, because the block decorations come from a
state field and must be computable from a state alone. CodeMirror adds the effect to its own
focus transaction (`EditorView.focusChangeEffect`).

## What it draws off the caret

| Construct | Off the caret | Class or widget |
|---|---|---|
| `# Heading` … `######` | `#`s and the space after hidden; a closing sequence too | line `cm-live-h1`…`h6`; the first H1 also `cm-live-title` |
| Setext heading | the text styled, the underline dimmed | line `cm-live-h1` / `h2` |
| `_em_` `*em*` `**strong**` `__strong__` `~~strike~~` `` `code` `` | markers hidden | `cm-live-em`, `-strong`, `-strike`, `-code` |
| `\*` escape | the backslash hidden | |
| `[text](url "title")` | only the text shows | `cm-live-link`, `data-href` |
| `<https://…>`, bare URLs | the brackets hidden; the URL styled | `cm-live-link` |
| `[[target#heading\|alias]]` | the alias shows, else the target as written | `cm-live-link cm-live-wiki`, `cm-live-missing` when `resolveWikilink` says so |
| `-` `*` `+` bullet | a bullet widget (dot, ring, dot by depth) | `cm-live-bullet` |
| `1.` `1)` | stays as written | `cm-live-listmark` |
| `- [ ]` / `- [x]` | a checkbox widget | `cm-live-checkbox`; line `cm-live-task`, done `cm-live-done` |
| `>` quote | markers hidden | line `cm-live-quote` (a bar) |
| `>>` | markers hidden | line `cm-live-frame` (a frame, as in Rich) |
| `> [!type] Title` | a header widget with the type and the title; a `-`/`+` fold marker is hidden and the callout is always drawn open | line `cm-live-callout cm-live-callout-<type>`; types note, tip, info, warning, danger, caution, quote, anything else as note |
| `---` rule | a rule widget | `cm-live-rule` |
| frontmatter (`---` … `---` or `...` at the very start) | one block, "Properties" and the first keys | `cm-live-props`; raw lines `cm-live-fm` |
| HTML, comments | shown raw, dimmed, never rendered | `cm-live-html` |
| indented code | monospace | line `cm-live-fence` |

Images, tables, maths and fenced code are the widgets' (below).

## Mouse and keyboard

- A click on a link whose markup is hidden follows it (`onOpenLink(href, { newTab: false })`);
  Ctrl+click (Cmd on a Mac) opens it in a new tab; Alt+click only places the caret. On a
  revealed line a plain click places the caret and only the modified click follows.
- `page.follow-link` (Alt+Enter) follows the link under the caret (`linkAtCaret()`): a markdown
  link's URL, an autolink, a bare URL, or a wikilink's target resolved through the page
  (`resolveWikilink` + `linkTo`), else the target as a relative `.md` page.
- A click on a checkbox is one transaction that changes one character (`toggleTaskAt`, user
  event `input.live.task`); the caret does not move.
- A click, Enter or Space on the Properties block puts the caret on its first key line, which
  reveals it. The arrow keys reach it too: a caret that enters the block reveals it.
- The Live keymap binds the body chords of `BODY_KEYS` (kept in `src/core/keys.ts` for the
  palette, mirrored for the editor in `src/editor/keymap.ts`) for the ids Live implements:
  Ctrl+B `**`, Ctrl+I `_`, Ctrl+Shift+X `~~`, Ctrl+`` ` `` code, Ctrl+1…6 headings, Ctrl+0
  paragraph, Ctrl+Shift+7/8/9 numbered, bullet, task, Ctrl+Shift+. quote, Ctrl+Shift+C code
  block, Ctrl+Enter toggle task, Alt+Up/Down move line, Ctrl+D duplicate, Ctrl+Shift+K delete
  line. Ctrl+K and Alt+Enter are window chords that reach Live through its commands.
- Enter continues a list or a quote (`liveEnter`, lang-markdown's command with
  `nonTightLists: false`, so a tight list stays tight). On an empty item it takes one level of
  markup off; when that leaves the list, and on the empty last line of a quote or callout, one
  blank line is left between the block and the new line, which is what Enter twice leaves in
  Rich: the next line typed is a paragraph, never a lazy continuation of the last item. In a
  nested list the empty item goes up a level; in `> >` only the inner quote is left. Backspace
  after list markup takes one level off (`liveBackspace`). Both are `input.live.*` edits.
- `[[` opens a completion of the vault's pages (`complete.js`, fed by the `pages` option);
  accepting writes `target]]` as one `input.live.complete` edit. A name two pages share is
  offered as its path. Without `pages` there is no completion. Tab indents a list item, Shift+Tab outdents it, and
  elsewhere Tab does nothing but keep the focus in the page (D2). Escape closes the find panel,
  else leaves the editor (`onEscape`).

## Commands

`LIVE_COMMANDS`, run through `LiveView.run(id)`; each answers false when it does not apply
(a read-only page, no task under the caret), and page.js then toasts "Not available in Live".

| Id | What it writes |
|---|---|
| `format.bold`, `format.italic`, `format.strike`, `format.code` | `**`, `_`, `~~`, `` ` `` on both sides of each selection; inside that mark already, the mark is taken away; an empty selection gets the pair with the caret between |
| `format.link` | `[text]()` with the caret in the parentheses; a selected URL becomes `[](url)`; on a link, its URL is selected |
| `block.paragraph`, `block.h1`…`h6` | the line's block marker replaced (`## `…), or removed; the same heading again gives the paragraph back |
| `block.bullet`, `block.numbered`, `block.task` | `- `, `1. ` (numbered down the selection), `- [ ] `; again takes it away |
| `block.quote` | `> ` in front of each line, or one level taken away |
| `block.toggle-task` | one character per selected task line |
| `block.code` | the selected lines between fences, or an empty fence |
| `block.move-up`, `block.move-down`, `block.duplicate`, `block.delete` | the selected lines moved, copied down, or taken out whole |
| `page.follow-link` | nothing written: the link under the caret is followed |

Every change Live makes carries a user event under `input.live.*`; every selection it sets,
`select.live.*`. Nothing but a user gesture changes the document. Building decorations never
dispatches.

## The handle page.js holds

`createLiveView(opts)` answers a `LiveView` (the typedef is in `view.js`, and in the contract
§4.2). What matters to the page host:

- `getText()` is the bytes a save writes; `viewText()` is CodeMirror's `\n` text, for counting
  only.
- `setText(text, { history: 'isolate' | 'drop' })` and `replaceMinimal(text, { edit })` behave
  exactly as the source view's do: a text from outside is not an edit (no `onChange`, out of the
  undo history) unless `edit` says so; `replaceMinimal` is the smallest change, so the caret
  and the selection map through it.
- `onChange` fires for user edits only, checkbox clicks and pastes included.
- `setReadOnly(on)` freezes and unfreezes (H1); every command refuses on a read-only page.
- `refresh()` after a park and reattach re-measures, and redraws the decorations. It is also
  what to call when the answers of `resolveWikilink` change (the page list arriving after the
  mount), so a target that exists stops being drawn missing.
- `snapshot()` / `restore` carry `{ mode: 'live', from, to, scrollTop }`. With no `restore` the
  caret starts on the first line after the frontmatter, so a page opens with its properties
  folded.
- `openFind`, `closeFind`, `findOpen`: CodeMirror's own search panel, as in Source. While it is
  open the selection is revealed (see the reveal rule).
- A table cell is drawn by `cellhtml.js`: a Marked instance of its own with the pandoc maths and
  a wikilink extension drawn as Live draws one, images through `resolveAsset` and the "Missing
  image" box (a load error is caught by the view), DOMPurify, then the maths painted.
- `goToLine(line, col)` and `topLine()` are 1-based file lines, for the Reading view's mapping.

## Widgets

A widget draws one kind of syntax node. The registry (`src/editor/live/registry.ts`) is the
whole API:

```js
/** @type {import('./registry.js').LiveWidget} */
export const table = {
  id: 'table',
  kind: 'block',                   // 'inline': drawn over the visible ranges by a view plugin
                                   // 'block': drawn over the document by a state field
  nodes: ['Table'],                // lezer node names this widget draws
  decorate(ctx, node, out) { ... out.add(from, to, Decoration.replace({ block: true, widget })); },
  markdown: undefined,             // a MarkdownConfig for the parser (maths)
  languages: undefined,            // LanguageDescription[] for fenced code
  extension: undefined,            // anything else the view needs: a theme, a plugin
};
```

- `decorate` is called only for the nodes named, and only when `ctx.revealed(node.from,
  node.to)` is false. The context carries the state, the page's path, `resolveAsset`,
  `openLink` and `inlineHtml` (inline markdown to sanitised HTML, for table cells).
- An inline widget may only add decorations within a line; a block replace must cover whole
  lines. The core checks what a widget adds before it goes in: output CodeMirror would refuse,
  and a `decorate` that throws, leave that node raw and are logged once per widget. A broken
  widget can never take a keystroke down.
- A `WidgetType` implements `eq`. Its DOM handlers may only set the selection, never change the
  document; the one document-changing gesture is the checkbox, and it is the core's.
- The widgets are handed in by `live/index.js` (`WIDGETS`, `PASTE` from `widgets/index.js`);
  nothing under `widgets/` imports from `live/` but `registry.js`.
- An embed, `![[file.png|300]]`, is parsed as an `Image` node like `![alt](src)`, with
  `WikilinkMark` children; the image widget tells the two apart by the text.

The app's widgets (`widgets/index.js`: `WIDGETS` has six entries, `PASTE` one):

- **Images and maths register twice**, an inline half (`image`, `math`) and a block half
  (`image-block` over an `Image` node alone on its line, `math-block` over `BlockMath`), because
  CodeMirror takes block decorations only from a state field. An embed is drawn only when its
  target has an image extension; `![[note]]` stays the core's. A missing or unreadable image
  draws a "Missing image" box with its source.
- **Tables** (`table`, block): the GFM table drawn as an HTML table, cells read from the tree's
  pipes (empty cells and `\|` survive), alignment from the delimiter row, cells through
  `inlineHtml`. A click on a cell puts the caret on that cell's first source character, which
  reveals the table raw, in the monospace face so the pipes line up.
- **Maths** (`math.js` also carries the parser: `InlineMath` by the pandoc rule, `BlockMath` for
  `$$` at a block start, closed by a later `$$`; an unclosed `$$` stays a paragraph). A formula
  Temml refuses shows its source in the error style.
- **Code** (`code`, inline plus an extension): every line of a fenced block is boxed whether or
  not the caret is inside, so the column never jumps; the language comes from the nested parse;
  off the caret only the fence marks and the info string are dimmed.
- Widget clicks only set the selection (`select.live.image`, `select.live.table`,
  `select.live.math`), read positions with `posAtDOM` at click time, and never navigate the
  web view.
- **Paste** (M11): HTML is sanitised and turned into markdown by turndown with the vault's
  conventions (`-` bullets, `_` emphasis, `**` strong, fenced code, `<br>` as a line break). An
  inline `data:` image is stored as an attachment; a web image keeps its URL and is never
  downloaded. Files from the clipboard or a drop are stored and linked in one `input.paste`
  edit, with positions mapped through any typing done while they are written. Plain text is
  CodeMirror's own paste, and Ctrl+Shift+V (or `format.paste-plain`) pastes plain.

## Reading

`src/editor/reading/index.ts`, `createReadingView`: marked (GFM, `breaks: true`) with the maths
extension and a wikilink and embed extension, then DOMPurify per top-level block (no script,
style, iframe, object, embed or form; no event handler or style attribute). Every top-level block
carries `data-line`, its 1-based line in the file, correct across a byte-order mark, CR and CRLF,
frontmatter (shown as a Properties block on line 1) and runs of blank lines, so the top line is
kept both ways when the view is toggled. Images go through `resolveAsset`, code through the
editor's highlighter, task boxes are disabled, and every link goes to `onOpenLink`. It shares
`render.css`'s look and takes the page column's width. Callouts are drawn as plain quotes there.

## Performance

The inline decorations are built over the visible ranges only, in one walk of the syntax tree.
The block field maps its decorations through each change and rebuilds only regions: the
top-level blocks an edit can have changed (from the block before it to the first block past it
that the old tree had at the same place), what the parser newly covers, and the blocks whose
reveal moved. A caret moving along its line rebuilds nothing.

Measured on a 1 MB synthetic note (tables, maths, callouts, tasks, code) in Chromium: the block
field's work after a keystroke is about 0.1 ms and the inline rebuild over the viewport about
1 ms at the median. The whole keystroke costs about 26 ms in Live against about 25 ms in Source
on the same file: that time is CodeMirror's incremental markdown parse, capped per keystroke by
CodeMirror, and the same in both modes.

## What Live never does

- It never writes a byte it was not told to: no reformatting, no normalising of endings, no
  re-escaping, no serializer.
- It never renders HTML from the file, and never runs anything in it.
- It never changes the document from a decoration, a widget, a focus change or a load.
- It never keeps a second copy of the text: the page's draft, save and merge all read
  `getText()`.
