// The first frame, before the kernel is imported. Two attributes, nothing else.
//
// `index.html` used to do this in an inline script; the kernel's CSP allows no inline script
// in a rice, so it is a file — the first module in the page, which runs before `main.js` and
// before anything is drawn. Both values are set again, from the host's own answer, once
// `ose.ready` resolves (`main.js`): this is only so the very first paint is the right theme
// and the right font stack.
//
// The default with nothing saved is dark, which is what the kernel's theme.js does too; the
// two must agree or the window flashes light on every launch.

try {
  const ua = navigator.userAgent || '';
  document.documentElement.dataset.os = /Mac|iPhone|iPad/.test(ua) ? 'mac'
    : /Windows/.test(ua) ? 'win' : 'other';
} catch { /* nothing to do: the tokens fall back to the default stack */ }

try {
  let t = localStorage.getItem('os.theme');
  if (t === 'system') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  else if (t !== 'light' && t !== 'dark') t = 'dark';
  document.documentElement.dataset.theme = t;
} catch { /* private mode: the kernel applies the theme a frame later */ }
