// The smallest rice there can be: it proves that the window reached `app.localhost`, that the
// import map the host injected resolves `ose:kernel`, and that the kernel came up. CI reads
// the line out of the --log file.
//
// It quits when it is done, because it is a fixture: a CI job must not wait for a window
// nobody will close. A rice a person uses obviously does no such thing.
import { ose } from 'ose:kernel';

const say = (text) => {
  const el = document.getElementById('says');
  if (el) el.textContent = text;
  return ose.log(text).catch(() => {});
};

try {
  await ose.ready;
  const ui = document.querySelector('link[data-ose="ui"]')?.getAttribute('href') || '';
  const map = document.querySelector('script[type="importmap"]')?.textContent || '';
  const ok = ui.endsWith('/ui.css') && !ui.includes('nowhere') && map.includes('ose:kernel');
  await say(ok ? `rice ok (api ${ose.api}, ui ${ui})` : `rice rewrite failed (ui ${ui})`);
} catch (e) {
  await say(`rice failed: ${e && e.message ? e.message : e}`);
}

setTimeout(() => { ose.window.quit().catch(() => {}); }, 500);
