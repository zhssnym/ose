// Vault path helpers. Paths are relative to the root, forward slashes, no leading slash.
//
// The rice's own copy of the kernel's `paths.js`: pure string functions with no state, which
// the sidebar, the title bar and the palette all need and which `ose` does not carry (it has
// no reason to — a path helper is not a hose). Keep it in step with `src/kernel/paths.js`.
export const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
export const baseName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? c : c.slice(i + 1); };
export const dirName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? '' : c.slice(0, i); };
export const extOf = (p) => { const b = baseName(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase(); };
export const isMd = (p) => extOf(p) === 'md';
export const stripMd = (name) => String(name).replace(/\.md$/i, '');
export const titleOf = (p) => stripMd(baseName(p));
export const join = (...parts) => parts.map(clean).filter(Boolean).join('/');
export const segments = (p) => clean(p).split('/').filter(Boolean);

// Segments never shown in the tree or search (CONTRACT.md "Paths"). _Archive is shown, last.
const HIDDEN = new Set(['.git', '.obsidian', '.claude', '.vscode', '.trash', 'node_modules', 'App', 'dist', 'dist-host', 'os.exe', 'os.pdb']);
export const isHiddenName = (name) => !name || name.startsWith('.') || HIDDEN.has(name);

// Files the page editor can show as text (the kernel's own list, which a rice is free to
// widen): everything else a row opens goes to the platform's default application.
export const TEXT_EXTS = new Set(['txt', 'csv', 'jsonl', 'py', 'log', 'tex', 'json', 'yaml', 'toml']);
export const isTextFile = (p) => TEXT_EXTS.has(extOf(p));
