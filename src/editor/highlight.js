// One place for everything that turns code into coloured spans.
//
// Three surfaces need the same answer and used to have three different ones: the standalone
// `codeEditor`, a code file open as a page (source mode), and a fenced block in read-only
// rendered markdown. The style, the pack lookup and the loader live here so the three cannot
// drift: `python` in a fence, `correction.py` in the column and `render(md, {codeLanguage})`
// all end up with the same classes on the same tokens.
//
// The classes are `os-t-*` and nothing here states a colour; `code.css` gives each class a
// `--code-*` token, for every ground.

import { HighlightStyle, LanguageDescription } from '@codemirror/language';
import { languages as LANGUAGE_PACK } from '@codemirror/language-data';
import { highlightCode, tags as t } from '@lezer/highlight';
import * as P from './paths.js';

// ---------------------------------------------------------------------------
// the style

/**
 * Every token becomes a class; code.css gives the class a token colour. Tags not listed here
 * (a plain identifier) keep the body colour, which is what a calm code block looks like.
 */
export const HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword,
    t.modifier, t.self, t.bool, t.null, t.atom], class: 'os-t-key' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.docString], class: 'os-t-str' },
  { tag: [t.number, t.integer, t.float, t.unit, t.escape, t.literal, t.constant(t.name)],
    class: 'os-t-num' },
  { tag: [t.definition(t.variableName), t.local(t.variableName), t.special(t.variableName)],
    class: 'os-t-var' },
  { tag: t.inserted, class: 'os-t-ins' },
  { tag: t.deleted, class: 'os-t-del' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'os-t-com' },
  // `meta` is not a comment: in Python it is the `@` of a decorator, in a shell script the
  // shebang, in HTML the doctype, the line that says "this changes what follows", which was
  // being painted the colour of the one thing that changes nothing (ADV-N). Its own class,
  // drawn in the keyword ink. `processingInstruction` keeps the comment colour it had.
  { tag: t.meta, class: 'os-t-meta' },
  { tag: t.processingInstruction, class: 'os-t-com' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)),
    t.macroName, t.labelName, t.propertyName, t.definition(t.propertyName), t.className,
    t.tagName], class: 'os-t-fn' },
  { tag: [t.typeName, t.standard(t.typeName), t.namespace, t.annotation, t.attributeName],
    class: 'os-t-type' },
  { tag: [t.operator, t.derefOperator, t.punctuation, t.separator, t.bracket, t.paren,
    t.brace, t.squareBracket, t.angleBracket, t.contentSeparator], class: 'os-t-punc' },
  { tag: [t.link, t.url], class: 'os-t-link' },
  { tag: t.strong, class: 'os-t-strong' },
  { tag: t.emphasis, class: 'os-t-em' },
  { tag: t.strikethrough, class: 'os-t-strike' },
  { tag: t.heading, class: 'os-t-head' },
  { tag: t.quote, class: 'os-t-quote' },
  { tag: t.invalid, class: 'os-t-invalid' },
]);

// ---------------------------------------------------------------------------
// the pack

/**
 * Aliases the stock pack does not carry. `.jsonl` is one JSON object per line, which every JSON
 * grammar parses line by line, and the pack's JSON entry answers to `json` and `map` only: the
 * vault's `systems.jsonl` and every plugin log opened flat, with no colour at all, beside a
 * `meta.json` that had strings and numbers. One palette everywhere code is shown.
 */
const ALIAS = { jsonl: 'json' };

/** The pack entry for a language name, an alias, or a file name. Null when nothing matches. */
export function describe(language, path) {
  const asked = String(language || '').trim();
  const name = ALIAS[asked.toLowerCase()] || asked;
  if (name) {
    return LanguageDescription.matchLanguageName(LANGUAGE_PACK, name, true)
      || LANGUAGE_PACK.find((l) => l.alias.includes(name.toLowerCase()))
      || null;
  }
  if (path) {
    const file = P.basename(path);
    const dot = file.lastIndexOf('.');
    const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : '';
    if (ALIAS[ext]) return describe(ALIAS[ext]);
    return LanguageDescription.matchFilename(LANGUAGE_PACK, file);
  }
  return null;
}

/**
 * The grammar for a pack entry, or null.
 *
 * Every language in the pack is a chunk of its own, fetched the first time something asks for
 * it. `LanguageDescription.load()` already keeps the promise, so this adds no cache of its
 * own; what it adds is the one rule every caller wants: **it never rejects**. A grammar that
 * cannot be fetched is a page without colour, never a page that fails to open.
 */
export function loadLanguage(desc) {
  if (!desc) return Promise.resolve(null);
  if (desc.support) return Promise.resolve(desc.support);
  return Promise.resolve()
    .then(() => desc.load())
    .then((support) => support || null)
    .catch((e) => {
      console.warn('[editor] language', desc.name, e && e.message ? e.message : e);
      return null;
    });
}

/**
 * What Tab inserts for a language. Two spaces is the app's own and is right for markdown and
 * for most of the pack; Python is four, because that is Python's convention, it is what a
 * seeded stub is written with, and a file that mixes the two is a `TabError` waiting to
 * happen (K3).
 */
const INDENT = { python: '    ' };

export const indentFor = (desc) => INDENT[String((desc && desc.name) || '').toLowerCase()] || '  ';

// ---------------------------------------------------------------------------
// static highlighting, for DOM that is not an editor

/**
 * A Python doctest: `>>> ` and its continuation `... ` with the interpreter's answer under
 * them. It is the shape every NSI statement in this vault states its examples in.
 */
const PROMPT = /^[ \t]*(?:>>>|\.\.\.)(?: |$)/;

/** True when the block is a transcript rather than a program: its first real line is a prompt. */
function isTranscript(code) {
  for (const line of code.split('\n')) {
    if (!line.trim()) continue;
    return PROMPT.test(line);
  }
  return false;
}

/**
 * Colour `code` into `el`, replacing whatever it holds.
 *
 * A transcript is treated as what it is and not as a program: the prompts are drawn in the
 * comment ink, only what follows a prompt is parsed, and the interpreter's answer keeps the
 * body colour. Parsing the whole thing as Python instead would paint `>>>` as three
 * comparisons and every output line as an expression, which is colour without meaning. A
 * program is parsed whole, in one pass.
 *
 * Throws nothing: a grammar that chokes leaves the text exactly as it was.
 */
export function highlightInto(el, code, support) {
  const parser = support && support.language && support.language.parser;
  if (!parser) return false;
  const out = document.createDocumentFragment();

  let started = false;
  const line = () => { if (started) out.append('\n'); started = true; };
  const put = (text, classes) => {
    if (!text) return;
    if (!classes) { out.append(text); return; }
    const span = document.createElement('span');
    span.className = classes;
    span.textContent = text;
    out.append(span);
  };
  const prompt = (text) => { if (text) put(text, 'os-t-com'); };

  /** One run of source, with `marks[i]` the prompt that opened its line i (empty for none). */
  const run = (text, marks) => {
    let i = 0;
    line();
    prompt(marks[0]);
    highlightCode(text, parser.parse(text), HIGHLIGHT, put, () => {
      i += 1;
      line();
      prompt(marks[i]);
    });
  };

  try {
    if (!isTranscript(code)) {
      run(code, ['']);
    } else {
      const lines = code.split('\n');
      let i = 0;
      while (i < lines.length) {
        if (!PROMPT.test(lines[i])) { line(); out.append(lines[i]); i += 1; continue; }
        const marks = [];
        const source = [];
        while (i < lines.length && PROMPT.test(lines[i])) {
          const mark = PROMPT.exec(lines[i])[0];
          marks.push(mark);
          source.push(lines[i].slice(mark.length));
          i += 1;
        }
        run(source.join('\n'), marks);
      }
    }
  } catch (e) {
    console.warn('[editor] highlight', e && e.message ? e.message : e);
    return false;
  }

  el.textContent = '';
  el.append(out);
  return true;
}
