// `@milkdown/crepe` for the headless tests (vitest.config.js). image.js reads a feature name
// from it at module top level; the engine builds no Crepe, so the class is never constructed.
export const CrepeFeature = {
  ImageBlock: 'image-block', CodeMirror: 'code-mirror', Toolbar: 'toolbar', ListItem: 'list-item',
  Table: 'table', LinkTooltip: 'link-tooltip', Cursor: 'cursor', Placeholder: 'placeholder',
  Latex: 'latex', TopBar: 'top-bar', AI: 'ai', BlockEdit: 'block-edit',
};
export class Crepe {
  constructor() { throw new Error('tests/stubs/crepe.js: no Crepe in a headless test'); }
}
