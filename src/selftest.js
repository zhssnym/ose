// Host self-test. Loaded by selftest.html, which the host opens instead of index.html when it
// is started with --selftest. It drives the bridge facade (not a host protocol), so the same
// page tests the Tauri host, the .NET host, and the dev bridge in a browser.
//
// Every result goes out through `bridge.log` (the host writes it to --log, CI greps it) and is
// also drawn on the page. Mutating commands run only when the vault carries a `.selftest`
// marker, so pointing this at a real vault can never write to it.
// selftest.html links tokens.css and base.css, so the page wears the app's own colours.
import { bridge } from './bridge/index.js';

const out = document.getElementById('selftest');
const PTY_WAIT_MS = 20000;
const CALL_TIMEOUT_MS = 60000;
const HARD_STOP_MS = 200000; // under the CI job's own 240s kill, so the FAIL line still gets written

let pass = 0, fail = 0, skip = 0;

/* ------------------------------------------------------------------ output */

const head = document.createElement('div');
head.className = 'st-head';
head.textContent = 'os selftest';
const sub = document.createElement('span');
sub.className = 'st-sub';
head.appendChild(sub);
out.appendChild(head);

function paint(cls, tag, text) {
  const d = document.createElement('div');
  d.className = 'st-line st-' + cls;
  if (tag) { const b = document.createElement('b'); b.textContent = tag; d.appendChild(b); }
  d.appendChild(document.createTextNode(text));
  out.appendChild(d);
  window.scrollTo(0, document.body.scrollHeight);
  return d;
}

// The dev bridge has no `log` command; on the page the line is there either way.
const send = (text) => { try { bridge.log(text).catch(() => { }); } catch { /* pre-ready */ } };

function report(cls, tag, name, detail) {
  const text = detail ? `${name}: ${detail}` : name;
  paint(cls, tag, ' ' + text);
  send(`${tag} ${text}`);
}

const info = (text) => { paint('info', '', text); send(text); };

/* ------------------------------------------------------------------ harness */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
// pty chunks arrive as base64 of raw bytes; latin1 is enough to look for an ascii word in them
const decodeB64 = (b64) => { try { return atob(String(b64)); } catch { return ''; } };
const trim = (v, n = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, n);

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]).catch((e) => { throw new Error(`${what}: ${e.message || e}`); });
}

async function test(name, fn) {
  try {
    const detail = await withTimeout(Promise.resolve().then(fn), CALL_TIMEOUT_MS, name);
    pass++;
    report('pass', 'PASS', name, trim(detail));
  } catch (e) {
    fail++;
    report('fail', 'FAIL', name, trim(e && e.message ? e.message : e));
  }
}

function skipped(name, why) { skip++; report('skip', 'SKIP', name, why); }

/* ------------------------------------------------------------------- tests */

// 1x1 transparent png, 70 bytes decoded.
const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DIR = 'selftest';

const ptyEvents = [];
bridge.on('pty', (d) => ptyEvents.push(d));
bridge.on('fs', (d) => info(`event fs ${trim(JSON.stringify(d), 160)}`));
bridge.on('window', (d) => info(`event window ${trim(JSON.stringify(d), 160)}`));

/** First markdown file in the tree, so nothing here depends on a particular vault. */
function firstFile(node, ext = 'md') {
  const stack = [node];
  while (stack.length) {
    const n = stack.shift();
    if (n.kind === 'file' && (!ext || n.ext === ext)) return n;
    if (n.children) stack.push(...n.children);
  }
  return null;
}

async function run() {
  await bridge.ready;

  let root = null, tree = null, sample = null, mutable = false;

  await test('rootInfo', async () => {
    root = await bridge.rootInfo();
    assert(root && root.root, 'no root in ' + JSON.stringify(root));
    sub.textContent = `${bridge.kind} · ${bridge.platform} · ${root.root}`;
    return `${root.root} (${root.name})`;
  });

  await test('platform', async () => {
    const p = bridge.platform;
    assert(['windows', 'macos', 'linux'].includes(p), 'unexpected platform: ' + p);
    return `${p}, kind=${bridge.kind}, assetUrl=${bridge.assetUrl('a b/c.png')}`;
  });

  await test('exists(.selftest marker)', async () => {
    mutable = (await bridge.exists('.selftest')) === true;
    return mutable ? 'present, mutating tests enabled' : 'absent, mutating tests skipped';
  });

  await test('tree', async () => {
    tree = await bridge.tree();
    assert(tree && tree.kind === 'dir' && Array.isArray(tree.children), 'bad shape: ' + trim(JSON.stringify(tree), 120));
    let dirs = 0, files = 0;
    (function walk(n) { for (const c of n.children || []) { if (c.kind === 'dir') { dirs++; walk(c); } else files++; } })(tree);
    sample = firstFile(tree);
    assert(sample, 'no markdown file in the vault');
    return `${dirs} dirs, ${files} files, sample=${sample.path}`;
  });

  await test('list(root)', async () => {
    const l = await bridge.list('');
    assert(Array.isArray(l) && l.length > 0, 'empty listing');
    const leaked = l.filter((n) => n.name.startsWith('.') || n.name === 'App' || n.name === 'node_modules');
    assert(leaked.length === 0, 'hidden entries leaked: ' + leaked.map((n) => n.name).join(','));
    assert(l.every((n) => typeof n.path === 'string' && !n.path.startsWith('/')), 'paths must be relative without a leading slash');
    return `${l.length} entries: ${l.slice(0, 6).map((n) => n.kind[0] + ':' + n.name).join(', ')}`;
  });

  await test('stat(file)', async () => {
    const s = await bridge.stat(sample.path);
    assert(s && s.exists === true && s.kind === 'file', 'bad stat: ' + JSON.stringify(s));
    assert(s.size > 0 && s.mtime > 0, 'size/mtime missing: ' + JSON.stringify(s));
    return `${sample.path} size=${s.size} mtime=${s.mtime}`;
  });

  await test('stat(missing)', async () => {
    const s = await bridge.stat('no/such/file-' + Date.now() + '.md');
    assert(s && s.exists === false, 'should not exist: ' + JSON.stringify(s));
    return 'exists=false';
  });

  await test('exists(missing)', async () => {
    assert((await bridge.exists('no/such/file-' + Date.now() + '.md')) === false, 'reported present');
    return 'false';
  });

  await test('readText', async () => {
    const t = await bridge.readText(sample.path);
    assert(typeof t === 'string' && t.length > 0, 'empty');
    assert(t.charCodeAt(0) !== 0xFEFF, 'BOM leaked into the text');
    return `${sample.path}, ${t.length} chars`;
  });

  await test('path escape rejected', async () => {
    try { await bridge.readText('../outside-the-vault.md'); } catch (e) { return trim(e.message, 120); }
    throw new Error('reading outside the root was allowed');
  });

  await test('search', async () => {
    const r = await bridge.search('the', { limit: 25 });
    assert(Array.isArray(r), 'not an array');
    assert(r.length <= 25, `limit ignored (${r.length} hits)`);
    if (r.length) assert(r[0].path && r[0].line > 0 && typeof r[0].text === 'string', 'bad hit shape: ' + JSON.stringify(r[0]));
    return `${r.length} hits${r.length ? `, first=${r[0].path}:${r[0].line}` : ''}`;
  });

  await test('getState / setState round trip', async () => {
    const before = await bridge.getState();
    assert(before && typeof before === 'object', 'state is not an object');
    const stamp = Date.now();
    await bridge.setState({ ...before, selftest: { at: stamp } });
    const back = await bridge.getState();
    assert(back && back.selftest && back.selftest.at === stamp, 'round trip failed: ' + trim(JSON.stringify(back), 120));
    await bridge.setState(before); // leave the vault's state as it was
    return `round trip ok, ${Object.keys(before).length} pre-existing keys restored`;
  });

  /* ------------------------------------------------------------ mutations */

  if (mutable) {
    await test('mkdir', async () => {
      await bridge.mkdir(DIR);
      assert(await bridge.exists(DIR), 'folder not created');
      return DIR;
    });
    await test('writeText', async () => {
      await bridge.writeText(`${DIR}/a.md`, '# hi\nline two\n');
      const t = await bridge.readText(`${DIR}/a.md`);
      assert(t === '# hi\nline two\n', 'content mismatch: ' + JSON.stringify(t));
      return 'LF preserved, no BOM';
    });
    await test('writeText creates parent dirs', async () => {
      await bridge.writeText(`${DIR}/deep/nested/x.md`, 'x');
      assert(await bridge.exists(`${DIR}/deep/nested/x.md`), 'not created');
      return `${DIR}/deep/nested/x.md`;
    });
    await test('appendText', async () => {
      await bridge.appendText(`${DIR}/a.md`, 'line three\n');
      const t = await bridge.readText(`${DIR}/a.md`);
      assert(t === '# hi\nline two\nline three\n', 'append mismatch: ' + JSON.stringify(t));
      return 'appended';
    });
    await test('writeBinary', async () => {
      await bridge.writeBinary(`${DIR}/b.png`, PNG1x1);
      const s = await bridge.stat(`${DIR}/b.png`);
      assert(s.exists && s.size === 70, 'wrong size: ' + JSON.stringify(s));
      return '70 bytes';
    });
    await test('rename', async () => {
      await bridge.rename(`${DIR}/a.md`, `${DIR}/c.md`);
      assert(await bridge.exists(`${DIR}/c.md`), 'target missing');
      assert((await bridge.exists(`${DIR}/a.md`)) === false, 'source still there');
      return `${DIR}/a.md -> ${DIR}/c.md`;
    });
    await test('trash', async () => {
      await sleep(300); // give the watcher a chance to report the writes above
      await bridge.trash(DIR);
      assert((await bridge.exists(DIR)) === false, 'still present');
      return 'sent to the trash';
    });
  } else {
    for (const n of ['mkdir', 'writeText', 'appendText', 'writeBinary', 'rename', 'trash']) {
      skipped(n, 'no .selftest marker at the vault root; refusing to write');
    }
  }

  /* ------------------------------------------------------------------ pty */

  // A pty that echoes one word and exits: it proves start, the data event, the base64 payload
  // and the exit event without needing the Claude CLI on the machine (CONTRACT batch 6).
  let ptyId = null;
  const win = bridge.platform === 'windows';
  await test('ptyStart', async () => {
    const spec = win
      ? { cmd: 'cmd.exe', args: ['/c', 'echo ptyok'] }
      : { cmd: '/bin/sh', args: ['-c', 'echo ptyok'] };
    const r = await bridge.ptyStart({ cwd: '', cols: 80, rows: 24, ...spec });
    assert(r && r.id, 'no pty id: ' + JSON.stringify(r));
    ptyId = r.id;
    return `id=${ptyId} (${spec.cmd} ${spec.args.join(' ')})`;
  });

  if (ptyId) {
    await test('pty data + exit within 20s', async () => {
      const deadline = Date.now() + PTY_WAIT_MS;
      let sawData = false, chunks = 0;
      while (Date.now() < deadline) {
        const mine = ptyEvents.filter((e) => e && e.id === ptyId);
        chunks = mine.filter((e) => e.data != null).length;
        if (!sawData) {
          const text = mine.filter((e) => e.data != null).map((e) => decodeB64(e.data)).join('');
          if (text.includes('ptyok')) sawData = true;
        }
        const done = mine.find((e) => 'exit' in e);
        if (sawData && done) return `${chunks} chunk(s), exit=${done.exit}`;
        if (done && !sawData) throw new Error('the process exited without a chunk containing ptyok');
        await sleep(100);
      }
      throw new Error(`no ${sawData ? 'exit event' : 'ptyok chunk'} in ${PTY_WAIT_MS}ms (${chunks} chunks seen)`);
    });
    await test('ptyKill after exit', async () => { await bridge.ptyKill(ptyId); return 'accepted'; });
  } else {
    for (const n of ['pty data + exit within 20s', 'ptyKill after exit']) skipped(n, 'ptyStart failed');
  }

  /* --------------------------------------------------------------- claude */

  await test('claudeInfo', async () => {
    const cli = await bridge.claudeInfo();
    assert(cli && typeof cli === 'object', 'bad shape: ' + JSON.stringify(cli));
    // A machine without the CLI (CI runners) is a note, not a failure: the command itself worked.
    return cli.path ? `${cli.path} ${cli.version || ''}` : 'no claude CLI on this machine';
  });

  /* --------------------------------------------------------------- window */

  await test('win.isMaximized', async () => String(await bridge.win.isMaximized()));
  await test('win.setTheme(dark)', async () => { await bridge.win.setTheme('dark'); return 'ok'; });
  await test('win.setTheme(light)', async () => { await sleep(150); await bridge.win.setTheme('light'); return 'ok'; });
  skipped('win.startDrag / startResize', 'both enter a modal mouse loop; they need a real mouse-down');

  /* ----------------------------------------------------------------- done */

  const line = `SELFTEST DONE pass=${pass} fail=${fail} skip=${skip}`;
  paint('done', '', line + `  root=${root && root.root}`);
  send(line);
  await sleep(1000);
  bridge.win.close().catch(() => { });
}

// Never let a hung command keep the window (and CI) alive for ever. The uppercase FAIL token is
// what turns the job red, so a hang has to emit one.
setTimeout(() => {
  fail++;
  report('fail', 'FAIL', 'hard stop', `the run did not finish within ${HARD_STOP_MS}ms`);
  send(`SELFTEST DONE pass=${pass} fail=${fail} skip=${skip}`);
  bridge.win.close().catch(() => { });
}, HARD_STOP_MS);

run().catch(async (e) => {
  fail++;
  report('fail', 'FAIL', 'runner crashed', trim(e && e.stack ? e.stack : e, 400));
  send(`SELFTEST DONE pass=${pass} fail=${fail} skip=${skip}`);
  await sleep(1000);
  bridge.win.close().catch(() => { });
});
