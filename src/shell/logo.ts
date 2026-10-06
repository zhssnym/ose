// The mark: a tetrahedron in the accent colour, on nothing. Seen down one vertex, its outline is
// the triangle Ose always had, and its three faces are lit from the upper left, as codril's
// icosahedron and fortal's cube are. The faces are mixed from the accent token alone, so the mark
// follows the theme. The same shape in fixed colours is shell/logo.svg (the page icon),
// site/favicon.svg and src-tauri/icons/source.svg (the app icon).
const LIT = 'color-mix(in srgb, var(--accent) 70%, white)';
const SHADE = 'color-mix(in srgb, var(--accent) 80%, black)';
const face = (points: string, fill: string): string =>
  `<polygon points="${points}" style="fill: ${fill}; stroke: ${fill}; stroke-width: 0.22; stroke-linejoin: round"/>`;
export const LOGO = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">'
  + face('12,1.35 1.05,20.4 12,14.05', LIT)
  + face('12,1.35 12,14.05 22.95,20.4', 'var(--accent)')
  + face('1.05,20.4 22.95,20.4 12,14.05', SHADE)
  + '</svg>';
