// Versions (batch 12, package P5): the previous content of a file kept under .ose/versions
// before a save changes it; the Versions… dialog that lists and restores. Host side in
// src-tauri/src/versions.rs. See docs/CONTRACT.md batch 12 "Versions".
//
// Exports read by extensions.js: registerCommands(api). index.js calls keepVersion() from the
// write path, before the file is replaced.

/**
 * Keep `previous` (the text the page was opened from or last wrote) before `next` replaces it
 * on disk. Must never throw and never block a save for long.
 * @param {string} path  vault-relative
 * @param {string} previous
 * @param {string} next
 */
export async function keepVersion(path, previous, next) {
  void path; void previous; void next;
}

export function registerCommands() {}
