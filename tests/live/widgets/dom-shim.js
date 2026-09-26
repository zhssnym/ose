// Two happy-dom gaps, closed before any module that needs them loads: import this file first.
//
// - `Node.prototype.nodeName`'s getter answers '' for an element (happy-dom defines the real one
//   on Element.prototype). DOMPurify reads node names through that exact getter, so under
//   happy-dom it takes every element for an unknown tag. The getter below defers to the most
//   derived one, which is what a browser's single getter does.
// - Temml refuses a quirks-mode document and decides once, when it loads; happy-dom's document
//   has no doctype. The app's page has one (shell/index.html).

const base = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName');
if (base && base.get) {
  const read = base.get;
  Object.defineProperty(Node.prototype, 'nodeName', {
    configurable: true,
    get() {
      for (let o = Object.getPrototypeOf(this); o && o !== Node.prototype; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, 'nodeName');
        if (d && d.get) return d.get.call(this);
      }
      return read.call(this);
    },
  });
}

Object.defineProperty(document, 'compatMode', { value: 'CSS1Compat', configurable: true });
