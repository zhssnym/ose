// Tables (batch 12, package P2). Keymap inside a cell (Enter, Tab, Shift+Enter, Ctrl+Enter),
// the row/column/alignment/delete commands, Esc escalation cell -> row -> table, and a cell
// selection that only ever empties cells. See docs/CONTRACT.md batch 12 "Tables".
//
// Exports read by extensions.js: plugins(ctx, o), registerCommands(api).

export function plugins() { return []; }
export function registerCommands() {}
