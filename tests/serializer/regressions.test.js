// Named regressions: every serialiser finding of the audit that came with a repro (audit.json,
// work/audit/roundtrip/*.mjs), and the crash that lost Hassan's notes (fixed in ecb46ae). Each
// test is the repro, run through the guard the page uses, with the outcome the report asks for.
//
// Depends on: serializer (CONTRACT 7.3). Until stringify.js, space.js and fidelity.js carry the
// fixes, the C9, C11, H2, H3, M6, M7 and M8 cases fail here, on purpose: they say what the fix
// has to do. The crash cases and the guard cases pass on the stand-ins already.

import { Transform } from '@milkdown/kit/prose/transform';
import { describe, expect, it } from 'vitest';
import { composeDoc, parseDoc } from '../../src/editor/doc.ts';
import { codeOf, endOfBlock, hasMark, insertParaAt, lastTextEnd, para, tops, typeAt } from '../support/docs.js';
import { pipeline } from '../support/pipeline.js';

/** Milkdown logs, and goes on, when the schema refuses a node. */
function quiet(fn) {
  const log = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = log; }
}

/** Save `edit(doc)` of the file `md`: the guard's answer, and the document its text reads back as. */
async function save(md, edit = (d) => d) {
  const P = await pipeline();
  const doc = quiet(() => P.engine.parse(md));
  const edited = edit(doc, P.engine.schema ?? doc.type.schema);
  const w = P.checkWrite(edited, md);
  const back = w.text === null ? null : quiet(() => P.engine.parse(w.text));
  return { P, doc, edited, w, back, same: back !== null && P.docsEqual(back, edited) };
}

/** A save the guard lets through, and that means what is on screen. */
function writable(r) {
  expect(r.w.status, `${r.w.status}: ${r.w.reason}\n${JSON.stringify(r.w.text)}`).not.toBe('unsafe');
  expect(r.same, `reads back differently:\n${JSON.stringify(r.w.text)}`).toBe(true);
}

/** A save that is `ok`: the reconciled text, untouched blocks as they were. */
function exact(r, text) {
  expect(r.w.status, `${r.w.status}: ${r.w.reason}\n${JSON.stringify(r.w.text)}`).toBe('ok');
  expect(r.same).toBe(true);
  if (text !== undefined) expect(r.w.text).toBe(text);
}

const mark = (name, from, to) => (d) => new Transform(d).addMark(from, to, d.type.schema.marks[name].create()).doc;

// ---------------------------------------------------------------------------------------------

describe('the crash that lost the notes (claim/confirmed, ecb46ae)', () => {
  it('reconcile past the end of the canonical blocks does not throw', async () => {
    const { S } = await pipeline();
    expect(() => S.reconcile('a\n\nX\n', 'a\n\nb\n\nc\n', { canon: (t) => t })).not.toThrow();
  });

  // work/audit/roundtrip/crash2.mjs and repro.mjs `crash`.
  const P2 = (d, t) => d.type.schema.nodes.paragraph.create(null, d.type.schema.text(t));
  const cases = {
    'merge two paragraphs (Backspace at the start of the second)': ['para one\n\npara two\n', (d) => new Transform(d).join(d.child(0).nodeSize).doc],
    'merge the last two of three': ['a\n\nb\n\nc\n', (d) => new Transform(d).join(d.child(0).nodeSize + d.child(1).nodeSize).doc],
    'select all and type': ['a\n\nb\n\nc\n', (d) => new Transform(d).replaceWith(0, d.content.size, P2(d, 'x')).doc],
    'edit the first of two blocks and delete the second': ['# H\n\ntext\n', (d) => { const t = new Transform(d).delete(d.child(0).nodeSize, d.content.size); t.insert(2, d.type.schema.text('X')); return t.doc; }],
    'delete the first block of a heading and table file': ['### Head\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n', (d) => new Transform(d).delete(0, d.child(0).nodeSize).doc],
    'edit the second-to-last paragraph and delete the last one': ['p1\n\np2\n\np3\n', (d) => { const T = tops(d); const tr = new Transform(d).delete(T[2].offset, d.content.size); tr.insert(endOfBlock(tr.doc, 1), d.type.schema.text('x')); return tr.doc; }],
    'delete from the middle of the last-but-one to the end': ['a\n\nb\n\nc\n', (d) => { const T = tops(d); return new Transform(d).delete(T[1].offset + 2, d.content.size - 1).doc; }],
  };
  for (const [name, [md, edit]] of Object.entries(cases)) {
    it(name, async () => {
      const r = await save(md, edit);
      writable(r);
    });
  }
});

// ---------------------------------------------------------------------------------------------

describe('C8: a save never changes what the text means', () => {
  it('a literal \\[not a link\\](x) stays text when its paragraph is edited', async () => {
    const md = 'Math 2\\*3\\*4 and snake\\_case\\_name and \\[not a link\\](x) end.\n';
    const r = await save(md, (d) => typeAt(d, lastTextEnd(d), ' X'));
    exact(r);
    expect(hasMark(r.back, 'link')).toBe(false);
    expect(r.back.textContent).toContain('[not a link](x)');
  });

  // esc.mjs: typed text that postProcess used to turn into live markdown. The raw serializer
  // output was right in every one; the clean-up made it a link, an image, a hidden definition
  // or a code block.
  const typed = {
    'Body text.[x](y)': (b) => !hasMark(b, 'link'),
    '![i](x.png)': (b) => { let img = false; b.descendants((n) => { if (/image/.test(n.type.name)) img = true; return true; }); return !img; },
    '[x]: http://y': (b) => b.textContent.includes('[x]: http://y'),
    '    four': (b) => codeOf(b) === null,
    '[x](y) and [z]': (b) => !hasMark(b, 'link'),
  };
  for (const [text, holds] of Object.entries(typed)) {
    it(`typing ${JSON.stringify(text)} writes it as text`, async () => {
      const r = await save('Body text.\n', (d) => new Transform(d).replaceWith(0, d.content.size, para(d.type.schema, text)).doc);
      writable(r);
      expect(holds(r.back), JSON.stringify(r.w.text)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------------------------

describe('C9: code and maths inside containers keep their backslashes', () => {
  const BS = '\\';
  const code = `x = re.sub(r"${BS}[${BS}|${BS}#tag${BS}]", "${BS}$5 ${BS}~ ${BS}_a", s)  # a${BS}&b ${BS}*`;
  const cases = {
    'a fence in a quote': `> \`\`\`py\n> ${code}\n> \`\`\`\n\nAfter.\n`,
    'a fence in a nested list item': `- a\n  - b\n\n    \`\`\`py\n    ${code}\n    \`\`\`\n\nAfter.\n`,
    'a fence at the top level': `\`\`\`py\n${code}\n\`\`\`\n\nAfter.\n`,
    'display maths in a quote': `> $$\n> a ${BS}# b ${BS}[c${BS}]\n> $$\n\nAfter.\n`,
    'a fence in a callout': `> [!note] Title\n> \`\`\`sh\n> grep "${BS}[x${BS}]" f\n> \`\`\`\n\nAfter.\n`,
  };
  for (const [name, md] of Object.entries(cases)) {
    it(`${name}: an edit elsewhere keeps the block byte for byte`, async () => {
      const r = await save(md, (d) => typeAt(d, lastTextEnd(d), '!'));
      exact(r, md.replace(/After\.\n$/, 'After.!\n'));
      expect(codeOf(r.back)).toBe(codeOf(r.doc));
    });
    it(`${name}: the canonical text keeps the code`, async () => {
      const { P } = await save(md);
      const doc = quiet(() => P.engine.parse(md));
      const canonical = P.engine.canonicalise(md);
      expect(codeOf(quiet(() => P.engine.parse(canonical))), JSON.stringify(canonical)).toBe(codeOf(doc));
    });
  }

  it('an edit inside a quoted fence keeps the rest of the code', async () => {
    const md = cases['a fence in a quote'];
    const r = await save(md, (d) => {
      let at = null;
      d.descendants((n, pos) => { if (at === null && n.type.name === 'code_block') at = pos + 1; return true; });
      return typeAt(d, at, 'y = 1\n');
    });
    writable(r);
    expect(codeOf(r.back)).toBe(`y = 1\n${code}`);
  });
});

// ---------------------------------------------------------------------------------------------

describe('C11: a new block at the top writes only that block', () => {
  // top.mjs: before the fix the whole file came back in remark's house style.
  const top = 'Intro paragraph.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n* star item\n* two\n    * four-space nested\n\nline one  \nline two\n\nSetext\n------\n\nMail [me@x.fr](mailto:me@x.fr), see <https://x.fr> and snake\\_case.\n\n> ```sh\n> grep "\\[x\\]" f\n> ```\n';

  it('a paragraph typed above the first paragraph', async () => {
    exact(await save(top, (d) => insertParaAt(d, 0, 'New first line')), `New first line\n\n${top}`);
  });

  it('the same edit one block lower', async () => {
    const [first, ...rest] = top.split('\n\n');
    exact(await save(top, (d) => insertParaAt(d, 1, 'New second line')), `${first}\n\nNew second line\n\n${rest.join('\n\n')}`);
  });

  // repro2.mjs `insertBefore`.
  const before = {
    'an escaped paragraph': 'a \\* b \\_c\\_ \\# not \\[x\\] AT&amp;T &copy; \\$5\n',
    'a hard-break paragraph': 'line one  \nline two\\\nline three\n',
    'a mailto link': 'Write to [a@b.com](mailto:a@b.com) or <c@d.com>.\n',
    'an autolink': 'Go <https://x.com> or https://y.com.\n',
    'non-breaking spaces': '&nbsp;&nbsp;two nbsp\n',
    'a setext heading': 'text\n---\nmore\n',
    'a two-block file': 'first\n\na \\* b\n',
    'a list': '* a\n* b\n    * c\n',
    'a table': '|x|y|\n|-|-|\n|1|2|\n',
    'an ordered list': '2) two\n3) three\n',
  };
  for (const [name, md] of Object.entries(before)) {
    it(`a paragraph above ${name}`, async () => {
      exact(await save(md, (d) => insertParaAt(d, 0, 'inserted')), `inserted\n\n${md}`);
    });
  }

  it('a paragraph between two blocks', async () => {
    const md = 'first\n\nsecond \\* x\n\nthird \\* y\n';
    exact(await save(md, (d) => insertParaAt(d, 1, 'inserted')), 'first\n\ninserted\n\nsecond \\* x\n\nthird \\* y\n');
  });

  it('a paragraph above an indented code block', async () => {
    const md = 'para\n\n    code\n    more\n';
    exact(await save(md, (d) => insertParaAt(d, 1, 'inserted')), 'para\n\ninserted\n\n    code\n    more\n');
  });
});

// ---------------------------------------------------------------------------------------------

describe('H2: text typed after html stays text', () => {
  const html = '<div>\nhtml block\n</div>\n\nline one<br>line two\n\n<!-- comment -->\n';

  it('typed after an html comment', async () => {
    const r = await save('<!-- comment -->\n', (d) => typeAt(d, endOfBlock(d, 0), ' zz'));
    exact(r);
    expect(r.back.textContent).toContain('zz');
  });

  it('typed after an html block, the rest deleted', async () => {
    const r = await save(html, (d) => {
      const T = tops(d);
      const tr = new Transform(d).delete(T[1].offset, d.content.size);
      return tr.insert(endOfBlock(tr.doc, 0), d.type.schema.text(' zz')).doc;
    });
    exact(r);
    expect(r.back.textContent).toContain('zz');
  });

  it('typed after the last html comment of a file', async () => {
    const r = await save(html, (d) => typeAt(d, endOfBlock(d, tops(d).length - 1), ' zz'));
    exact(r);
  });

  it('typed before an html block', async () => {
    const r = await save(html, (d) => typeAt(d, 1, '[x]'));
    writable(r);
    expect(r.back.textContent).toContain('[x]');
  });

  it('two paragraphs holding html, joined', async () => {
    const r = await save(html, (d) => new Transform(d).join(d.child(0).nodeSize).doc);
    writable(r);
  });
});

// ---------------------------------------------------------------------------------------------

describe('H3: emphasis inside a word is written with *', () => {
  it('italic on part of a word', async () => {
    const r = await save('alpha beta\n', mark('emphasis', 2, 3));
    exact(r, 'a*l*pha beta\n');
  });

  it('bold on part of a word', async () => {
    const r = await save('alpha beta\n', mark('strong', 2, 3));
    exact(r);
    expect(hasMark(r.back, 'strong')).toBe(true);
  });

  it('italic on a colon between a word and a space', async () => {
    const r = await save('Rent: 500\n', mark('emphasis', 5, 6));
    exact(r);
    expect(hasMark(r.back, 'emphasis')).toBe(true);
  });

  it('letters typed right after an italic word', async () => {
    const r = await save('an _em_ word\n', (d) => typeAt(d, 1 + 'an em'.length, 'Q'));
    exact(r);
    expect(hasMark(r.back, 'emphasis')).toBe(true);
  });

  it('an untouched _underscore_ italic keeps its underscores', async () => {
    const r = await save('Some _words_ here.\n\nOther.\n', (d) => typeAt(d, lastTextEnd(d), '!'));
    exact(r, 'Some _words_ here.\n\nOther.!\n');
  });
});

// ---------------------------------------------------------------------------------------------

describe('C10: the open-time check sees what the parser dropped', () => {
  // drop.mjs: the footnote definition cannot hold the html, the parser logs and drops it, and
  // the next unrelated save deleted it from disk.
  const dropped = {
    'a footnote holding an html block': 'Intro[^1].\n\n[^1]: note\n    <div>block</div>\n\nAfter.\n',
    'a footnote followed by an html line': 'Intro[^1].\n\n[^1]: A long note\n<br>\nsecond line of the note\n\nAfter.\n',
  };
  for (const [name, md] of Object.entries(dropped)) {
    it(`${name}: checkOpen says so`, async () => {
      const P = await pipeline();
      const doc = quiet(() => P.engine.parse(md));
      const r = quiet(() => P.checkOpen(md, doc));
      expect(r.ok, JSON.stringify(r)).toBe(false);
      expect(typeof r.reason).toBe('string');
      expect(Array.isArray(r.missing)).toBe(true);
    });
  }

  it('a page that holds everything passes', async () => {
    const P = await pipeline();
    const md = 'Intro[^1].\n\n[^1]: The note.\n\n<div>\nblock\n</div>\n\nAfter.\n';
    expect(quiet(() => P.checkOpen(md, P.engine.parse(md)))).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------------

describe('M6: a hard break keeps the file\'s spelling', () => {
  it('two trailing spaces', async () => {
    exact(await save('line one  \nline two\n', (d) => typeAt(d, lastTextEnd(d), 'X')), 'line one  \nline twoX\n');
  });

  it('a backslash', async () => {
    exact(await save('line one\\\nline two\n', (d) => typeAt(d, lastTextEnd(d), 'X')), 'line one\\\nline twoX\n');
  });
});

describe('M7: the space around an image survives an edit elsewhere', () => {
  it('blank lines on both sides of an image', async () => {
    const md = 'a\n\n\n\n![](x.png)\n\n\n\nb\n';
    exact(await save(md, (d) => typeAt(d, lastTextEnd(d), '!')), 'a\n\n\n\n![](x.png)\n\n\n\nb!\n');
  });
});

describe('M8: a link whose definition is deleted keeps its target', () => {
  it('deleting the definitions writes the links inline', async () => {
    const md = 'See [docs][d] and [x].\n\n[d]: https://example.com "T"\n[x]: http://x.y\n';
    const r = await save(md, (d) => {
      const tr = new Transform(d);
      const T = tops(d).filter((t) => t.node.type.name === 'definition' || t.node.childCount === 0 || t.index > 0);
      for (const t of T.reverse()) if (t.index > 0) tr.delete(t.offset, t.offset + t.node.nodeSize);
      return tr.doc;
    });
    writable(r);
    const hrefs = [];
    r.back.descendants((n) => { for (const m of n.marks) if (m.type.name === 'link') hrefs.push(m.attrs.href); return true; });
    expect(hrefs).toContain('https://example.com');
    expect(hrefs).toContain('http://x.y');
    expect(r.w.text).not.toMatch(/\[docs\]\[d\]/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('a CRLF file edited in the rich view keeps CRLF and its BOM', () => {
  // The whole file, the way the page writes it: doc.js parseDoc, an edit of the body, the guard,
  // then composeDoc around the text it passed. Every line of a CRLF file ends in CRLF afterwards,
  // the lines the edit added included; the property of the same name draws more of them.
  const saveFile = async (file, edit) => {
    const d = parseDoc(file);
    const r = await save(d.body, edit);
    writable(r);
    return composeDoc(d, { title: d.title, body: r.w.text });
  };
  const noBareLf = (text) => expect(/(^|[^\r])\n/.test(text), JSON.stringify(text)).toBe(false);

  it('a paragraph typed above the only line of a file', async () => {
    const out = await saveFile('\uFEFFpara\r\n', (d) => insertParaAt(d, 0, 'new'));
    expect(out).toBe('\uFEFFnew\r\n\r\npara\r\n');
  });

  it('a paragraph added under the last line of a titled file', async () => {
    const out = await saveFile('\uFEFF# T\r\n\r\none\r\n\r\ntwo\r\n', (d) => insertParaAt(d, d.childCount, 'three'));
    expect(out).toBe('\uFEFF# T\r\n\r\none\r\n\r\ntwo\r\n\r\nthree\r\n');
  });

  it('a paragraph added under a file with no final newline', async () => {
    const out = await saveFile('\uFEFFone\r\n\r\ntwo', (d) => insertParaAt(d, d.childCount, 'three'));
    noBareLf(out);
    expect(out).toBe('\uFEFFone\r\n\r\ntwo\r\n\r\nthree');
  });
});
