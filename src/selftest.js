// Host self-test. Loaded by selftest.html, which the host opens instead of index.html when it
// is started with --selftest. It drives the bridge facade (not a host protocol), so the same
// page tests the Tauri host, the .NET host, and the dev bridge in a browser.
//
// Every result goes out through `bridge.log` (the host writes it to --log, CI greps it) and is
// also drawn on the page. Mutating commands run only when the vault carries a `.selftest`
// marker, so pointing this at a real vault can never write to it.
// selftest.html links tokens.css and base.css, so the page wears the app's own colours.
import { bridge } from './bridge/index.js';
import { makeFacade } from './kernel/modules.js';
import { resolve } from './kernel/paths.js';

const out = document.getElementById('selftest');
const CALL_TIMEOUT_MS = 60000;
const HARD_STOP_MS = 200000; // under the CI job's own 240s kill, so the FAIL line still gets written

let pass = 0, fail = 0, skip = 0;

/* ------------------------------------------------------------------ output */

const head = document.createElement('div');
head.className = 'st-head';
head.textContent = 'ose selftest';
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
// The versions round trip writes a page like a user would, so it uses the scratch folder the
// vault already has for exactly that; the folder is only removed again when it was not there.
const SCRATCH = 'Scratchpad';
const VFILE = `${SCRATCH}/selftest-versions.md`;

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

  // The CI stamp (CONTRACT.md "Self-update"): `build` is {sha, short, date} on a build from
  // build.yml and null on a local one; either is right here.
  let stamped = null, origins = null;
  await test('platformInfo', async () => {
    const p = await bridge.platformInfo();
    assert(p && typeof p.os === 'string' && typeof p.version === 'string', 'bad shape: ' + trim(JSON.stringify(p), 160));
    assert(p.build === null || (p.build && /^[0-9a-f]{40}$/.test(p.build.sha) && p.build.short === p.build.sha.slice(0, 7)),
      'bad build stamp: ' + trim(JSON.stringify(p.build), 120));
    stamped = p.build;
    // Round four: the three origins are the host's to spell, never the page's
    // (docs/KERNEL.md "Origins"). The dev bridge has none and says so.
    if (bridge.kind === 'tauri') {
      origins = { kernel: p.kernelOrigin, app: p.appOrigin, vault: p.vaultOrigin };
      for (const [name, o] of Object.entries(origins)) {
        assert(typeof o === 'string' && o.length > 0, `no ${name} origin: ` + trim(JSON.stringify(p), 200));
        assert(!o.endsWith('/'), `${name} origin has a trailing slash: ${o}`);
      }
      const shape = p.os === 'windows' ? /^http:\/\/[a-z]+\.localhost$/ : /^[a-z]+:\/\/localhost$/;
      for (const [name, o] of Object.entries(origins)) assert(shape.test(o), `${name} origin is not this platform's shape: ${o}`);
      assert(p.api === 1, 'ose.api is not 1: ' + p.api);
    }
    return (stamped ? `build ${stamped.short} · ${stamped.date}` : 'dev build') +
      (origins ? `, kernel ${origins.kernel}` : '');
  });

  // The rice (docs/RICE.md). Shape always; the decision checked against the folder on disk.
  let rice = null;
  await test('riceInfo', async () => {
    rice = await bridge.riceInfo();
    assert(rice && typeof rice === 'object', 'not an object: ' + trim(JSON.stringify(rice), 160));
    assert(['vault', 'arg', 'none'].includes(rice.source), 'bad source: ' + rice.source);
    assert(typeof rice.present === 'boolean', 'present is not a boolean');
    assert(rice.requires === null || typeof rice.requires === 'number', 'bad requires: ' + rice.requires);
    assert(rice.dir === null || typeof rice.dir === 'string', 'bad dir: ' + rice.dir);
    return `dir=${rice.dir} source=${rice.source} present=${rice.present}${rice.disabled ? ' (disabled)' : ''}${rice.why ? ' why=' + rice.why : ''}`;
  });

  // The `app` origin: files only, no listing, and a path that tries to leave the rice folder
  // is a 404 rather than a redirect or a file from somewhere else.
  if (origins && rice && rice.present) {
    await test('app protocol serves the rice and rewrites index.html', async () => {
      const r = await fetch(`${origins.app}/index.html`);
      assert(r.status === 200, 'index.html: http ' + r.status);
      assert((r.headers.get('cache-control') || '').includes('no-store'), 'index.html is cacheable');
      const html = await r.text();
      assert(html.includes('"ose:kernel"') && html.includes(`${origins.kernel}/kernel.js`),
        'the import map is missing or does not carry the kernel origin');
      assert(html.includes(`${origins.kernel}/ui.css`), 'the ui stylesheet link was not rewritten');
      const csp = r.headers.get('content-security-policy') || '';
      assert(csp.includes("default-src 'none'"), 'no Content-Security-Policy on the rice page');
      assert(csp.includes(origins.vault), 'the CSP does not allow the vault origin');
      return `${html.length} bytes, csp ${csp.length} chars`;
    });

    await test('app protocol refuses to leave the rice folder', async () => {
      const tried = [];
      for (const bad of ['/../x', '/%2e%2e/x', '/../../CLAUDE.md', '/']) {
        const r = await fetch(origins.app + bad);
        // `/` is the rice's own index.html and must answer 200; the escapes must not.
        const want = bad === '/' ? 200 : 404;
        assert(r.status === want, `${bad}: http ${r.status}, expected ${want}`);
        tried.push(`${bad}=${r.status}`);
      }
      return tried.join(' ');
    });
  } else {
    skipped('app protocol', origins ? 'no rice in this vault' : 'not the Tauri host');
  }

  // The other half of the same promise, and the one that was false (QA-K defect 1): the `app`
  // protocol normalises `..` before it serves a file, and the **module facade** has to
  // normalise it before it compares a path with the module's `data`. This one needs no host at
  // all — it is the guard itself, run against a manifest made up here — so it runs everywhere
  // the self-test does, including the dev bridge in a browser.
  await test('the module facade refuses a `..` escape from its data folder', async () => {
    const stub = {
      platform: bridge.platform,
      // Nothing here reaches a file: the guard is what is under test, and a path it lets
      // through lands on these stubs instead of the vault.
      files: { assetUrl: () => '', versions: {}, read: async () => '', write: async () => null },
      watch: () => () => { },
      state: () => ({}),
      commands: {}, views: {}, tiles: {}, keys: {}, bus: {}, status: {}, settings: {}, route: {},
    };
    const entry = {
      id: 'selftest-scope',
      manifest: { id: 'selftest-scope', data: ['Scratchpad/selftest-scope'], run: [], routes: [] },
      offs: [], procs: new Set(),
    };
    const facade = makeFacade(stub, entry);
    const refused = [];
    // The first is QA-K's own repro; the others are the same trick spelled differently.
    for (const bad of ['Scratchpad/selftest-scope/../../CLAUDE.md',
                       'Scratchpad/selftest-scope/./../selftest-escaped.md',
                       'Scratchpad/selftest-scope/sub/../../../.ose/app/index.html']) {
      for (const verb of ['write', 'read']) {
        let msg = null;
        try { await facade.files[verb](bad, 'x'); } catch (e) { msg = String(e && e.message ? e.message : e); }
        assert(msg, `${verb} ${bad} was allowed`);
        assert(msg === `not allowed by module.json: ${verb} ${resolve(bad)}`, `${verb} ${bad}: ${msg}`);
      }
      refused.push(resolve(bad));
    }
    // And the guard still lets the module have its own folder, `.` and `..` inside it included.
    assert(resolve('Scratchpad/selftest-scope/a/../b.md') === 'Scratchpad/selftest-scope/b.md', 'resolve() is wrong');
    let ok = null;
    try { await facade.files.read('Scratchpad/selftest-scope/a/../b.md'); } catch (e) { ok = String(e && e.message ? e.message : e); }
    assert(ok === null || !/not allowed/.test(ok), 'its own folder was refused: ' + ok);
    return refused.join(' ');
  });

  // The check hits the real release API on a stamped build, so only the shape is asserted:
  // never `behind` (the runner may be building the very commit that would answer it), and an
  // error string (a rate limit, no network) is as valid an answer as a release.
  await test('updateCheck', async () => {
    const r = await bridge.updateCheck();
    assert(r && typeof r === 'object', 'not an object');
    assert(typeof r.behind === 'boolean' && Array.isArray(r.commits), 'bad shape: ' + trim(JSON.stringify(r), 160));
    assert(r.error === null || typeof r.error === 'string', 'error is neither null nor a string');
    if (stamped) {
      assert(r.current && r.current.sha === stamped.sha, 'current disagrees with the platform stamp');
      assert(r.latest === null || (typeof r.latest.sha === 'string' && typeof r.latest.short === 'string'), 'bad latest');
      assert(r.asset === null || (typeof r.asset.name === 'string' && typeof r.asset.url === 'string'), 'bad asset');
      return r.error ? `error: ${r.error}` : r.latest ? `latest ${r.latest.short}, behind=${r.behind}, ${r.commits.length} commits` : 'no release right now';
    }
    assert(r.current === null && r.latest === null && r.behind === false, 'a dev build must not check: ' + trim(JSON.stringify(r), 160));
    return 'dev build, no request made';
  });
  skipped('updateDownload / updateApply', 'they replace the running executable');

  // The vault commands (CONTRACT.md "Vault resolution"). `vaultInfo` must agree with rootInfo
  // and name a source. `forgetVault` deletes the per-user remembered-root file: it is only
  // exercised when there is none to delete, so a run on a developer's machine never forgets
  // the vault that machine remembers.
  let remembered = null;
  await test('vaultInfo', async () => {
    const v = await bridge.vaultInfo();
    assert(v && v.root === root.root && v.name === root.name, 'disagrees with rootInfo: ' + trim(JSON.stringify(v), 160));
    assert(typeof v.remembered === 'boolean', 'remembered is not a boolean');
    assert(typeof v.source === 'string' && v.source.length > 0, 'no source: ' + trim(JSON.stringify(v), 120));
    remembered = v.remembered;
    return `source=${v.source} remembered=${v.remembered}`;
  });
  if (remembered === false) {
    await test('forgetVault (nothing to forget)', async () => {
      const r = await bridge.forgetVault();
      assert(r === null, 'expected null, got ' + trim(JSON.stringify(r), 80));
      const v = await bridge.vaultInfo();
      assert(v && v.root === root.root, 'the open vault changed: ' + trim(JSON.stringify(v), 160));
      assert(v.remembered === false, 'a remembered root appeared');
      return 'null, the open vault untouched';
    });
  } else {
    skipped('forgetVault', remembered === null ? 'vaultInfo failed' : 'this machine remembers a vault; not deleting it');
  }

  // The vaults this machine has opened (CONTRACT.md "Vault resolution", S46). Shape only: the
  // list is the user's own history, and a self-test must not care what is in it. The dev bridge
  // answers with the one vault it serves, which satisfies the same shape.
  await test('recentVaults', async () => {
    const r = await bridge.recentVaults();
    assert(Array.isArray(r), 'not an array: ' + trim(JSON.stringify(r), 120));
    assert(r.length <= 10, `more than ten remembered: ${r.length}`);
    for (const v of r) {
      assert(v && typeof v.path === 'string' && v.path.length > 0, 'no path: ' + trim(JSON.stringify(v), 120));
      assert(typeof v.name === 'string' && typeof v.exists === 'boolean' && typeof v.current === 'boolean',
        'bad entry: ' + trim(JSON.stringify(v), 120));
    }
    assert(r.filter((v) => v.current).length <= 1, 'two vaults claim to be the open one');
    return `${r.length} remembered${r.length ? `, first=${r[0].name}` : ''}`;
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

  // A byte-order mark is a byte of the file, not a character of the document: the bridge hands
  // it over as it found it and the editor's `doc.js` strips and restores it (F14). Nothing is
  // asserted about this particular file, which may have one or not.
  await test('readText', async () => {
    const t = await bridge.readText(sample.path);
    assert(typeof t === 'string' && t.length > 0, 'empty');
    return `${sample.path}, ${t.length} chars${t.charCodeAt(0) === 0xFEFF ? ', with a BOM' : ''}`;
  });

  await test('path escape rejected', async () => {
    try { await bridge.readText('../outside-the-vault.md'); } catch (e) { return trim(e.message, 120); }
    throw new Error('reading outside the root was allowed');
  });

  await test('search', async () => {
    // Batch 12: the answer is `{hits, files, total, capped, stale}`, the limit counts files,
    // and `line: 0` is a file- or folder-name match.
    const r = await bridge.search('the', { limit: 25 });
    assert(r && Array.isArray(r.hits), 'not a {hits} answer');
    const files = new Set(r.hits.map((h) => h.path)).size;
    assert(files <= 25, `limit ignored (${files} files)`);
    assert(typeof r.total === 'number' && typeof r.capped === 'boolean', 'no total/capped');
    if (r.hits.length) {
      const h = r.hits[0];
      assert(h.path && h.line >= 0 && typeof h.text === 'string', 'bad hit shape: ' + JSON.stringify(h));
    }
    return `${r.hits.length} hits in ${r.files} of ${r.total} files${r.hits.length ? `, first=${r.hits[0].path}:${r.hits[0].line}` : ''}`;
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

  /* ----------------------------------------------------------------- run */

  // `run` (docs/KERNEL.md). Two things are proved: a program in the caller's allow list runs
  // and comes back byte for byte in UTF-8, and a program in neither allow list is refused.
  // Nothing is allowed by default, so the refusal is the case that needs no fixture at all.
  await test('run refuses a program nobody allowed', async () => {
    const id = 'selftest-refused-' + Date.now();
    try {
      await bridge.run(id, 'definitely-not-allowed-' + Date.now(), [], {});
    } catch (e) {
      const m = String(e && e.message ? e.message : e);
      assert(m.includes('not allowed:'), 'refused for the wrong reason: ' + trim(m, 160));
      return trim(m, 120);
    }
    throw new Error('a program in neither allow list was started');
  });

  // python first (the UTF-8 environment is what `PYTHONUTF8=1` is for), node as the fallback,
  // because one of the two exists on every machine this ever runs on.
  const runOnce = async (program, args) => {
    const id = `selftest-run-${program}-${Date.now()}`;
    const out = [], err = [];
    return await new Promise((resolve, reject) => {
      const off = bridge.on('run', (d) => {
        if (!d || d.id !== id) return;
        if (d.done) { off(); resolve({ code: d.code, timedOut: d.timedOut, out: out.join('\n'), err: err.join('\n') }); return; }
        (d.stream === 'stderr' ? err : out).push(d.line);
      });
      bridge.run(id, program, args, { allow: [program], timeout: 20000 }).catch((e) => { off(); reject(e); });
    });
  };

  let ran = null;
  for (const [program, args] of [
    ['python', ['-c', "print('\u00e9')"]],
    ['python3', ['-c', "print('\u00e9')"]],
    ['node', ['-e', "process.stdout.write('\u00e9\\n')"]],
  ]) {
    try { ran = { program, r: await runOnce(program, args) }; break; } catch { /* not on this machine */ }
  }
  if (ran) {
    await test(`run ${ran.program} (UTF-8 round trip)`, async () => {
      const { code, timedOut, out, err } = ran.r;
      assert(timedOut === false, 'it timed out');
      assert(code === 0, `exit ${code}: ${trim(err, 160)}`);
      assert(out === '\u00e9', `stdout was ${JSON.stringify(out)}, expected "\u00e9"`);
      return `code=0, stdout=${JSON.stringify(out)}`;
    });

    await test('runKill', async () => {
      const id = 'selftest-kill-' + Date.now();
      const done = new Promise((resolve) => {
        const off = bridge.on('run', (d) => { if (d && d.id === id && d.done) { off(); resolve(d); } });
      });
      const sleeper = ran.program.startsWith('python')
        ? [ran.program, ['-c', 'import time; time.sleep(30)']]
        : [ran.program, ['-e', 'setTimeout(()=>{},30000)']];
      await bridge.run(id, sleeper[0], sleeper[1], { allow: [sleeper[0]], timeout: 30000 });
      assert((await bridge.runKill(id)) === true, 'runKill did not find the process');
      const d = await withTimeout(done, 10000, 'the killed process never reported done');
      assert(d.done === true, 'no done event');
      assert((await bridge.runKill(id)) === false, 'a finished id is still in the table');
      return `killed, code=${d.code}`;
    });
  } else {
    skipped('run', 'neither python nor node is on PATH');
    skipped('runKill', 'neither python nor node is on PATH');
  }

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

    /* ------------------------------------------------------- versions */

    // The four version commands (CONTRACT.md batch 12, "Versions") against one scratch page:
    // keep it, list it, read it back, then restore it over a changed file. The page and its
    // history go at the end, and the scratch folder too when this test is what created it.
    let hadScratch = true, kept = null;
    await test('versionKeep', async () => {
      hadScratch = await bridge.exists(SCRATCH);
      await bridge.writeText(VFILE, '# one\n');
      const r = await bridge.versionKeep(VFILE, '# one\n', true);
      assert(r && r.kept === true && typeof r.id === 'string' && r.id.length > 0,
        'nothing kept: ' + trim(JSON.stringify(r), 120));
      assert(/^\d{4}-\d{2}-\d{2}-\d{6}$/.test(r.id), 'not a timestamp id: ' + r.id);
      kept = r.id;
      // The same text is never kept twice, forced or not.
      const again = await bridge.versionKeep(VFILE, '# one\n', true);
      assert(again && again.kept === false, 'the same text was kept twice: ' + trim(JSON.stringify(again), 120));
      return `id=${kept}`;
    });

    await test('versionList', async () => {
      const l = await bridge.versionList(VFILE);
      assert(Array.isArray(l) && l.length === 1, 'expected one version: ' + trim(JSON.stringify(l), 120));
      const v = l[0];
      assert(v.id === kept, `listed ${v.id}, kept ${kept}`);
      assert(typeof v.at === 'number' && v.at > 0 && typeof v.bytes === 'number' && v.bytes > 0,
        'bad entry: ' + trim(JSON.stringify(v), 120));
      return `${l.length} version, ${v.bytes} bytes`;
    });

    await test('versionRead', async () => {
      const t = await bridge.versionRead(VFILE, kept);
      assert(t === '# one\n', 'content mismatch: ' + JSON.stringify(t));
      try { await bridge.versionRead(VFILE, '../../../secret'); } catch { return 'text back, a bad id refused'; }
      throw new Error('a version id that is not a timestamp was accepted');
    });

    await test('versionRestore', async () => {
      await bridge.writeText(VFILE, '# two\n');
      const r = await bridge.versionRestore(VFILE, kept);
      assert(r && r.kept === true && typeof r.id === 'string', 'the replaced text was not kept: ' + trim(JSON.stringify(r), 120));
      assert((await bridge.readText(VFILE)) === '# one\n', 'the version was not written over the file');
      const l = await bridge.versionList(VFILE);
      assert(l.length === 2, 'expected two versions: ' + trim(JSON.stringify(l), 160));
      assert((await bridge.versionRead(VFILE, r.id)) === '# two\n', 'the kept text is not the text that was replaced');
      return `restored ${kept}, kept ${r.id}`;
    });

    await test('versions cleaned up', async () => {
      await sleep(300); // the watcher again
      await bridge.trash(VFILE);
      await bridge.trash(`.ose/versions/${VFILE}`);
      assert((await bridge.exists(VFILE)) === false, 'the page is still there');
      assert((await bridge.exists(`.ose/versions/${VFILE}`)) === false, 'the history is still there');
      // A folder this test created holds nothing else, history included.
      if (!hadScratch) {
        await bridge.trash(SCRATCH);
        await bridge.trash(`.ose/versions/${SCRATCH}`);
      }
      return hadScratch ? 'page and history gone' : `page, history and ${SCRATCH} gone`;
    });
  } else {
    for (const n of ['mkdir', 'writeText', 'appendText', 'writeBinary', 'rename', 'trash',
      'versionKeep', 'versionList', 'versionRead', 'versionRestore']) {
      skipped(n, 'no .selftest marker at the vault root; refusing to write');
    }
  }

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
