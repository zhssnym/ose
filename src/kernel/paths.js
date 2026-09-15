// Vault path helpers. Paths are relative to the root, forward slashes, no leading slash.
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
