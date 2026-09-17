// Crepe imports every one of its feature modules statically, its Latex feature among them, and
// that feature imports KaTeX. Ose keeps the feature off and renders formulas with Temml
// (math.js), so the kernel build aliases `katex` to this file and a quarter of a megabyte of
// code that can never run stays out of editor.js.
const absent = () => { throw new Error('KaTeX is not part of Ose: formulas are rendered by Temml (src/editor/math.js)'); };
export const render = absent;
export const renderToString = absent;
export default { render, renderToString };
