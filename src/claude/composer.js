// The composer: a borderless textarea over a top border, with a mono hint line.
// Enter sends, Shift+Enter newlines, Esc interrupts, Up on an empty box recalls the last prompt.

const MAX_LINES = 8;

export function createComposer({ onSend, onInterrupt, lastPrompt = () => '' } = {}) {
  const root = document.createElement('div');
  root.className = 'c-composer';

  const ta = document.createElement('textarea');
  ta.className = 'c-input text-select';
  ta.rows = 1;
  ta.spellcheck = false;
  ta.placeholder = 'Ask Claude about this vault…';
  ta.setAttribute('aria-label', 'Message Claude');

  const foot = document.createElement('div');
  foot.className = 'c-composer-foot';
  const hint = document.createElement('span');
  hint.className = 'c-hint mono-sm';
  const HINT = '<span>Enter send</span><span>Shift+Enter newline</span><span class="h-esc">Esc interrupt</span>';
  hint.innerHTML = HINT;
  const spacer = document.createElement('span');
  spacer.className = 'c-grow';
  const stop = document.createElement('button');
  stop.className = 'btn sm c-stop';
  stop.type = 'button';
  stop.textContent = 'interrupt';
  stop.hidden = true;
  const send = document.createElement('button');
  send.className = 'btn sm primary c-send';
  send.type = 'button';
  send.textContent = 'send';
  foot.append(hint, spacer, stop, send);
  root.append(ta, foot);

  let disabled = false;
  let disabledHint = 'starting claude…';
  let running = false;
  let recalled = false;

  const lineHeight = () => {
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight);
    return Number.isFinite(lh) ? lh : 20;
  };

  function grow() {
    ta.style.height = 'auto';
    const cs = getComputedStyle(ta);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const max = lineHeight() * MAX_LINES + pad;
    const h = Math.min(ta.scrollHeight, max);
    ta.style.height = h + 'px';
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  }

  function sync() {
    send.disabled = disabled || running || !ta.value.trim();
    ta.disabled = disabled;
    stop.hidden = !running;
    if (disabled) hint.textContent = disabledHint;
    else if (running) hint.textContent = 'Esc or interrupt to stop';
    else hint.innerHTML = HINT;
  }

  function submit() {
    const text = ta.value.trim();
    if (!text || disabled || running) return;
    ta.value = '';
    recalled = false;
    grow();
    sync();
    onSend?.(text);
  }

  ta.addEventListener('input', () => { grow(); sync(); recalled = false; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape' && running) { e.preventDefault(); e.stopPropagation(); onInterrupt?.(); return; }
    if (e.key === 'ArrowUp' && !ta.value && !recalled) {
      const prev = lastPrompt() || '';
      if (prev) { e.preventDefault(); ta.value = prev; recalled = true; grow(); sync(); ta.setSelectionRange(prev.length, prev.length); }
    }
  });
  send.addEventListener('click', submit);
  stop.addEventListener('click', () => onInterrupt?.());

  sync();

  return {
    el: root,
    focus() { ta.focus(); },
    setDisabled(v, why) { disabled = !!v; if (why) disabledHint = why; sync(); },
    setRunning(v) { running = !!v; sync(); },
    setValue(v) { ta.value = v ?? ''; grow(); sync(); },
    prefill(v) { ta.value = v ?? ''; grow(); sync(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); },
    get value() { return ta.value; },
  };
}
