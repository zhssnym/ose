// The markdown language Live parses with: CommonMark, GFM (tables, task lists, strikethrough,
// bare URLs), and three things of the vault's own:
//
//   - wikilinks, `[[target#heading|alias]]`, a `Wikilink` node with `WikilinkMark`s;
//   - embeds, `![[file.png|300]]`, parsed as an `Image` node so the image widget draws both
//     kinds of picture (registry.js says how it tells them apart);
//   - frontmatter, a `---` line at the very start of the file up to the next `---` or `...`
//     line, one `Frontmatter` block. Without it the parser read the opening line as a rule and
//     the last key as a setext heading underlined by the closing `---`.
//
// Callouts need no parser: a callout is a blockquote whose first line starts `[!type]`, and
// `calloutOf` reads that off the text. The widgets' own parser extensions (maths) and code
// languages come in through `liveLanguage(collected)`.
//
// Nothing here changes a byte. The language only says what the text is.

import { markdown, commonmarkLanguage } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { tags } from '@lezer/highlight';

// ---------------------------------------------------------------------------
// wikilinks and embeds

const BRACKET_OPEN = 91;   // [
const BRACKET_CLOSE = 93;  // ]
const BANG = 33;           // !
const NEWLINE = 10;

/**
 * The end of a `[[…]]` whose first `[` is at `start`, or -1. The inside may not hold a line
 * break, another `[[`, or `]` alone, and may not be empty.
 * @param {import('@lezer/markdown').InlineContext} cx
 * @param {number} start
 */
function wikiEnd(cx, start) {
  if (cx.char(start) !== BRACKET_OPEN || cx.char(start + 1) !== BRACKET_OPEN) return -1;
  for (let i = start + 2; i < cx.end; i++) {
    const c = cx.char(i);
    if (c === NEWLINE) return -1;
    if (c === BRACKET_OPEN && cx.char(i + 1) === BRACKET_OPEN) return -1;
    if (c === BRACKET_CLOSE) {
      if (cx.char(i + 1) !== BRACKET_CLOSE || i === start + 2) return -1;
      return i + 2;
    }
  }
  return -1;
}

/** @type {import('@lezer/markdown').MarkdownConfig} */
const Wikilinks = {
  defineNodes: [
    { name: 'Wikilink', style: tags.link },
    { name: 'WikilinkMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Wikilink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== BRACKET_OPEN) return -1;
        const end = wikiEnd(cx, pos);
        if (end < 0) return -1;
        return cx.addElement(cx.elt('Wikilink', pos, end, [
          cx.elt('WikilinkMark', pos, pos + 2), cx.elt('WikilinkMark', end - 2, end),
        ]));
      },
    },
    {
      name: 'WikiEmbed',
      before: 'Image',
      parse(cx, next, pos) {
        if (next !== BANG) return -1;
        const end = wikiEnd(cx, pos + 1);
        if (end < 0) return -1;
        return cx.addElement(cx.elt('Image', pos, end, [
          cx.elt('WikilinkMark', pos, pos + 3), cx.elt('WikilinkMark', end - 2, end),
        ]));
      },
    },
  ],
};

/**
 * The parts of a wikilink's text, `[[target#heading|alias]]` (or the same with a leading `!`).
 * `shown` is what Live draws in place of the markup: the alias, else the target as written.
 * `innerFrom` is the offset, inside `text`, where the shown part starts.
 * @param {string} text
 */
export function wikiParts(text) {
  const bang = text.startsWith('!') ? 1 : 0;
  const inner = text.slice(bang + 2, text.length - 2);
  const bar = inner.indexOf('|');
  const ref = bar < 0 ? inner : inner.slice(0, bar);
  const alias = bar < 0 ? '' : inner.slice(bar + 1);
  const hash = ref.indexOf('#');
  const target = (hash < 0 ? ref : ref.slice(0, hash)).trim();
  const heading = hash < 0 ? '' : ref.slice(hash + 1).trim();
  const shownFrom = bang + 2 + (bar < 0 ? 0 : bar + 1);
  return { target, heading, alias, ref, shown: bar < 0 ? ref : alias, shownFrom, shownTo: text.length - 2 };
}

// ---------------------------------------------------------------------------
// frontmatter

const FENCE_OPEN = /^---[ \t]*$/;
const FENCE_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
/** How far into the file a closing line is looked for. A property block is never this long. */
const FRONTMATTER_SCAN = 256 * 1024;

/**
 * Where the frontmatter of `text` (the document as CodeMirror holds it, `\n` only) ends:
 * `{ to, closeFrom }`, the end of the closing line and its start; or null when the file does
 * not open with one. One regular expression, shared by the parser and the pure helpers.
 * @param {string} text
 */
export function frontmatterRange(text) {
  const nl = text.indexOf('\n');
  if (nl < 0 || !FENCE_OPEN.test(text.slice(0, nl))) return null;
  let at = nl + 1;
  while (at <= text.length) {
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    if (FENCE_CLOSE.test(text.slice(at, end))) return { to: end, closeFrom: at };
    if (end >= text.length) break;
    at = end + 1;
  }
  return null;
}

/** @type {import('@lezer/markdown').MarkdownConfig} */
const Frontmatter = {
  defineNodes: [
    { name: 'Frontmatter', block: true },
    { name: 'FrontmatterMark', style: tags.processingInstruction },
  ],
  parseBlock: [{
    name: 'Frontmatter',
    before: 'HorizontalRule',
    parse(cx, line) {
      if (cx.lineStart !== 0 || cx.parentType().name !== 'Document' || !FENCE_OPEN.test(line.text)) return false;
      // The closing line can be anywhere below, and BlockContext only peeks one line ahead, so
      // the text is read straight from the parser's input. `input` is not in the typings but
      // is a plain field of the pinned version (@lezer/markdown 1.7); without it, no fold.
      /** @type {{ length: number, read(from: number, to: number): string } | undefined} */
      const input = /** @type {any} */ (cx).input;   // untyped field of BlockContext, see above
      if (!input || typeof input.read !== 'function') return false;
      const range = frontmatterRange(input.read(0, Math.min(input.length, FRONTMATTER_SCAN)));
      if (!range) return false;
      while (cx.lineStart < range.closeFrom) { if (!cx.nextLine()) break; }
      if (cx.lineStart !== range.closeFrom) return false;
      cx.addElement(cx.elt('Frontmatter', 0, range.to, [
        cx.elt('FrontmatterMark', 0, 3), cx.elt('FrontmatterMark', range.closeFrom, range.closeFrom + 3),
      ]));
      cx.nextLine();
      return true;
    },
  }],
};

// ---------------------------------------------------------------------------
// callouts

/** The callout types Live draws; any other `[!type]` is drawn as a note. */
export const CALLOUT_TYPES = ['note', 'tip', 'info', 'warning', 'danger', 'caution', 'quote'];

const CALLOUT_LINE = /^([ \t]*>[ \t]?)\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/;

/**
 * The callout a blockquote opens with, read off its first line; null when it is a plain quote.
 * `type` is one of CALLOUT_TYPES (an unknown word is `note`), `word` the type as written.
 * `from`/`to` bound the first line, which the header widget replaces.
 * @param {import('@codemirror/state').EditorState} state
 * @param {{ from: number, to: number }} node   the Blockquote
 */
export function calloutOf(state, node) {
  const line = state.doc.lineAt(node.from);
  const m = CALLOUT_LINE.exec(line.text);
  if (!m) return null;
  const word = (m[2] || '').toLowerCase();
  return {
    type: CALLOUT_TYPES.includes(word) ? word : 'note',
    word,
    fold: m[3] || '',
    title: (m[4] || '').trim(),
    from: line.from,
    to: line.to,
  };
}

// ---------------------------------------------------------------------------
// the language

/**
 * The language support for a Live view: commonmark + GFM + the vault's syntax, plus the parser
 * extensions and code languages the widgets bring (registry.js `collect`).
 * @param {{ markdown?: import('@lezer/markdown').MarkdownConfig[], languages?: import('@codemirror/language').LanguageDescription[] }} [collected]
 */
export function liveLanguage(collected) {
  const extra = (collected && collected.markdown) || [];
  const languages = (collected && collected.languages) || [];
  return markdown({
    base: commonmarkLanguage,
    extensions: [GFM, Wikilinks, Frontmatter, ...extra],
    codeLanguages: languages.length ? languages : undefined,
    completeHTMLTags: false,
    // Enter and Backspace are Live's (commands.js `liveEnter`, `liveBackspace`): the same
    // commands, but a tight list stays tight, leaving a list or quote leaves one blank line,
    // and every edit is tagged `input.live.*`.
    addKeymap: false,
  });
}
