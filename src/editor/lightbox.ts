// The lightbox: an image of the page shown as large as the window allows, to be looked at.
//
// Read-only. It draws a copy of the picture on the overlay stack (`openOverlay`), so Esc,
// a click on the backdrop and the return of the focus behave as every other overlay does;
// nothing in the document or the file changes. A click anywhere on it closes it too, and the
// close button holds the focus so Enter or Space closes it from the keyboard.

import { icon, openOverlay } from './host.ts';
import './lightbox.css';

/**
 * Show `src` enlarged, with `caption` (the alt text or the file name) under it. Returns the
 * overlay's `close`.
 */
export function openLightbox(src: string, caption = ''): () => void {
  const ov = openOverlay({ width: null, className: 'ed-lightbox', title: caption || 'Image' });
  const box = ov.box;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn icon ed-lightbox-close';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = icon('close');

  const img = document.createElement('img');
  img.className = 'ed-lightbox-img';
  img.src = src;
  img.alt = caption;
  img.draggable = false;

  box.append(close, img);
  if (caption) {
    const cap = document.createElement('div');
    cap.className = 'ed-lightbox-cap';
    cap.textContent = caption;
    box.append(cap);
  }

  // Anywhere: the picture, the caption, the button. The backdrop is openOverlay's own.
  box.addEventListener('click', (e) => { e.preventDefault(); ov.close(); });
  try { close.focus({ preventScroll: true }); } catch { /* a detached body */ }
  return ov.close;
}
