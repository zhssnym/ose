// The clipboard.
/**
 * Put text on the clipboard. `navigator.clipboard` needs a secure context, which both the dev
 * server (127.0.0.1) and the host give us; the textarea fallback is there so a copy never
 * silently does nothing. Resolves true when the text went somewhere.
 */
export async function copyText(text) {
  const s = String(text ?? '');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* fall through to the old way */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e) {
    console.error('[shell] copy', e);
    return false;
  }
}

