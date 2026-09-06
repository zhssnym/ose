// Page harness: the editor mounted the way the shell will mount it (a scrolling main region),
// with a file list, a status bar fed from the registry, and a memory/leak check.

import { bridge } from '../bridge/index.js';
import { commands, status, store, bus } from '../registry.js';
import { initEditor, openPage, closePage, saveNow, getOpenPath } from './index.js';

const $ = (id) => document.getElementById(id);

function collect(node, out = []) {
  if (!node) return out;
  if (node.kind === 'file') { if (node.ext === 'md') out.push(node.path); return out; }
  for (const c of node.children || []) collect(c, out);
  return out;
}

status.watch((all) => {
  $('bar').innerHTML = all.map((s) => `<span>${s.text.replace(/</g, '&lt;')}</span>`).join('');
});

let files = [];

async function boot() {
  await bridge.ready;
  store.set('root', await bridge.rootInfo());
  await initEditor();

  // stand-ins for the view / claude commands so the slash menu's "os" group has content
  for (const [id, title, group] of [
    ['view.month', 'Month', 'view'], ['view.week', 'Week', 'view'],
    ['view.day', 'Day', 'view'], ['view.journal', 'Journal', 'view'],
    ['claude.toggle', 'Claude', 'claude'],
  ]) commands.register({ id, title, group, run: () => console.log('run', id) });

  files = collect(await bridge.tree()).sort();
  $('side').innerHTML = files.map((f, i) =>
    `<div class="row" data-i="${i}" title="${f.replace(/"/g, '&quot;')}"><span class="grow">${f.replace(/</g, '&lt;')}</span></div>`).join('');
  $('side').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) void open(files[+row.dataset.i]);
  });

  const first = new URLSearchParams(location.search).get('p');
  if (first) void open(first);
}

async function open(path) {
  await openPage($('main'), path);
  $('path').textContent = path;
  for (const r of $('side').querySelectorAll('.row')) r.classList.remove('current');
  const i = files.indexOf(path);
  if (i >= 0) $('side').querySelector(`.row[data-i="${i}"]`)?.classList.add('current');
  $('main').scrollTop = 0;
}

$('theme').onclick = () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('os.theme', document.documentElement.dataset.theme); } catch {}
};

$('cycle').onclick = async () => {
  const before = performance.memory ? performance.memory.usedJSHeapSize : 0;
  const t0 = performance.now();
  const listeners = [];
  for (let i = 0; i < 30; i++) await open(files[i % files.length]);
  await closePage();
  const ms = Math.round(performance.now() - t0);
  const after = performance.memory ? performance.memory.usedJSHeapSize : 0;
  const info = {
    ms, perPage: Math.round(ms / 30),
    heapBeforeMB: +(before / 1048576).toFixed(1),
    heapAfterMB: +(after / 1048576).toFixed(1),
    milkdownRoots: document.querySelectorAll('.milkdown').length,
    proseMirrors: document.querySelectorAll('.ProseMirror').length,
  };
  console.log('[cycle]', info);
  window.__cycle = info;
  $('path').textContent = `30 pages in ${ms}ms (${info.perPage}ms each), leftover editors: ${info.milkdownRoots}`;
};

window.__editor = { open, openPage, closePage, saveNow, getOpenPath, commands, bus, files: () => files };
boot();
