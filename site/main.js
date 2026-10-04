// The landing page's one script: the theme switch, pictures that open large in a small gallery,
// and download buttons that go straight to the latest release's installers.
//
// Without it the page still stands: it is light, a picture's link opens the picture itself,
// and the buttons go to the releases page, which always has the files.

/* ---- the theme: the device's until the visitor chooses, then theirs (kept in this browser).
   index.html has already set it on <html> before the first paint. */

const KEY = 'ose.site.theme';
const root = document.documentElement;
const system = matchMedia('(prefers-color-scheme: dark)');
const choices = [...document.querySelectorAll('[data-set-theme]')];

function chosen() {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'dark' || t === 'light' ? t : null;
  } catch {
    return null;     // no storage here: the device's theme it is
  }
}

function paint(theme) {
  root.dataset.theme = theme;
  for (const b of choices) b.setAttribute('aria-pressed', String(b.dataset.setTheme === theme));
}

paint(chosen() || (system.matches ? 'dark' : 'light'));
system.addEventListener('change', () => {
  if (!chosen()) paint(system.matches ? 'dark' : 'light');
});
for (const b of choices) {
  b.addEventListener('click', () => {
    try {
      localStorage.setItem(KEY, b.dataset.setTheme);
    } catch {
      // not kept, then: it holds until the page is left
    }
    paint(b.dataset.setTheme);
  });
}

/* ---- a picture opens large on a click, in a small gallery of all the page's pictures: back
   and forth with the buttons, the arrow keys or the squares; a click on the picture shows it
   at its full size; Escape, Close or a click beside it puts the gallery away. */

let viewer = null;
let pictures = [];     // the page's pictures in its present theme, as their links
let at = 0;

function build() {
  viewer = document.createElement('dialog');
  viewer.className = 'lightbox';
  viewer.innerHTML = `<div class="bar">
      <span class="count"></span>
      <span class="what"></span>
      <span class="nav">
        <button type="button" class="btn" data-go="-1" aria-label="Previous picture">&lsaquo;</button>
        <button type="button" class="btn" data-go="1" aria-label="Next picture">&rsaquo;</button>
        <button type="button" class="btn" data-go="0">Close</button>
      </span>
    </div>
    <div class="stage"><img alt=""></div>
    <div class="dots" role="group" aria-label="Pictures"></div>`;
  // The gallery itself holds the focus, not one of its buttons: an arrow key then lights no
  // button's ring, and the button it stands for answers with a short flash instead.
  viewer.tabIndex = -1;
  document.body.append(viewer);
  const picture = viewer.querySelector('img');
  viewer.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    const dot = e.target.closest('[data-at]');
    if (go) {
      if (Number(go.dataset.go)) show(at + Number(go.dataset.go));
      else viewer.close();
    } else if (dot) show(Number(dot.dataset.at));
    else if (e.target === picture) viewer.classList.toggle('full');
    else if (e.target.classList.contains('stage')) viewer.close();
    // a button pressed with the mouse gives the focus back, so that it keeps no ring; one
    // pressed from the keyboard keeps it, to be pressed again
    if ((go || dot) && e.detail > 0 && viewer.open) viewer.focus();
  });
  viewer.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    show(at + step);
    const button = viewer.querySelector(`[data-go="${step}"]`);
    button.classList.add('is-pressed');
    setTimeout(() => button.classList.remove('is-pressed'), 160);
  });
}

/** The words under a picture on the page: its name in the gallery. */
const nameOf = (link) => link.closest('figure')?.querySelector('figcaption')?.textContent.trim() || '';

function show(i) {
  at = (i + pictures.length) % pictures.length;
  const link = pictures[at];
  const picture = viewer.querySelector('img');
  picture.src = link.href;
  picture.alt = link.querySelector('img')?.alt || '';
  viewer.classList.remove('full');     // each picture comes fitted to the window
  viewer.querySelector('.count').textContent = `${at + 1} of ${pictures.length}`;
  viewer.querySelector('.what').textContent = nameOf(link);
  for (const d of viewer.querySelectorAll('[data-at]')) d.setAttribute('aria-current', String(Number(d.dataset.at) === at));
  // the two beside it, fetched ahead, so that a step shows at once
  for (const n of [at + 1, at - 1]) new Image().src = pictures[(n + pictures.length) % pictures.length].href;
}

function open(link) {
  if (!viewer) build();
  pictures = [...document.querySelectorAll('a.zoom')].filter((a) => a.offsetParent !== null);
  viewer.querySelector('.dots').innerHTML = pictures
    .map((a, i) => `<button type="button" data-at="${i}" aria-label="${nameOf(a) || `Picture ${i + 1}`}"></button>`)
    .join('');
  viewer.showModal();
  viewer.focus();
  show(Math.max(0, pictures.indexOf(link)));
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('a.zoom');
  // a modified click keeps its meaning: the picture in a new tab
  if (!link || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  if (typeof HTMLDialogElement === 'undefined') return;
  e.preventDefault();
  open(link);
});

/* ---- the download: the visitor's own platform is the primary button, and both go straight to
   the latest release's installers once GitHub has answered. */

const API = 'https://api.github.com/repos/zhssnym/ose/releases/latest';
const win = [...document.querySelectorAll('[data-dl="win"]')];
const mac = [...document.querySelectorAll('[data-dl="mac"]')];

if (/Mac/.test(navigator.userAgent)) {
  for (const a of win) a.classList.remove('primary');
  for (const a of mac) a.classList.add('primary');
}

try {
  const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const release = await res.json();
  const asset = (suffix) => release.assets.find((a) => a.name.endsWith(suffix));
  const exe = asset('_x64-setup.exe');
  const dmg = asset('_aarch64.dmg');
  if (exe) for (const a of win) a.href = exe.browser_download_url;
  if (dmg) for (const a of mac) a.href = dmg.browser_download_url;
  const version = release.tag_name.replace(/^v/, '');
  const day = new Date(release.published_at).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  for (const m of document.querySelectorAll('[data-dl-meta]')) {
    m.textContent = `Version ${version}, ${day} · Windows, 64-bit · macOS, Apple silicon`;
  }
} catch {
  // The releases page it is.
}
