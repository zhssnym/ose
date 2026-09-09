// Drops onto the page (CONTRACT.md "Drop onto the page"). Obsidian is the reference.
//
//   files from outside     every file that is not an image is copied to the page's
//                          `attachments/` folder under the name an image would get
//                          (index.js attachFile) and linked by its original name. A drop of
//                          images alone is left to Milkdown's uploader, which makes image
//                          blocks; images that arrive in the same drop as other files are
//                          attached here and become the same image blocks.
//   rows from the sidebar  the internal payload (`application/x-os-path`, a JSON list of
//                          vault paths): a page links by its title, a folder as
//                          `[name](path/)`, any other file by its name. Nothing is copied;
//                          the file is already in the vault.
//
// Every link is the mark the Link command writes (link.js insertLink), never markdown text,
// and its href goes through relativeHref, so it renders, round-trips and follows a rename
// (lib/links.js) exactly like one typed by hand. The plugin goes in front of Milkdown's
// upload plugin: that one claims any drop carrying files — even files it then throws away —
// so it must be asked second.

import { Plugin, PluginKey, Selection } from '@milkdown/kit/prose/state';
import { bridge } from '../bridge/index.js';
import { toast } from './deps.js';
import { pageTitle } from './link.js';
import * as P from './paths.js';

/** The sidebar's private drag type (shell/sidebar.js DRAG_TYPE). */
export const DRAG_TYPE = 'application/x-os-path';
const DROP_KEY = new PluginKey('os-drop');

const isImage = (file) => !!file && /^image\//.test(file.type || '');

/** The list an internal payload holds. A bare path (an older build's payload) is a list of one. */
function parsePaths(data) {
  if (!data) return null;
  const clean = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  try {
    const v = JSON.parse(data);
    if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  } catch { /* not JSON: a bare path */ }
  return [clean(data)].filter(Boolean);
}

/** What a drop carries, or null when it is something else (text, a block moved inside the page). */
export function payloadOf(dataTransfer) {
  if (!dataTransfer) return null;
  const paths = parsePaths(dataTransfer.getData(DRAG_TYPE));
  const files = Array.from(dataTransfer.files || []);
  if (!paths && !files.length) return null;
  return { paths: paths || [], files };
}

/**
 * @param {object} o
 * @param {() => string|null} o.pagePath      the open file (hrefs are relative to it)
 * @param {(file:File) => Promise<string>} o.attach  copy a file into attachments/; the vault path
 */
export function dropPlugin(o) {
  return new Plugin({
    key: DROP_KEY,
    props: {
      handleDrop(view, event) {
        if (!view.editable) return false;
        const payload = payloadOf(event.dataTransfer);
        if (!payload) return false;
        // Images alone are the uploader's (crepe.js onUpload -> index.js uploadImage).
        if (!payload.paths.length && payload.files.every(isImage)) return false;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        void dropInto(view, payload, at ? at.pos : view.state.selection.from, o);
        return true;   // ProseMirror then prevents the default: the text/plain fallback stays out
      },
    },
  });
}

/**
 * Turn a payload into links (and image blocks) at `pos`. Async because a page's title is read
 * from its file and an attachment is written before it can be linked; a failure toasts and
 * the rest still lands. Also called for a drop on the title (index.js), with `pos` 0.
 */
export async function dropInto(view, payload, pos, o) {
  const from = o.pagePath() || '';
  const items = [];
  for (const path of payload.paths) {
    try { items.push(await linkFor(from, path)); } catch (e) { toast(`could not link ${path}: ${e.message || e}`, 'err'); }
  }
  for (const file of payload.files) {
    try {
      const target = await o.attach(file);
      const href = P.relativeHref(from, target) || P.basename(target);
      items.push(isImage(file) ? { image: href } : { text: file.name || P.basename(target), href });
    } catch (e) {
      toast(`could not attach ${file.name || 'the file'}: ${e.message || e}`, 'err');
    }
  }
  if (!items.length || !view.dom.isConnected) return;
  insertItems(view, items, pos);
}

/** `{text, href}` for a vault path: a page by its title, a folder with a trailing slash. */
async function linkFor(from, path) {
  const rel = P.relativeHref(from, path);
  if (/\.md$/i.test(path)) return { text: await pageTitle(path), href: rel || P.basename(path) };
  let dir = false;
  try { dir = (await bridge.stat(path)).kind === 'dir'; } catch { /* unknown: a file link */ }
  // `.` when the page sits inside the folder: relativeHref is empty there, and a bare name
  // would resolve to a folder of that name inside itself.
  return { text: P.basename(path), href: dir ? (rel || '.') + '/' : rel || P.basename(path) };
}

/**
 * Where blocks can go for a drop at `$pos`: `$pos.pos` itself when it sits between blocks,
 * else after the block holding it, climbing out of anything (a table cell, a list item)
 * that cannot take a paragraph there. Null when nothing up to the document can.
 */
function blockSlot($pos, type) {
  for (let d = $pos.depth; d >= 0; d--) {
    const node = $pos.node(d);
    if (node.isTextblock) continue;
    const index = d === $pos.depth ? $pos.index(d) : $pos.index(d) + 1;
    if (node.canReplaceWith(index, index, type)) return d === $pos.depth ? $pos.pos : $pos.after(d + 1);
  }
  return null;
}

/**
 * One link dropped into a paragraph goes inline where it landed, like Obsidian. Everything
 * else — further links, image blocks, a drop on a code block or between blocks — is one
 * block per item after the block at the drop point (one per line). The caret ends after
 * the last one, and the link mark is dropped from the stored marks so typing on does not
 * extend it (link.js insertLink does the same).
 */
function insertItems(view, items, pos) {
  const { state } = view;
  const { schema } = state;
  const link = schema.marks.link;
  const paragraph = schema.nodes.paragraph;
  const imageType = schema.nodes['image-block'] || schema.nodes.image;
  const inlineOf = (it) => schema.text(String(it.text || it.href), link ? [link.create({ href: it.href })] : []);
  const blockOf = (it) => (it.image
    ? (imageType && imageType.createAndFill({ src: it.image })) || paragraph.create(null, schema.text(it.image))
    : paragraph.create(null, inlineOf(it)));

  const size = state.doc.content.size;
  pos = Math.max(0, Math.min(Math.floor(pos) || 0, size));
  const $pos = state.doc.resolve(pos);
  const list = items.slice();
  const tr = state.tr;
  let end = pos;

  if ($pos.parent.isTextblock && !$pos.parent.type.spec.code && list[0].href) {
    const node = inlineOf(list.shift());
    tr.insert(pos, node);
    end = pos + node.nodeSize;
  }
  if (list.length) {
    const blocks = list.map(blockOf);
    let slot = blockSlot(tr.doc.resolve(end), blocks[0].type);
    if (slot === null) slot = tr.doc.content.size;
    tr.insert(slot, blocks);
    end = slot + blocks.reduce((n, b) => n + b.nodeSize, 0) - 1;
  }
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
  if (link) tr.removeStoredMark(link);
  tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
}
