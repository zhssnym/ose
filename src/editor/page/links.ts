// Part of the markdown page (../page.ts). Links into an open page, rewritten when a file they name
// moves.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installLinks(ctx)`, and reaches the rest through `ctx`.

import { log, planRewrite } from '../host.ts';
import { closeHistory } from '@milkdown/kit/prose/history';
import * as P from '../paths.ts';
import { editorView, errText } from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installLinks(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // links into an open page (H5, §4.8)

  /**
   * The core moved files (`pairs`, `[{from, to}]`) and asks this page, which holds `target`,
   * to rewrite its links instead of the file on disk being written behind it. Source mode
   * applies `ose.links.planRewrite` as one CodeMirror change; the rich view rewrites the link
   * marks and images whose target moved, in one ProseMirror transaction. Either is an edit of
   * its own in the undo history: the page is dirty, and autosave writes it through the guard
   * as always. `o.settled`: this file's own hrefs were already rewritten for the move, so only
   * links into the moved files are looked at (the core's second pass).
   */
  async function rewriteLinks(target, pairs, o: any = {}): Promise<{ handled: boolean; changed?: number; failed?: string; }> {
    const p = ctx.page;
    if (!p || ctx.closed || p.trashed) return { handled: false };
    const list = (Array.isArray(pairs) ? pairs : [])
      .map((x) => ({ from: P.normalize(String((x && x.from) || '')), to: P.normalize(String((x && x.to) || '')) }))
      .filter((x) => x.from && x.to && x.from !== x.to);
    // A file that is not markdown holds no markdown links; the disk path leaves it alone too. A
    // file outside the vault is not part of the vault's links (X7).
    if (!list.length || p.plain || p.outside) return { handled: true, changed: 0 };
    try {
      // Source and Live hold the file's text: the core's plan applies to it as one change.
      const textView = () => (p.source ? p.source : p.live);
      if (textView()) {
        for (let round = 0; round < 2; round++) {
          const tv = textView();
          if (!tv) return { handled: false };
          const text = tv.getText();
          const splices = await planRewrite(text, target, list, o);
          if (splices === null) return { handled: false };
          if (p !== ctx.page || textView() !== tv) return { handled: false };
          // The buffer moved while the plan was being made: plan again over what is there now.
          if (tv.getText() !== text) continue;
          if (!splices.length) return { handled: true, changed: 0 };
          let out = text;
          for (const sp of [...splices].sort((a, b) => b.from - a.from)) out = out.slice(0, sp.from) + sp.insert + out.slice(sp.to);
          if (p.source) p.source.replaceText(out, { edit: true });
          else if (p.live) p.live.replaceMinimal(out, { edit: true });
          log(`links rewritten in the open page ${target}: ${splices.length}`, 'info');
          return { handled: true, changed: splices.length };
        }
        return { handled: true, changed: 0, failed: `${target} kept changing while its links were rewritten` };
      }
      const view = p.crepe ? editorView(p.crepe) : null;
      if (!view) return { handled: false };
      const changed = rewriteRich(view, target, list, o);
      if (changed) log(`links rewritten in the open page ${target}: ${changed}`, 'info');
      return { handled: true, changed };
    } catch (e) {
      log(`links not rewritten in the open page ${target}: ${errText(e)}`, 'warn');
      return { handled: true, changed: 0, failed: errText(e) };
    }
  }

  /**
   * The rich half of `rewriteLinks`, the same decisions the core's disk path makes
   * (links.js `rewriteInboundMany`): a href is resolved against where the page was written
   * (its old path when the page itself moved), and rewritten relative to where it is now when
   * its target moved, or when the page moved and the href would otherwise stop resolving. A
   * vault-root href (`/…`) is left as the disk path leaves it. Answers how many links
   * changed; nothing is dispatched when none did.
   */
  function rewriteRich(view, target, list, o) {
    const toFor = new Map(list.map((x) => [x.from, x.to]));
    const fromFor = o && o.settled ? new Map() : new Map(list.map((x) => [x.to, x.from]));
    const was = fromFor.get(target) || target;
    const moved = was !== target;
    const nextHref = (href) => {
      const raw = String(href ?? '').trim();
      if (!raw || P.isExternal(raw)) return null;
      const at = raw.search(/[#?]/);
      const base = at < 0 ? raw : raw.slice(0, at);
      const tail = at < 0 ? '' : raw.slice(at);
      if (!base) return null;
      const t = P.resolveHref(was, base);
      if (t === null) return null;
      if (!moved && base.startsWith('/')) return null;
      const to = toFor.get(t);
      if (!to && !moved) return null;
      if (!to && base.startsWith('/')) return null;
      const n = P.relativeHref(target, to || t) + tail;
      return n === raw ? null : n;
    };
    const { state } = view;
    const tr = state.tr;
    let changed = 0;
    let lastMark: any = null;
    let lastEnd = -1;
    state.doc.descendants((node, pos) => {
      if (node.isText) {
        for (const m of node.marks) {
          if (m.type.name !== 'link') continue;
          const n = nextHref(m.attrs.href);
          if (n === null) continue;
          const end = pos + node.nodeSize;
          tr.removeMark(pos, end, m);
          tr.addMark(pos, end, m.type.create({ ...m.attrs, href: n }));
          // One link over several text nodes (a bold word inside it) is counted once.
          if (!(lastMark && lastMark.eq(m) && lastEnd === pos)) changed++;
          lastMark = m;
          lastEnd = end;
        }
        return false;
      }
      const name = node.type.name;
      if ((name === 'image' || name === 'image-block') && typeof node.attrs.src === 'string') {
        const n = nextHref(node.attrs.src);
        if (n !== null) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: n }); changed++; }
      }
      return true;
    });
    if (changed) view.dispatch(closeHistory(tr));
    return changed;
  }

  return {
    rewriteLinks,
    rewriteRich,
  };
}
