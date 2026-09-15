// Vault path helpers. Vault paths are relative to the root, forward slashes, no leading slash.
// Everything here is pure; nothing touches the bridge.
//
// The functions live in `src/kernel/href.js`, because the kernel's own link resolver needs
// four of them and the kernel may not import `ose:editor`. This file was a byte-for-byte copy
// of them; it is the same list of names now, from one place, so a fix to `resolveHref` or
// `linkTarget` cannot land in only half the app.
export * from '../kernel/href.js';
