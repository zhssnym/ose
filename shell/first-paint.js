// The first frame, before the core is imported. Two attributes, nothing else.
//
// `index.html` used to do this in an inline script; the core's CSP allows no inline script
// in the shell, so it is a file — the first script in the page, which runs before `main.js` and
// before anything is drawn. Both values are set again, from the host's own answer, once
// `ose.ready` resolves (`main.js`): this is only so the very first paint is the right theme
// and the right font stack.
//
// The default with nothing saved is the system's own light or dark, which is what the core's
// theme.js does too (M26); the two must agree or the window flashes on every launch.

try {
  const ua = navigator.userAgent || '';
  document.documentElement.dataset.os = /Mac|iPhone|iPad/.test(ua) ? 'mac'
    : /Windows/.test(ua) ? 'win' : 'other';
} catch { /* nothing to do: the tokens fall back to the default stack */ }

try {
  let t = localStorage.getItem('os.theme');
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
} catch { /* private mode: the core applies the theme a frame later */ }

// The installed window's frame, and the strip behind its window buttons (Window Controls
// Overlay), are painted in `theme-color`: kept equal to the toolbar's ground, whichever theme
// is on, so the window reads as one surface.
try {
  const meta = document.querySelector('meta[name="theme-color"]');
  const paint = () => {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--bg-2').trim();
    if (meta && c) meta.setAttribute('content', c);
  };
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
} catch { /* the manifest's colour stands */ }
