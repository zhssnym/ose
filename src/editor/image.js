// Images: alt text kept verbatim, size written as `![alt|300](src)`, a missing image that
// names its file, web images downloaded on paste.
//
// Milkdown's image-block node keeps the aspect ratio in the markdown alt slot and has no
// attribute for alt text at all, so a file whose line reads `![Wiring diagram](x.png)` used to
// come back as `![](x.png)`. The schema below is the same node with two attributes added and
// the two markdown runners replaced: `alt` and `width` are what the file carries, Obsidian's
// `alt|300` is the shape, and the ratio is only read, never written.
//
// Exports read by extensions.js: plugins(ctx, o), featureConfig(o), registerCommands(api).

import { CrepeFeature } from '@milkdown/crepe';
import { IMAGE_DATA_TYPE, imageBlockSchema } from '@milkdown/kit/component/image-block';
import { NodeSelection, Plugin } from '@milkdown/kit/prose/state';
import { bridge, commands, copyText } from './host.js';
import { prompt, toast } from './deps.js';
import * as P from './paths.js';

const NODE = 'image-block';

/** Narrower than this and the image is a smudge; the drag stops there. */
const MIN_WIDTH = 60;

/** The api handed over by index.js at boot (registerExtensionCommands). */
let api = null;

/** Markdown srcs whose image failed to load, so the block draws the box that names the file. */
const broken = new Set();

// ---------------------------------------------------------------------------
// the alt slot

/**
 * Read Milkdown's / Obsidian's alt slot.
 *   `Wiring diagram|420` -> { alt: 'Wiring diagram', width: '420' }
 *   `1.00`               -> { alt: '', ratio: 1 }   a file this editor wrote before batch 12
 *   `Wiring diagram`     -> { alt: 'Wiring diagram' }
 */
export function readAlt(raw) {
  const s = String(raw ?? '');
  const sized = /^([\s\S]*)\|(\d{1,5})$/.exec(s);
  if (sized) return { alt: sized[1], width: sized[2], ratio: 1 };
  if (/^\d+\.\d{2}$/.test(s)) {
    const ratio = Number.parseFloat(s);
    return { alt: '', width: '', ratio: Number.isFinite(ratio) && ratio !== 0 ? ratio : 1 };
  }
  return { alt: s, width: '', ratio: 1 };
}

/** The inverse: what goes into the file's alt slot. */
export const writeAlt = (alt, width) => (width ? `${alt || ''}|${width}` : String(alt || ''));

/**
 * The image-block node with `alt` and `width` added. Milkdown builds the schema from the ctx
 * slice `$nodeSchema` registered, and reads it once, after every `editor.config` has run — so
 * updating the slice from `plugins(ctx, o)` (which runs inside a config) replaces the node
 * before the schema exists, without touching Crepe's plugin list.
 */
function extendSchema(ctx) {
  ctx.update(imageBlockSchema.key, (prev) => (c) => {
    const base = prev(c);
    return {
      ...base,
      attrs: {
        ...base.attrs,
        alt: { default: '', validate: 'string' },
        width: { default: '', validate: 'string' },
      },
      parseDOM: [{
        tag: `img[data-type="${IMAGE_DATA_TYPE}"]`,
        getAttrs: (dom) => ({
          src: dom.getAttribute('src') || '',
          caption: dom.getAttribute('caption') || '',
          alt: dom.getAttribute('alt') || '',
          width: dom.getAttribute('width') || '',
          ratio: Number(dom.getAttribute('ratio') ?? 1) || 1,
        }),
      }],
      toDOM: (node) => ['img', {
        'data-type': IMAGE_DATA_TYPE,
        src: node.attrs.src,
        caption: node.attrs.caption || '',
        alt: node.attrs.alt || '',
        width: node.attrs.width || '',
        ratio: String(node.attrs.ratio ?? 1),
      }],
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const { alt, width, ratio } = readAlt(node.alt);
          state.addNode(type, { src: node.url, caption: node.title || '', alt, width, ratio });
        },
      },
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          state.openNode('paragraph');
          state.addNode('image', undefined, undefined, {
            title: node.attrs.caption,
            url: node.attrs.src,
            alt: writeAlt(node.attrs.alt, node.attrs.width),
          });
          state.closeNode();
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// finding an image

/** The `{node, pos}` of the image-block whose node view is `dom`. */
function nodeAtDom(view, dom) {
  let found = null;
  view.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name !== NODE) return true;
    if (view.nodeDOM(pos) === dom) found = { node, pos };
    return false;
  });
  return found;
}

/**
 * The image the commands act on: the selected node, else the nearest image-block to the
 * caret, searching down the document first and then up — the one the user can see.
 */
function currentImage(view) {
  if (!view) return null;
  const sel = view.state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === NODE) {
    return { node: sel.node, pos: sel.from };
  }
  const all = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === NODE) all.push({ node, pos });
    return node.type.name !== NODE;
  });
  if (!all.length) return null;
  const at = sel.from;
  let best = all[0];
  let dist = Math.abs(all[0].pos - at);
  for (const c of all) {
    const d = Math.abs(c.pos - at);
    if (d < dist) { best = c; dist = d; }
  }
  return best;
}

const pagePath = () => (api && api.getPath ? api.getPath() : null);

/** The vault path an image src points at, or null for an external URL. */
function vaultPathOf(src) {
  const s = String(src || '');
  const from = pagePath();
  if (!s || !from || P.isExternal(s) || s.startsWith('blob:') || s.startsWith('data:')) return null;
  return P.resolveHref(from, s);
}

function setAttr(view, pos, attr, value) {
  view.dispatch(view.state.tr.setNodeAttribute(pos, attr, value));
  if (api && api.touch) api.touch();
}

// ---------------------------------------------------------------------------
// the box a missing image draws

function missingBox(view, host, node, pos) {
  const box = document.createElement('div');
  box.className = 'ed-image-missing';
  box.contentEditable = 'false';

  // The app's own error chip, so a missing image is marked the way everything else is.
  const why = document.createElement('span');
  why.className = 'chip err';
  why.textContent = 'image not found';

  const name = document.createElement('div');
  name.className = 'ed-image-name';
  name.textContent = String(node.attrs.src || '(no path)');

  const acts = document.createElement('div');
  acts.className = 'ed-image-acts';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn sm';
  open.textContent = 'open folder';
  open.addEventListener('click', (e) => {
    e.preventDefault();
    const target = vaultPathOf(node.attrs.src);
    if (target) void bridge.reveal(target); else toast('that image is a link, not a file', 'warn');
  });
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn sm';
  edit.textContent = 'edit path';
  edit.addEventListener('click', async (e) => {
    e.preventDefault();
    const next = await prompt({ title: 'Image path', value: String(node.attrs.src || ''), ok: 'Set' });
    if (!next) return;
    const live = nodeAtDom(view, host);
    if (!live) return;
    broken.delete(String(node.attrs.src || ''));
    setAttr(view, live.pos, 'src', next);
  });
  acts.append(open, edit);

  box.append(why, name);
  if (node.attrs.alt) {
    const alt = document.createElement('div');
    alt.className = 'ed-image-alt';
    alt.textContent = node.attrs.alt;
    box.append(alt);
  }
  box.append(acts);
  void pos;
  return box;
}

/**
 * Put the width and the missing-image box on the DOM after every document change. A pass over
 * the node views rather than decorations, because the node view is a mounted Vue app and its
 * root element is the only stable thing to hang either of them on.
 */
function syncBlocks(view) {
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== NODE) return true;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return false;

    const w = Number.parseInt(node.attrs.width, 10);
    if (w > 0) {
      dom.dataset.osWidth = String(w);
      dom.style.setProperty('--os-image-width', `${w}px`);
    } else {
      delete dom.dataset.osWidth;
      dom.style.removeProperty('--os-image-width');
    }

    const gone = broken.has(String(node.attrs.src || ''));
    const box = dom.querySelector(':scope > .ed-image-missing');
    dom.classList.toggle('ed-missing', gone);
    if (gone && !box) dom.append(missingBox(view, dom, node, pos));
    else if (!gone && box) box.remove();
    else if (gone && box) {
      const name = box.querySelector('.ed-image-name');
      if (name) name.textContent = String(node.attrs.src || '(no path)');
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// the plugin

export function plugins(ctx, o) {
  try { extendSchema(ctx); } catch (e) { console.error('[editor] image schema', e); }
  void o;

  let sync = () => {};
  return [new Plugin({
    view: (view) => {
      sync = () => { try { syncBlocks(view); } catch (e) { console.error('[editor] image sync', e); } };
      // The node views mount a frame after the editor does, so the first pass waits for them.
      requestAnimationFrame(sync);
      const onDown = (e) => resizeFrom(view, e);
      // Capture, on the editor's own element: the gesture has to be taken away from Crepe's
      // handler, which is bound to the handle itself and would otherwise run first.
      view.dom.addEventListener('pointerdown', onDown, true);
      return {
        update: (v, prev) => { if (v.state.doc !== prev.doc) requestAnimationFrame(sync); },
        destroy: () => { sync = () => {}; view.dom.removeEventListener('pointerdown', onDown, true); },
      };
    },
    props: {
      handlePaste: (view, event) => webImagePaste(view, event),
    },
  })];
}

/**
 * The resize, rewritten as a width drag (E38).
 *
 * Crepe's handle drags the image's **height** and stores the result as a ratio in the markdown
 * alt slot — a Milkdown-ism twice over: markdown has no aspect ratio, and a block image here is
 * always the column's width, so the gesture distorts the picture instead of sizing it. What
 * markdown (Obsidian's markdown) does have is `![alt|300](src)`, a width in pixels. So the
 * pointerdown is taken before Crepe sees it and the drag sets the width, which is what the file
 * then carries and what a reload renders from. Dragging back out to the full column clears it.
 */
function resizeFrom(view, e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const handle = t.closest('.image-resize-handle');
  if (!handle) return;
  const host = handle.closest('.milkdown-image-block');
  const img = host ? host.querySelector('img') : null;
  if (!host || !img || !view.editable) return;
  e.preventDefault();
  e.stopPropagation();

  const left = img.getBoundingClientRect().left;
  const max = Math.round(host.getBoundingClientRect().width);
  const widthAt = (ev) => Math.max(MIN_WIDTH, Math.min(Math.round(ev.clientX - left), max));
  const paint = (w) => {
    host.dataset.osWidth = String(w);
    host.style.setProperty('--os-image-width', `${w}px`);
  };
  const move = (ev) => paint(widthAt(ev));
  const up = (ev) => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    const w = widthAt(ev);
    const live = nodeAtDom(view, host);
    if (!live) return;
    // At the column's full width there is nothing to say, and the file keeps a plain `![alt]`.
    setAttr(view, live.pos, 'width', w >= max ? '' : String(w));
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
}

export function featureConfig() {
  return {
    [CrepeFeature.ImageBlock]: {
      onImageLoadError: (e) => {
        const img = e && e.target;
        if (!(img instanceof HTMLElement)) return;
        const host = img.closest('.milkdown-image-block');
        const view = api && api.getView ? api.getView() : null;
        if (!host || !view) return;
        const live = nodeAtDom(view, host);
        if (!live) return;
        broken.add(String(live.node.attrs.src || ''));
        try { syncBlocks(view); } catch (err) { console.error('[editor] image error box', err); }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// an image copied from a web page (E36)

/**
 * Milkdown's uploader refuses any paste that also carries `text/html`, which is every image
 * copied from a browser, and the clipboard plugin then keeps the remote `src` — a vault page
 * pointing at somebody else's server. Fetch the bytes into the page's `attachments/` folder
 * instead. A WebView that refuses the cross-origin read keeps the link and says so.
 */
function webImagePaste(view, event) {
  const dt = event && event.clipboardData;
  if (!dt || !api || !api.attachFile) return false;
  if (dt.files && dt.files.length) return false;                  // a real file: Milkdown's
  const html = dt.getData('text/html');
  if (!html || !/<img\b/i.test(html)) return false;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgs = doc.querySelectorAll('img');
  if (imgs.length !== 1) return false;
  // Only a bare image: a paste of a paragraph that happens to hold one is ordinary rich text.
  if ((doc.body.textContent || '').trim()) return false;
  const url = imgs[0].getAttribute('src') || '';
  if (!/^https?:/i.test(url)) return false;
  const alt = imgs[0].getAttribute('alt') || '';

  event.preventDefault();
  void (async () => {
    let src = url;
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (!/^image\//.test(blob.type)) throw new Error('not an image');
      const name = P.basename(new URL(url).pathname) || 'image';
      const target = await api.attachFile(new File([blob], name, { type: blob.type }));
      src = P.relativeHref(pagePath(), target);
    } catch {
      toast('kept as a link: this image could not be downloaded', 'warn');
    }
    const type = view.state.schema.nodes[NODE];
    if (!type) return;
    const node = type.create({ src, alt, caption: '', width: '', ratio: 1 });
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
    if (api && api.touch) api.touch();
  })();
  return true;
}

// ---------------------------------------------------------------------------
// commands

const withImage = (fn) => () => {
  const view = api && api.getView ? api.getView() : null;
  const hit = currentImage(view);
  if (!hit) { toast('no image on this page', 'info'); return; }
  fn(view, hit);
};

const hasImage = () => {
  if (!api || !api.hasPage() || !api.getView) return false;
  return !!currentImage(api.getView());
};

export function registerCommands(a) {
  api = a;
  commands.register({
    id: 'image.open', title: 'Open image', group: 'image', when: hasImage,
    run: withImage((view, hit) => {
      const src = String(hit.node.attrs.src || '');
      const target = vaultPathOf(src);
      if (!target) { if (src) void bridge.openExternal(src); return; }
      if (typeof bridge.openPath === 'function') void bridge.openPath(target).catch(() => bridge.reveal(target));
      else void bridge.reveal(target);
    }),
  });
  commands.register({
    id: 'image.copy-path', title: 'Copy image path', group: 'image', when: hasImage,
    run: withImage(async (view, hit) => {
      const src = String(hit.node.attrs.src || '');
      const text = vaultPathOf(src) || src;
      if (!text) { toast('this image has no path', 'info'); return; }
      const ok = await copyText(text);
      toast(ok ? 'copied' : 'copy failed', ok ? 'info' : 'err');
    }),
  });
  commands.register({
    id: 'image.caption', title: 'Toggle image caption', group: 'image', when: hasImage,
    run: withImage((view, hit) => {
      const dom = view.nodeDOM(hit.pos);
      const toggle = dom instanceof HTMLElement ? dom.querySelector('.operation-item') : null;
      // The component listens on pointerdown only (it is mouse-only by design); this is the
      // keyboard's way in, and it is the same event the mouse sends.
      if (!toggle) { toast('this image has no caption to toggle', 'info'); return; }
      toggle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      if (api && api.touch) api.touch();
    }),
  });
}
