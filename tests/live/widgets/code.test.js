// @vitest-environment happy-dom
// Live's code blocks: the nested languages, the box on every line, and the dimmed fences.

import './dom-shim.js';
import { LanguageDescription, syntaxTree } from '@codemirror/language';
import { languages as PACK } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { code, fenceLanguage, languages } from '../../../src/editor/live/widgets/code.ts';
import { ctxOf, decorations, stateOf } from './support.js';

const DOC = 'Text\n\n```python\nx = 1\n\nprint(x)\n```\n\nAfter\n';

describe('code', () => {
  it('hands the core @codemirror/language-data as its code languages, with the short names', () => {
    expect(code.languages).toBe(languages);
    // Every pack entry is there (a copy where a short name was added), plus plain text.
    expect(languages.length).toBe(PACK.length + 1);
    expect(languages.map((d) => d.name).slice(1)).toEqual(PACK.map((d) => d.name));
    expect(code.kind).toBe('inline');
    expect(code.nodes).toEqual(['FencedCode']);
  });

  it('decorate dims only the fence marks and the language name', () => {
    const state = stateOf(DOC);
    const out = decorations(code, ctxOf(state));
    expect(out.map((d) => DOC.slice(d.from, d.to))).toEqual(['```', 'python', '```']);
    for (const d of out) expect(d.deco.spec.class).toBe('cm-live-code-mark');
  });

  it('every line of the block is boxed, fences included, and nothing else', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({ state: stateOf(DOC, [code.extension || []]), parent });
    try {
      const lines = [...view.dom.querySelectorAll('.cm-line')];
      const boxed = lines.map((l) => l.classList.contains('cm-live-codeblock'));
      expect(boxed).toEqual([false, false, true, true, true, true, true, false, false, false]);
      expect(lines[2]?.classList.contains('cm-live-codeblock-first')).toBe(true);
      expect(lines[6]?.classList.contains('cm-live-codeblock-last')).toBe(true);
      expect(view.state.doc.toString()).toBe(DOC);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe('fence names', () => {
  const match = (name) => LanguageDescription.matchLanguageName(languages, name, true)?.name ?? null;

  it.each([
    ['py', 'Python'], ['python', 'Python'], ['rs', 'Rust'], ['md', 'Markdown'], ['kt', 'Kotlin'],
    ['ps1', 'PowerShell'], ['golang', 'Go'], ['js', 'JavaScript'], ['ts', 'TypeScript'],
    ['yml', 'YAML'], ['sh', 'Shell'],
  ])('```%s is %s', (name, want) => {
    expect(match(name)).toBe(want);
  });

  it('```text is plain, not LaTeX (the pack reads `text` as holding `tex`)', () => {
    expect(LanguageDescription.matchLanguageName(PACK, 'text', true)?.name).toBe('LaTeX');
    for (const name of ['text', 'plaintext', 'txt', 'plain']) expect(match(name)).toBe('Plain text');
  });

  it('a copy loads through the pack entry, so a grammar is fetched once', async () => {
    const py = languages.find((d) => d.name === 'Python');
    const orig = PACK.find((d) => d.name === 'Python');
    expect(py).not.toBe(orig);
    const support = await py?.load();
    expect(support).toBe(orig?.support);
  });

  it('fenceLanguage: the pack name the Reading view asks for', () => {
    expect(fenceLanguage('py')).toBe('python');
    expect(fenceLanguage(' PY ')).toBe('python');
    expect(fenceLanguage('text')).toBe('');
    expect(fenceLanguage('js')).toBe('js');
  });

  it('a ```py block is parsed as Python, and a ```text one as plain', async () => {
    // The nested parser loads a grammar lazily; once it is in, the block is Python's.
    await languages.find((d) => d.name === 'Python')?.load();
    const doc = '```py\nx = 1\n```\n\n```text\nx = 1\n```\n';
    const state = stateOf(doc);
    expect(syntaxTree(state).resolveInner(doc.indexOf('1'), 1).name).toBe('Number');
    const plain = syntaxTree(state).resolveInner(doc.lastIndexOf('1'), 1).name;
    expect(plain).not.toBe('Number');
    expect(state.doc.toString()).toBe(doc);
  });
});
