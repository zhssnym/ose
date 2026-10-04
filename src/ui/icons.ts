// 16px stroked SVG icons, 1.5px stroke, currentColor. Inline, no sprite, no font.
// Window glyphs are drawn separately at 10px with a 1px stroke (see glyph()).

const P = {
  chevron: '<path d="M6.25 3.5L10.75 8l-4.5 4.5"/>',
  folder: '<path d="M2.25 4.25A1.25 1.25 0 0 1 3.5 3h2.35l1.4 1.75h5.25A1.25 1.25 0 0 1 13.75 6v5.75A1.25 1.25 0 0 1 12.5 13h-9a1.25 1.25 0 0 1-1.25-1.25z"/>',
  file: '<path d="M4 2.25h4.75L12 5.5v8.25H4z"/><path d="M8.75 2.25V5.5H12"/>',
  search: '<circle cx="7.1" cy="7.1" r="4.35"/><path d="M10.3 10.3L13.75 13.75"/>',
  // Month, week and day are told apart by how many marks they carry: a 4x4 field of dots,
  // one row of seven, and a single dot in a square (Hassan, batch 4). The year is twelve
  // larger marks, four by three, one per month.
  year: '<g fill="currentColor" stroke="none"><rect x="1.50" y="3.30" width="2.4" height="2.4"/><rect x="4.90" y="3.30" width="2.4" height="2.4"/><rect x="8.30" y="3.30" width="2.4" height="2.4"/><rect x="11.70" y="3.30" width="2.4" height="2.4"/><rect x="1.50" y="6.80" width="2.4" height="2.4"/><rect x="4.90" y="6.80" width="2.4" height="2.4"/><rect x="8.30" y="6.80" width="2.4" height="2.4"/><rect x="11.70" y="6.80" width="2.4" height="2.4"/><rect x="1.50" y="10.30" width="2.4" height="2.4"/><rect x="4.90" y="10.30" width="2.4" height="2.4"/><rect x="8.30" y="10.30" width="2.4" height="2.4"/><rect x="11.70" y="10.30" width="2.4" height="2.4"/></g>',
  month: '<g fill="currentColor" stroke="none"><rect x="1.50" y="1.50" width="2" height="2"/><rect x="4.50" y="1.50" width="2" height="2"/><rect x="7.50" y="1.50" width="2" height="2"/><rect x="10.50" y="1.50" width="2" height="2"/><rect x="1.50" y="4.50" width="2" height="2"/><rect x="4.50" y="4.50" width="2" height="2"/><rect x="7.50" y="4.50" width="2" height="2"/><rect x="10.50" y="4.50" width="2" height="2"/><rect x="1.50" y="7.50" width="2" height="2"/><rect x="4.50" y="7.50" width="2" height="2"/><rect x="7.50" y="7.50" width="2" height="2"/><rect x="10.50" y="7.50" width="2" height="2"/><rect x="1.50" y="10.50" width="2" height="2"/><rect x="4.50" y="10.50" width="2" height="2"/><rect x="7.50" y="10.50" width="2" height="2"/><rect x="10.50" y="10.50" width="2" height="2"/></g>',
  week: '<g fill="currentColor" stroke="none"><rect x="1.00" y="7.20" width="1.6" height="1.6"/><rect x="3.00" y="7.20" width="1.6" height="1.6"/><rect x="5.00" y="7.20" width="1.6" height="1.6"/><rect x="7.00" y="7.20" width="1.6" height="1.6"/><rect x="9.00" y="7.20" width="1.6" height="1.6"/><rect x="11.00" y="7.20" width="1.6" height="1.6"/><rect x="13.00" y="7.20" width="1.6" height="1.6"/></g>',
  day: '<rect x="2.5" y="2.5" width="11" height="11"/><circle cx="8" cy="8" r="1.9" fill="currentColor" stroke="none"/>',
  agent: '<path d="M8 2.5l5.25 3v5l-5.25 3-5.25-3v-5z"/><path d="M6.25 7.25v2M9.75 7.25v2"/>',
  habits: '<rect x="2.25" y="2.25" width="4.75" height="4.75"/><rect x="9" y="2.25" width="4.75" height="4.75"/><rect x="2.25" y="9" width="4.75" height="4.75"/><path d="M10 11.4l1.3 1.3 2.4-2.7"/>',
  journal: '<path d="M3.25 2.75h6.5a2 2 0 0 1 2 2v8.5h-6.5a2 2 0 0 1-2-2z"/><path d="M3.25 10.75h8.5M6 5.5h3.25"/>',
  tasks: '<rect x="2.25" y="2.25" width="11.5" height="11.5"/><path d="M5.25 8.1l1.9 1.9 3.6-4"/>',
  // A capital sigma with its two serifs: the maths mark.
  sigma: '<path d="M12.25 4.75V2.75H3.75L8.5 8l-4.75 5.25h8.5v-2"/>',
  view: '<rect x="2.25" y="2.25" width="11.5" height="11.5"/><path d="M2.25 6h11.5"/>',
  plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
  folderPlus: '<path d="M2.25 4.25A1.25 1.25 0 0 1 3.5 3h2.35l1.4 1.75h5.25A1.25 1.25 0 0 1 13.75 6v5.75A1.25 1.25 0 0 1 12.5 13h-9a1.25 1.25 0 0 1-1.25-1.25z"/><path d="M8 7.25v3.5M6.25 9h3.5"/>',
  rename: '<path d="M11.4 2.6l2 2-7.65 7.65-2.65.65.65-2.65z"/><path d="M9.9 4.1l2 2"/>',
  reveal: '<path d="M13.25 8.5v4.75h-10.5V2.75H7.5"/><path d="M9.75 2.75h3.5v3.5"/><path d="M13.25 2.75L7.75 8.25"/>',
  trash: '<path d="M2.75 4.25h10.5"/><path d="M6.25 4.25V2.75h3.5v1.5"/><path d="M4.25 4.25l.6 9h6.3l.6-9"/>',
  back: '<path d="M12.75 8h-9.5"/><path d="M7 3.75L2.75 8 7 12.25"/>',
  forward: '<path d="M3.25 8h9.5"/><path d="M9 3.75L13.25 8 9 12.25"/>',
  settings: '<path d="M2.25 5.25h11.5M2.25 10.75h11.5"/><circle cx="6" cy="5.25" r="1.85"/><circle cx="10" cy="10.75" r="1.85"/>',
  // A gear for Settings: six broad teeth and a hole, solid, so that it still reads at 13px.
  gear: '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M5.81 3.06L5.84 0.71L10.16 0.71L10.19 3.06L11.18 3.64L13.23 2.49L15.39 6.23L13.37 7.43L13.37 8.57L15.39 9.77L13.23 13.51L11.18 12.36L10.19 12.94L10.16 15.29L5.84 15.29L5.81 12.94L4.82 12.36L2.77 13.51L0.61 9.77L2.63 8.57L2.63 7.43L0.61 6.23L2.77 2.49L4.82 3.64zM8 5.6a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8z"/>',
  theme: '<circle cx="8" cy="8" r="4.6"/><path d="M8 3.4v9.2" fill="currentColor" stroke="none"/><path d="M8 3.4a4.6 4.6 0 0 0 0 9.2z" fill="currentColor" stroke="none"/>',
  command: '<path d="M4.5 5.5L7 8l-2.5 2.5"/><path d="M8.5 11h3.5"/><rect x="1.75" y="2.75" width="12.5" height="10.5"/>',
  dot: '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
  close: '<path d="M3.75 3.75l8.5 8.5M12.25 3.75l-8.5 8.5"/>',
  // Focus mode: a bracketed target, the frame narrowed onto one thing.
  focus: '<path d="M2.75 5.5V2.75H5.5M10.5 2.75h2.75V5.5M13.25 10.5v2.75H10.5M5.5 13.25H2.75V10.5"/><circle cx="8" cy="8" r="2"/>',
  pin: '<path d="M6 2.75h4l-.5 4 2.25 2.25h-7.5L6.5 6.75z"/><path d="M8 9v4.25"/>',
  // Tree glyphs: a page and a folder that read the same at 14px, same optical weight.
  page: '<path d="M3.75 2.25h8.5v11.5h-8.5z"/><path d="M6 5.75h4M6 8.25h4M6 10.75h2.5"/>',
  // Copy: two offset sheets. Link: the two halves of a chain, drawn as open brackets.
  copy: '<rect x="5.75" y="5.75" width="7.5" height="7.5"/><path d="M10.25 5.75V2.75h-7.5v7.5h3"/>',
  link: '<path d="M6.75 9.25a2.4 2.4 0 0 1 0-3.4l2-2a2.4 2.4 0 0 1 3.4 3.4l-1 1"/><path d="M9.25 6.75a2.4 2.4 0 0 1 0 3.4l-2 2a2.4 2.4 0 0 1-3.4-3.4l1-1"/>',
  // The files-first shell (the address bar, the clipboard, the trash).
  home: '<path d="M2.5 7.5L8 2.75l5.5 4.75"/><path d="M4 6.5v6.75h8V6.5"/><path d="M6.75 13.25v-3.5h2.5v3.5"/>',
  arrowUp: '<path d="M8 13.25v-10.5"/><path d="M3.75 7L8 2.75 12.25 7"/>',
  sortAsc: '<path d="M4.5 12.75v-9.5"/><path d="M2.25 5.5L4.5 3.25 6.75 5.5"/><path d="M8.75 4.25h5M8.75 8h3.5M8.75 11.75h2"/>',
  sortDesc: '<path d="M4.5 3.25v9.5"/><path d="M2.25 10.5L4.5 12.75 6.75 10.5"/><path d="M8.75 4.25h2M8.75 8h3.5M8.75 11.75h5"/>',
  scissors: '<circle cx="4.5" cy="11.5" r="1.85"/><circle cx="11.5" cy="11.5" r="1.85"/><path d="M5.75 10.1L11.5 2.75M10.25 10.1L4.5 2.75"/>',
  clipboard: '<path d="M5.5 3.25H3.75v10.5h8.5V3.25H10.5"/><rect x="5.5" y="2.25" width="5" height="2"/><path d="M6 8h4M6 10.75h2.75"/>',
  undo: '<path d="M5.25 3.75L2.5 6.5l2.75 2.75"/><path d="M2.5 6.5h6.75a3.5 3.5 0 0 1 0 7h-2.5"/>',
  eye: '<path d="M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="1.9"/>',
  eyeOff: '<path d="M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="1.9"/><path d="M2.75 13.25L13.25 2.75"/>',
  fileText: '<path d="M4 2.25h4.75L12 5.5v8.25H4z"/><path d="M8.75 2.25V5.5H12"/><path d="M6 8.25h4M6 10.75h4"/>',
  fileImage: '<path d="M4 2.25h4.75L12 5.5v8.25H4z"/><path d="M8.75 2.25V5.5H12"/><path d="M4 12l2.5-2.75L8.25 11l1.25-1.25L12 12.25"/><circle cx="6.5" cy="7.25" r=".9"/>',
  fileCode: '<path d="M4 2.25h4.75L12 5.5v8.25H4z"/><path d="M8.75 2.25V5.5H12"/><path d="M6.75 8.25L5.5 9.75l1.25 1.5M9.25 8.25l1.25 1.5-1.25 1.5"/>',
  lock: '<rect x="3.25" y="7.25" width="9.5" height="6.5"/><path d="M5.25 7.25V5.5a2.75 2.75 0 0 1 5.5 0v1.75"/>',
  restore: '<path d="M3 3.75v3h3"/><path d="M3.35 6.75A5 5 0 1 1 3.5 10"/><path d="M8 5.5V8l1.75 1.25"/>',
  panel: '<rect x="2.25" y="2.75" width="11.5" height="10.5"/><path d="M10 2.75v10.5"/>',
};

export function icon(name) {
  const d = P[name] || P.dot;
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
}

export function hasIcon(name) { return Object.prototype.hasOwnProperty.call(P, name); }

// Window control glyphs: 10px box, 1px stroke, crisp.
const G = {
  min: '<path d="M0 5.5h10"/>',
  max: '<rect x="0.5" y="0.5" width="9" height="9"/>',
  restore: '<rect x="0.5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V0.5h7v7h-2"/>',
  close: '<path d="M0.4 0.4l9.2 9.2M9.6 0.4L0.4 9.6"/>',
};

export function glyph(name) {
  return `<svg class="glyph" viewBox="0 0 10 10" aria-hidden="true">${G[name] || ''}</svg>`;
}
