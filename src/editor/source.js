// Source mode (batch 12, package P5): the open page as raw markdown in CodeMirror, toggled
// with Ctrl+E, sharing the title strip, the save path and the conflict dialog with the block
// editor. Also the editor for non-markdown text files. See docs/CONTRACT.md batch 12 "Source".
//
// Exports read by extensions.js: registerCommands(api). index.js calls into this module through
// the functions it exports (see the brief).

export function registerCommands() {}
