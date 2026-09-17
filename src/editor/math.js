// Maths: what makes a `$` a formula, and what turns a formula into a picture.
//
// Nothing here knows about Milkdown or ProseMirror. Three surfaces need exactly these pieces:
// the block editor (math-node.js wires them into the schema), the read-only `render()` (the
// marked extension below), and the serializer's clean-up in stringify.js (the line scanner).
//
// The rule is pandoc's, not micromark's. micromark-extension-math reads `$` like a code span,
// so "5 $ puis 10 $" becomes a formula holding "puis de 10", which is the one thing the vault
// must never do: the owner writes prices in euros and dollars in his journal. Pandoc asks two
// questions instead, and they are the whole of it:
//
//   an opening `$` is followed by a character that is not a space,
//   a closing `$` is preceded by a character that is not a space and is not followed by a digit.
//
// So `$x$` is maths, `5 $ puis 10 $` is text, and `$20,000 and $30,000` is text because the
// closer would be followed by a `3`. `\$` is a literal dollar and never either. Nothing inside
// a code span or a fenced block is ever looked at.
//
// A display formula is `$$` at the start of a line, closed by the first `$$` that has nothing
// but whitespace after it on its line. `$$x$$` on one line and
//
//     $$
//     x
//     $$
//
// are both display formulas, and the difference between them is kept: what is stored is the
// exact text between the two fences, newlines included, so writing it back is `'$$' + raw + '$$'`
// and the file gets its own bytes. A `$$` that is never closed stays a paragraph.
//
// The renderer is Temml, not KaTeX: Temml writes MathML, which the browser sets in the platform
// maths face (Cambria Math on Windows, the face Word's equation editor uses), so a formula sits
// in a Cambria page without looking imported from another document. KaTeX would bring its own
// Computer Modern and sixty font files with it.

import temml from 'temml';
import 'temml/dist/Temml-Local.css';
import './math.css';

// micromark codes: the line endings and the two virtual spaces are negative, EOF is null.
const EOF = null;
const DOLLAR = 36;
const eol = (code) => code !== EOF && code < -2;
const space = (code) => code === -2 || code === -1 || code === 32;
const digit = (code) => code !== EOF && code > 47 && code < 58;

// ---------------------------------------------------------------------------
// Temml

/**
 * One formula as an element (docs/KERNEL.md `ose:editor`). Never throws and never loses the
 * text: a formula Temml refuses comes back as its own source in the error colour, carrying
 * Temml's message as its title, which is the only useful thing to say about a typo in TeX.
 *
 * @param {string} tex
 * @param {{display?: boolean}} [opts]
 * @returns {HTMLElement}
 */
export function renderMath(tex, opts = {}) {
  const display = !!opts.display;
  const src = String(tex ?? '');
  const el = document.createElement(display ? 'div' : 'span');
  el.className = display ? 'ose-math ose-math-display' : 'ose-math';
  try {
    // `wrap: tex` lets a display formula that is wider than the column break at a binary
    // operator, the way Word breaks one, rather than run off the edge or need a scrollbar.
    temml.render(src, el, { displayMode: display, throwOnError: true, trust: false, wrap: display ? 'tex' : 'none' });
  } catch (e) {
    el.classList.add('ose-math-bad');
    el.textContent = display ? `$$${src}$$` : `$${src}$`;
    el.title = String((e && e.message) || e);
  }
  return el;
}

// ---------------------------------------------------------------------------
// One line, as the parser sees it.
//
// stringify.js has to undo the escapes remark writes without touching a formula, and it works
// line by line. This is the one place that decides what a `$` is on a line, so the serializer's
// clean-up and the parser can never disagree.

/**
 * A line cut into runs: `code` is a code span with its backticks, `math` is an inline formula
 * with its dollars, `text` is everything else. A `\$` is a literal dollar and belongs to the
 * text around it.
 *
 * @param {string} line
 * @returns {Array<{kind: 'code'|'math'|'text', start: number, end: number}>}
 */
export function lineRuns(line) {
  const runs = [];
  const src = String(line);
  let text = 0;
  const flush = (to) => { if (to > text) runs.push({ kind: 'text', start: text, end: to }); };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }                 // `\$` and every other escape
    if (ch === '`') {
      let n = 0;
      while (src[i + n] === '`') n++;
      // A code span closes on a run of exactly the same length; a longer one is passed over.
      let j = i + n;
      let close = -1;
      while (j < src.length) {
        if (src[j] !== '`') { j++; continue; }
        let m = 0;
        while (src[j + m] === '`') m++;
        if (m === n) { close = j; break; }
        j += m;
      }
      // An unclosed run of backticks is not a code span: it is text, and so is what follows.
      if (close < 0) { i += n; continue; }
      flush(i);
      runs.push({ kind: 'code', start: i, end: close + n });
      i = text = close + n;
      continue;
    }
    if (ch === '$') {
      const end = inlineMathEnd(src, i);
      if (end < 0) { i++; continue; }
      flush(i);
      runs.push({ kind: 'math', start: i, end });
      i = text = end;
      continue;
    }
    i++;
  }
  flush(src.length);
  return runs;
}

/**
 * The end of the inline formula that opens at `i` (exclusive, the closing `$` included), or -1
 * when the `$` there opens nothing. The pandoc rule, on one line: a formula never crosses a
 * line break, and `$$` opens nothing at all, so `a $$b$$ c` is text.
 */
export function inlineMathEnd(line, i) {
  const src = String(line);
  if (src[i] !== '$') return -1;
  const first = src[i + 1];
  if (first === undefined || first === '$' || first === ' ' || first === '\t') return -1;
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch !== '$') { j++; continue; }
    const before = src[j - 1];
    const after = src[j + 1];
    if (before !== ' ' && before !== '\t' && !(after >= '0' && after <= '9')) return j + 1;
    j++;
  }
  return -1;
}

/** `$$` opening a display formula at the start of a line (up to three spaces of indent). */
export const opensDisplay = (line) => /^ {0,3}\$\$/.test(String(line));

// ---------------------------------------------------------------------------
// micromark: the two constructs

/** A `$` never opens a formula right after another `$`. */
function previous(code) {
  return code !== DOLLAR;
}

/**
 * After the candidate closing `$`: a digit there means it was not a closer, which is the rule
 * that keeps `$20,000 and $30,000` out of the maths. Run through `effects.check`, so nothing of
 * it is kept either way and the value token never has to be taken apart again.
 */
const closerCheck = {
  partial: true,
  tokenize(effects, ok, nok) {
    return start;
    function start(code) {
      effects.enter('oseMathCheck');
      effects.consume(code);
      return after;
    }
    function after(code) {
      effects.exit('oseMathCheck');
      return digit(code) ? nok(code) : ok(code);
    }
  },
};

/** `$...$` in running text. */
const mathText = {
  name: 'oseMathText',
  previous,
  tokenize(effects, ok, nok) {
    let prev = EOF;
    return start;

    function start(code) {
      effects.enter('oseMathText');
      effects.enter('oseMathTextMarker');
      effects.consume(code);
      return afterOpen;
    }

    function afterOpen(code) {
      effects.exit('oseMathTextMarker');
      // The opening `$` is followed by a non-space, and `$$` in a paragraph is not maths.
      if (code === EOF || code === DOLLAR || space(code) || eol(code)) return nok(code);
      effects.enter('oseMathTextValue');
      return value(code);
    }

    function value(code) {
      // A formula in running text stays on its line: two `$` on two lines of one paragraph are
      // two prices, not a formula with a line break in it.
      if (code === EOF || eol(code)) return nok(code);
      if (code === DOLLAR && prev !== EOF && !space(prev)) {
        return effects.check(closerCheck, closing, carryOn)(code);
      }
      prev = code;
      effects.consume(code);
      return value;
    }

    function carryOn(code) {
      prev = code;
      effects.consume(code);
      return value;
    }

    function closing(code) {
      effects.exit('oseMathTextValue');
      effects.enter('oseMathTextMarker');
      effects.consume(code);
      return done;
    }

    function done(code) {
      effects.exit('oseMathTextMarker');
      effects.exit('oseMathText');
      return ok(code);
    }
  },
};

/** The line ending in front of a line that is not a lazy continuation of something else. */
const nonLazyContinuation = {
  partial: true,
  tokenize(effects, ok, nok) {
    const self = this;
    return start;
    function start(code) {
      if (code === EOF) return ok(code);
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      return lineStart;
    }
    function lineStart(code) {
      return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
    }
  },
};

/** `$$` with nothing but whitespace after it: the closing fence, wherever it stands. */
const fenceCheck = {
  partial: true,
  tokenize(effects, ok, nok) {
    return start;
    function start(code) {
      effects.enter('oseMathCheck');
      effects.consume(code);
      return second;
    }
    function second(code) {
      if (code !== DOLLAR) return nok(code);
      effects.consume(code);
      return trail;
    }
    function trail(code) {
      if (space(code)) { effects.consume(code); return trail; }
      effects.exit('oseMathCheck');
      return code === EOF || eol(code) ? ok(code) : nok(code);
    }
  },
};

/**
 * `$$ ... $$` as a block of its own.
 *
 * It does not interrupt a paragraph: a `$$` on the line under a sentence stays part of that
 * sentence, which is the conservative reading and the one that cannot rewrite a file the owner
 * already has. In the editor a display formula is always its own block, so nothing is lost.
 */
const mathFlow = {
  name: 'oseMathFlow',
  concrete: true,
  tokenize(effects, ok, nok) {
    const self = this;
    let open = false;
    return start;

    function start(code) {
      if (self.interrupt) return nok(code);
      effects.enter('oseMathFlow');
      effects.enter('oseMathFlowFence');
      effects.consume(code);
      return second;
    }

    function second(code) {
      if (code !== DOLLAR) return nok(code);
      effects.consume(code);
      return afterOpen;
    }

    function afterOpen(code) {
      // `$$$` is not a fence: three dollars are a fence and a dollar, which is nothing.
      if (code === DOLLAR) return nok(code);
      effects.exit('oseMathFlowFence');
      return content(code);
    }

    /** At a position inside the formula, on whichever line. */
    function content(code) {
      if (code === EOF) return nok(code);              // never closed: not a formula
      if (eol(code)) {
        if (open) { effects.exit('oseMathFlowValue'); open = false; }
        return effects.attempt(nonLazyContinuation, content, unclosed)(code);
      }
      if (code === DOLLAR) return effects.check(fenceCheck, closing, keep)(code);
      return keep(code);
    }

    function keep(code) {
      if (!open) { effects.enter('oseMathFlowValue'); open = true; }
      effects.consume(code);
      return content;
    }

    function unclosed(code) {
      return nok(code);
    }

    function closing(code) {
      if (open) { effects.exit('oseMathFlowValue'); open = false; }
      effects.enter('oseMathFlowFence');
      effects.consume(code);
      return closeSecond;
    }

    function closeSecond(code) {
      effects.consume(code);
      return closeTrail;
    }

    function closeTrail(code) {
      if (space(code)) { effects.consume(code); return closeTrail; }
      effects.exit('oseMathFlowFence');
      effects.exit('oseMathFlow');
      return ok(code);
    }
  },
};

/** The micromark extension: `$` in text, `$$` at the start of a block. */
export const mathSyntax = {
  text: { [DOLLAR]: mathText },
  flow: { [DOLLAR]: mathFlow },
};

// ---------------------------------------------------------------------------
// mdast
//
// Two node types, and both keep the file's own bytes rather than a tidied version of them:
//
//   inlineMath  { value }   the TeX between the two `$`, exactly as written
//   mathBlock   { value }   everything between the two `$$`, newlines included, so `$$x$$` and
//                           `$$\nx\n$$` are different values and each writes itself back
//
// The TeX is the source, not a decoded string: nothing inside a formula is a markdown escape,
// so `\&`, `\\` and `\_` reach Temml as the file wrote them.

/** The from-markdown extension: token names to mdast nodes. */
export function mathFromMarkdown() {
  return {
    enter: {
      oseMathText: enterInline,
      oseMathFlow: enterBlock,
    },
    exit: {
      oseMathTextValue: exitInlineValue,
      oseMathText: exitNode,
      oseMathFlowFence: exitBlockFence,
      oseMathFlowValue: exitBlockValue,
      oseMathFlow: exitBlock,
    },
  };

  function enterInline(token) {
    this.enter({ type: 'inlineMath', value: '' }, token);
  }

  function exitInlineValue(token) {
    this.stack[this.stack.length - 1].value = this.sliceSerialize(token);
  }

  function exitNode(token) {
    this.exit(token);
  }

  function enterBlock(token) {
    this.enter({ type: 'mathBlock', value: '' }, token);
    this.data.oseMath = { open: 0, close: 0, parts: [] };
  }

  /**
   * The two fences say which lines hold the formula, and the value tokens say what is on them.
   * Counting lines rather than joining the tokens is what keeps a blank line inside a display
   * formula, which has no token of its own to be remembered by.
   */
  function exitBlockFence(token) {
    const d = this.data.oseMath;
    if (!d) return;
    if (!d.open) d.open = token.end.line;
    else d.close = token.start.line;
  }

  function exitBlockValue(token) {
    const d = this.data.oseMath;
    if (d) d.parts.push({ line: token.start.line, text: this.sliceSerialize(token) });
  }

  function exitBlock(token) {
    const d = this.data.oseMath || { open: 0, close: 0, parts: [] };
    const node = this.stack[this.stack.length - 1];
    let raw = '';
    let line = d.open;
    for (const part of d.parts) {
      raw += '\n'.repeat(Math.max(0, part.line - line)) + part.text;
      line = part.line;
    }
    raw += '\n'.repeat(Math.max(0, d.close - line));
    node.value = raw;
    this.data.oseMath = undefined;
    this.exit(token);
  }
}

/**
 * The to-markdown extension.
 *
 * Every `$` in ordinary text is escaped, without exception. Anything cleverer has to reason
 * about what the `$` three words further on is going to do, and a rule that is right nine times
 * out of ten writes a formula into the middle of a sentence about money. The backslashes come
 * off again in `postProcess` (stringify.js), which can see the whole line and put the file's own
 * spelling back wherever doing so provably changes no formula.
 */
export function mathToMarkdown() {
  inlineMath.peek = () => '$';
  return {
    unsafe: [{ character: '$', inConstruct: 'phrasing' }],
    handlers: { inlineMath, mathBlock },
  };

  function inlineMath(node) {
    return `$${node.value || ''}$`;
  }

  function mathBlock(node) {
    return `$$${node.value || ''}$$`;
  }
}

/** The remark plugin: one call registers the syntax and both directions of the tree. */
export function remarkOseMath() {
  const data = this.data();
  const add = (field, value) => {
    const list = data[field] ? data[field] : (data[field] = []);
    list.push(value);
  };
  add('micromarkExtensions', mathSyntax);
  add('fromMarkdownExtensions', mathFromMarkdown());
  add('toMarkdownExtensions', mathToMarkdown());
}

// ---------------------------------------------------------------------------
// marked, for `render()`
//
// The same two rules again, because marked has a tokenizer of its own and no way to borrow
// micromark's. The renderer writes a placeholder and not the MathML: `render()` puts everything
// through DOMPurify, whose html profile does not know MathML and would take a `<math>` element
// apart. So the TeX travels as the placeholder's text and `paintMath` fills it in afterwards,
// which is also the only moment at which the element is certainly in a document.

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const placeholder = (tex, display) =>
  `<${display ? 'div' : 'span'} class="ose-math${display ? ' ose-math-display' : ''}" data-math="1">`
  + `${escapeHtml(tex)}</${display ? 'div' : 'span'}>`;

/** The marked extension. `marked.use(markedMath)` on an instance of its own, never the global. */
export const markedMath = {
  extensions: [
    {
      name: 'oseMathBlock',
      level: 'block',
      // No `start`: a display formula does not cut a paragraph short, because the micromark
      // construct does not interrupt one either, and the two surfaces have to agree.
      tokenizer(src) {
        if (!opensDisplay(src)) return undefined;
        const open = src.indexOf('$$') + 2;
        // The closing fence is the first `$$` with nothing but whitespace after it on its line.
        let at = open;
        for (;;) {
          at = src.indexOf('$$', at);
          if (at < 0) return undefined;
          const nl = src.indexOf('\n', at + 2);
          if (/^\s*$/.test(nl < 0 ? src.slice(at + 2) : src.slice(at + 2, nl))) {
            const end = nl < 0 ? src.length : nl;
            return { type: 'oseMathBlock', raw: src.slice(0, end), text: src.slice(open, at) };
          }
          at += 1;
        }
      },
      renderer(token) { return placeholder(String(token.text).trim(), true) + '\n'; },
    },
    {
      name: 'oseMathInline',
      level: 'inline',
      // Only a `$` that really opens a formula stops the run of text in front of it.
      start(src) {
        for (let i = src.indexOf('$'); i >= 0; i = src.indexOf('$', i + 1)) {
          if (inlineMathEnd(src, i) >= 0) return i;
        }
        return undefined;
      },
      tokenizer(src) {
        const end = inlineMathEnd(src, 0);
        if (end < 0) return undefined;
        return { type: 'oseMathInline', raw: src.slice(0, end), text: src.slice(1, end - 1) };
      },
      renderer(token) { return placeholder(String(token.text), false); },
    },
  ],
};

/**
 * Turn every placeholder in a rendered element into MathML, in place. Called once by `render()`
 * after the sanitiser has had the HTML, so nothing Temml writes is ever parsed as markup.
 */
export function paintMath(box) {
  for (const el of box.querySelectorAll('[data-math]')) {
    el.replaceWith(renderMath(el.textContent, { display: el.classList.contains('ose-math-display') }));
  }
}
