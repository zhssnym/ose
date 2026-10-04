// Part of the markdown page (../page.ts). The save state as the page shows it: the status bar, the
// banner and the dirty mark.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installStatus(ctx)`, and reaches the rest through `ctx`.

import { bus, commands, status, store } from '../host.ts';
import * as P from '../paths.ts';
import { whenLabel } from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installStatus(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // the save state (H8, §6.4)

  /**
   * The note's own title (its H1, or the file's stem), on `store 'pageTitle'` and the handle's
   * `title` event. Wave 2 (M13, W8): the window, the tab and the address bar name the file by its
   * real name and no longer read this; it stays for whoever wants the H1. `null` when no page is
   * open. Only the active page publishes the store key.
   */
  function publishTitle(p) {
    if (!p || !p.path) { if (ctx.isActive()) store.set('pageTitle', null); return; }
    const title = String(p.title || '').trim() || P.stem(p.path);
    if (ctx.isActive()) store.set('pageTitle', { path: p.path, title });
    ctx.emit('title', { path: p.path, title });
  }

  function statusOf(p) {
    if (!p) return 'clean';
    if (p.deleted) return 'deleted';
    if (p.problem) return p.problem.status;
    if (p.saving) return 'saving';
    return p.dirty ? 'dirty' : 'clean';
  }

  function stateOf(p): import('../page.ts').DocState {
    const st = statusOf(p);
    let reason: any = null;
    let message: any = null;
    if (st === 'deleted') { reason = 'gone'; message = `${P.basename(p.path)} was deleted or moved on disk`; }
    else if (p.problem) { reason = p.problem.reason || null; message = p.problem.message || null; }
    return {
      path: p.path, status: st, dirty: !!p.dirty, reason, message, draft: p.draft,
      mode: ctx.publicMode(p), savedAt: p.savedAtMs,
    };
  }

  /**
   * Say the state everywhere it is shown: the bus (`doc:state`, for every page, not only the
   * focused one), the handle, the status bar's `save` field, the banner and the meta line.
   */
  function publishState(p) {
    if (!p || !p.path || p !== ctx.page) return;
    const s = stateOf(p);
    const key = JSON.stringify(s);
    if (key !== p.lastState) {
      p.lastState = key;
      bus.emit('doc:state', s);
      ctx.emit('state', s);
    }
    paintSave(p, s);
    renderBanner(p);
  }

  function paintSave(p, s = stateOf(p)) {
    if (!ctx.isActive()) return;
    const show = () => { void commands.run('page.show-problem'); };
    let value: string | { text: string; kind: string; onClick: () => void; } | null = null;
    switch (s.status) {
      case 'clean': value = p.savedAt ? 'saved ' + p.savedAt : null; break;
      case 'dirty': value = 'unsaved'; break;
      case 'saving': value = 'saving…'; break;
      case 'not-saved': value = { text: 'Not saved', kind: 'err', onClick: show }; break;
      case 'conflict': value = { text: 'Not saved · changed on disk', kind: 'err', onClick: show }; break;
      case 'deleted': value = { text: 'Deleted on disk', kind: p.dirty ? 'err' : 'warn', onClick: show }; break;
      default: value = null;
    }
    const key = value && typeof value === 'object' ? `${value.text}|${value.kind}` : String(value);
    if (key === p.lastSave) return;
    p.lastSave = key;
    status.set('save', value);
  }

  /**
   * What the banner says, or null when there is nothing to say (§6.5).
   */
  function bannerSpec(p): { kind: string; alert: boolean; text: string; buttons: Array<[string, string]>; } | null {
    const st = statusOf(p);
    const name = P.basename(p.path);
    if (st === 'not-saved') {
      if (p.problem.reason === 'unsafe') {
        return {
          kind: 'err', alert: true,
          text: 'The rich view could not write this page exactly. It is open as text: check it and save.',
          buttons: [['Save', 'page.save'], ['Save as…', 'page.save-as'], ['Copy text', 'page.copy-markdown'], ['Discard changes', 'page.discard-changes']],
        };
      }
      const kept = p.draft === 'written' ? 'Your text is kept on this machine.' : 'Copy your text somewhere safe before closing.';
      if (p.problem.reason === 'unencodable') {
        return {
          kind: 'err', alert: true,
          text: `Not saved: the text holds characters ${p.encoding} cannot hold. ${kept}`,
          buttons: [['Save as UTF-8', 'page.save-utf8'], ['Save as…', 'page.save-as'], ['Copy text', 'page.copy-markdown'], ['Discard changes', 'page.discard-changes']],
        };
      }
      return {
        kind: 'err', alert: true,
        text: `Not saved: ${String(p.problem.message || 'the file could not be written').replace(/[.\s]+$/, '')}. ${kept}`,
        buttons: [['Try again', 'page.save'], ['Save as…', 'page.save-as'], ['Copy text', 'page.copy-markdown'], ['Discard changes', 'page.discard-changes']],
      };
    }
    if (st === 'conflict') {
      // H7: only what could not be merged gets here. The buffer is untouched until the user
      // picks one of these; each button is also a command, so the palette reaches them.
      const c = p.conflict || {};
      const n = Number(c.count) || 0;
      if (typeof c.theirs !== 'string') {
        // Read in another encoding, or lossy (X10): the disk is text, read another way than
        // this page's. Take theirs opens it again as it reads now.
        if (c.encoding) {
          return {
            kind: 'err', alert: true,
            text: `Changed on disk while you were editing: ${name} now reads as ${ctx.readAs(c)}.`,
            buttons: [['Keep mine', 'page.merge-keep-mine'], ['Take theirs', 'page.merge-take-theirs'], ['Discard changes', 'page.discard-changes']],
          };
        }
        return {
          kind: 'err', alert: true,
          text: `Changed on disk while you were editing: ${name} is no longer text this editor can show.`,
          buttons: [['Keep mine', 'page.merge-keep-mine'], ['Discard changes', 'page.discard-changes']],
        };
      }
      return {
        kind: 'err', alert: true,
        text: n
          ? `Changed on disk while you were editing: ${n} part${n === 1 ? ' overlaps' : 's overlap'}.`
          : 'Changed on disk while you were editing.',
        buttons: [['Resolve…', 'page.merge-resolve'], ['Keep mine', 'page.merge-keep-mine'], ['Take theirs', 'page.merge-take-theirs']],
      };
    }
    if (st === 'deleted') {
      return {
        kind: p.dirty ? 'err' : 'warn', alert: !!p.dirty,
        text: `${name} was deleted or moved on disk.`,
        buttons: [['Save again here', 'page.save'], ['Save as…', 'page.save-as'],
          p.dirty ? ['Discard changes', 'page.discard-changes'] : ['Close', 'page.close']],
      };
    }
    if (p.recovered) {
      const when = whenLabel(p.recovered.at);
      return p.recovered.applied
        ? {
          kind: 'warn', alert: false,
          text: `Unsaved changes from ${when} were recovered.`,
          buttons: [['Compare', 'page.recovered-compare'], ['Discard recovered', 'page.discard-changes']],
        }
        : {
          kind: 'warn', alert: false,
          // Outside the vault they have no Versions to go to (X7), so they keep the draft slot,
          // and the page's own typing has no draft until they are restored or discarded.
          text: p.outside
            ? `Unsaved changes from ${when} could not be applied: the file changed since. Until you restore or discard them, what you type here is not kept as a draft.`
            : `Unsaved changes from ${when} could not be applied: the file changed since.`,
          buttons: [['Compare', 'page.recovered-compare'], ['Restore mine', 'page.recovered-restore'], ['Discard', 'page.discard-changes']],
        };
    }
    if (p.mergeNote && p.merged) {
      return {
        kind: 'warn', alert: false,
        text: 'Merged changes made on disk by another program.',
        buttons: [['Show changes', 'page.merge-show'], ...(ctx.canUndoMerge(p) ? [(['Undo merge', 'page.merge-undo'] as [string, string])] : [])],
      };
    }
    // X10: the bytes did not decode exactly; a save would change the ones that did not.
    if (p.lossy) {
      return {
        kind: 'warn', alert: false,
        text: `Read-only: ${name} is not exact as ${p.encoding}, and saving it would change bytes it cannot show.`,
        buttons: [['Reopen with encoding…', 'page.reopen-encoding']],
      };
    }
    if (p.notice) return { kind: 'warn', alert: false, text: p.notice, buttons: [] as any[] };
    return null;
  }

  /** Draw the banner when what it says changed; the buttons run the commands they name. */
  function renderBanner(p) {
    const box = p && p.bannerEl;
    if (!box) return;
    const spec = bannerSpec(p);
    const key = spec ? JSON.stringify([spec.kind, spec.alert, spec.text, spec.buttons]) : '';
    if (key === p.lastBanner) return;
    p.lastBanner = key;
    const had = box.contains(document.activeElement);
    box.textContent = '';
    box.hidden = !spec;
    box.className = 'ed-banner' + (spec ? ` ed-banner-${spec.kind}` : '');
    if (!spec) { box.removeAttribute('role'); return; }
    box.setAttribute('role', spec.alert ? 'alert' : 'status');
    const text = document.createElement('span');
    text.className = 'ed-banner-text';
    text.textContent = spec.text;
    box.append(text);
    if (spec.buttons.length) {
      const acts = document.createElement('span');
      acts.className = 'ed-banner-acts';
      for (const [label, id] of spec.buttons) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = label;
        b.dataset.command = id;
        b.addEventListener('click', () => { ctx.take(); void commands.run(id); });
        acts.append(b);
      }
      box.append(acts);
    }
    if (had) focusBanner(p);
  }

  /** `page.show-problem`: the banner into view and its first button focused. */
  function focusBanner(p) {
    if (!p || !p.bannerEl || p.bannerEl.hidden) return false;
    const first = p.bannerEl.querySelector('button');
    try { p.bannerEl.scrollIntoView({ block: 'nearest' }); } catch { /* not laid out */ }
    if (first) first.focus({ preventScroll: true });
    return true;
  }

  /** The dirty flag, and the two events that have always said it. */
  function setDirty(p, dirty) {
    if (p.dirty === dirty) return;
    p.dirty = dirty;
    // Every page says it, on screen or parked (M12): the event carries its path, and a tab in
    // the background shows the dot of its own page.
    bus.emit('doc:dirty', { path: p.path, dirty });
    ctx.emit('dirty', { path: p.path, dirty });
    ctx.updateMeta(p);
  }

  return {
    publishTitle,
    statusOf,
    stateOf,
    publishState,
    paintSave,
    bannerSpec,
    renderBanner,
    focusBanner,
    setDirty,
  };
}
