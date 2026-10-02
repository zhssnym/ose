// Crepe imports every one of its feature modules statically, its Latex feature among them, and
// that feature imports KaTeX. Ose keeps the feature off and renders formulas with Temml
// (math.ts), so the build aliases `katex` to this file (vite.config.js) and a quarter of a
// megabyte of code that can never run stays out of the editor's chunk.
const absent = () => { throw new Error('KaTeX is not part of Ose: formulas are rendered by Temml (src/editor/math.ts)'); };
export const render = absent;
export const renderToString = absent;
export default { render, renderToString };
