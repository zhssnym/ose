//! Pseudo-terminals: one native pty per session (ConPTY on Windows, forkpty on unix).
//!
//! The Claude Code CLI is run interactively inside one of these and the web side draws it with
//! xterm.js, so the host does not parse anything: raw output bytes go up as base64 chunks and
//! raw input bytes come back down. See CONTRACT.md, "Batch 6".
//!
//! ```text
//! ptyStart({cwd, cols, rows, cmd?, args?, env?}) -> {id}
//! ptyWrite(id, data)      ptyResize(id, cols, rows)      ptyKill(id)
//! event "pty"  {id, data: base64}   |   {id, exit: code}
//! ```

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::{arg_str, log_line, platform, AppState, Ctx};

/// Output read within one window is emitted as a single event: a fast writer produces a few
/// hundred events a second instead of one per read.
const COALESCE: Duration = Duration::from_millis(8);
/// How long the pump waits for the child's status once the session is over.
const EXIT_GRACE: Duration = Duration::from_secs(5);
/// How often the pump looks up from the output buffer to see whether the child is still alive.
const POLL: Duration = Duration::from_millis(25);
/// How long output is still collected after the child was first seen gone.
const DRAIN: Duration = Duration::from_millis(150);
/// One read syscall's worth of pty output.
const READ_BUF: usize = 64 * 1024;
/// ConPTY's opening "where is the cursor?" (DSR 6) and the report the host answers it with.
#[cfg(windows)]
const CPR_QUERY: &[u8] = b"\x1b[6n";
#[cfg(windows)]
const CPR_REPLY: &[u8] = b"\x1b[1;1R";

// ---- session table --------------------------------------------------------

struct PtyEntry {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pid: Option<u32>,
}

/// The live ptys, keyed by the id `ptyStart` returned.
#[derive(Default)]
pub struct Ptys {
    map: Mutex<HashMap<String, PtyEntry>>,
}

/// A poisoned mutex here only means a pump thread panicked; the data behind it is still usable.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---- rpc ------------------------------------------------------------------

pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    match cmd {
        "ptyStart" => Some(start(ctx, args)),
        "ptyWrite" => Some(write(ctx, args)),
        "ptyResize" => Some(resize(ctx, args)),
        "ptyKill" => Some(kill(ctx, args)),
        _ => None,
    }
}

fn start(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    let opts = Opts::from_args(&ctx.st.root, args)?;
    let (id, entry, reader, child) = open(&opts)?;

    log_line(
        ctx.st,
        &format!(
            "pty start {id}: {} {} (cwd {}, {}x{})",
            opts.cmd.display(),
            opts.args.join(" "),
            opts.cwd.display(),
            opts.cols,
            opts.rows
        ),
    );

    // In the table before the threads start: the pump takes the entry back out when the child
    // exits, and a command short enough to finish first must not leave a dead entry behind.
    lock(&ctx.st.ptys.map).insert(id.clone(), entry);

    let app = ctx.app.clone();
    let sid = id.clone();
    pump(reader, child, move |msg| emit(&app, &sid, msg));

    Ok(json!({ "id": id }))
}

fn write(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    let id = arg_str(args, 0)?;
    let data = arg_str(args, 1)?;
    let map = lock(&ctx.st.ptys.map);
    let e = map.get(&id).ok_or_else(|| format!("no pty {id}"))?;
    let mut w = lock(&e.writer);
    w.write_all(data.as_bytes())
        .and_then(|()| w.flush())
        .map_err(|err| format!("write to pty {id} failed: {err}"))?;
    Ok(Value::Null)
}

fn resize(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    let id = arg_str(args, 0)?;
    let cols = dim(args.get(1), 80);
    let rows = dim(args.get(2), 24);
    let map = lock(&ctx.st.ptys.map);
    let e = map.get(&id).ok_or_else(|| format!("no pty {id}"))?;
    e.master
        .resize(size(cols, rows))
        .map_err(|err| format!("resize of pty {id} failed: {err}"))?;
    Ok(Value::Null)
}

/// Killing a pty is not an error when it has already exited: the pump removes finished ptys
/// from the table on its own, and the web side may well kill one it has just seen exit.
fn kill(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    let id = arg_str(args, 0)?;
    if let Some(e) = lock(&ctx.st.ptys.map).remove(&id) {
        log_line(ctx.st, &format!("pty kill {id}"));
        kill_entry(&e);
    }
    Ok(Value::Null)
}

/// Every pty dies with the app.
pub fn kill_all(st: &AppState) {
    let entries: Vec<PtyEntry> = lock(&st.ptys.map).drain().map(|(_, e)| e).collect();
    for e in &entries {
        kill_entry(e);
    }
}

/// Terminate the child (its whole tree: the CLI spawns helpers) and drop the master, which
/// closes the pty and lets the pump thread finish.
fn kill_entry(e: &PtyEntry) {
    if let Some(pid) = e.pid {
        kill_tree(pid);
    }
    let _ = lock(&e.child).kill();
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::process::Stdio;
    let _ = platform::quiet_command("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    use std::process::{Command, Stdio};
    // The pty session leader is the process group leader, so the negative pid kills the tree.
    let _ = Command::new("kill")
        .args(["-TERM", "--", &format!("-{pid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

// ---- options --------------------------------------------------------------

struct Opts {
    cwd: PathBuf,
    cmd: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cols: u16,
    rows: u16,
}

impl Opts {
    /// `{cwd, cols, rows, cmd?, args?, env?}`. `cmd` defaults to the Claude Code CLI; a cwd
    /// that is not a directory falls back to the vault root, like `claudeStart` did.
    fn from_args(root: &std::path::Path, args: &[Value]) -> Result<Self, String> {
        let o = args.first().and_then(Value::as_object);
        let field = |k: &str| o.and_then(|m| m.get(k));

        let rel = field("cwd").and_then(Value::as_str).unwrap_or_default();
        let mut cwd = crate::vault::resolve(root, rel)?;
        if !cwd.is_dir() {
            cwd = root.to_path_buf();
        }

        let cmd = match field("cmd").and_then(Value::as_str).map(str::trim) {
            Some(s) if !s.is_empty() => PathBuf::from(s),
            _ => platform::find_claude().ok_or_else(|| "claude CLI not found".to_string())?,
        };

        let args = field("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();

        let env = field("env")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        Ok(Self {
            cwd,
            cmd,
            args,
            env,
            cols: dim(field("cols"), 80),
            rows: dim(field("rows"), 24),
        })
    }
}

/// A terminal dimension: a positive number, clamped to something a pty will accept.
fn dim(v: Option<&Value>, fallback: u16) -> u16 {
    match v.and_then(Value::as_i64) {
        Some(n) if n > 0 => n.min(1020) as u16,
        _ => fallback,
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

// ---- opening --------------------------------------------------------------

/// Opens the pty, spawns the command in it and returns the table entry plus the two handles the
/// pump thread needs. Split out of `start` so the test can drive it without an `AppHandle`.
#[allow(clippy::type_complexity)]
fn open(
    o: &Opts,
) -> Result<
    (
        String,
        PtyEntry,
        Box<dyn Read + Send>,
        Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    ),
    String,
> {
    let pair = native_pty_system()
        .openpty(size(o.cols, o.rows))
        .map_err(|e| format!("failed to open a pty: {e}"))?;

    // CommandBuilder starts from this process's environment, so these are merges, not a
    // replacement. The three terminal variables come first: the caller's `env` may override them.
    let mut cmd = CommandBuilder::new(&o.cmd);
    for a in &o.args {
        cmd.arg(a);
    }
    cmd.cwd(&o.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env(
        "LANG",
        std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_string()),
    );
    for (k, v) in &o.env {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to start {}: {e}", o.cmd.display()))?;
    // Nothing else may hold the slave end: on unix an open slave fd keeps the master from ever
    // reaching EOF, and there is no reason to keep it on Windows either.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("failed to read the pty: {e}"))?;
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("failed to write the pty: {e}"))?;

    // portable-pty opens the pseudoconsole with PSUEDOCONSOLE_INHERIT_CURSOR, so ConPTY starts
    // by asking the terminal where the cursor is and keeps the child suspended until it is told
    // (a child left waiting dies with STATUS_DLL_INIT_FAILED). Answer the handshake here rather
    // than relying on whoever is watching: `ptyStart` has to work with no terminal attached, and
    // a second answer from xterm would reach the program as keystrokes. The query is stripped
    // from the output in the reader so the web side never sees it.
    #[cfg(windows)]
    {
        let _ = writer.write_all(CPR_REPLY).and_then(|()| writer.flush());
    }

    let pid = child.process_id();
    let child = Arc::new(Mutex::new(child));
    let entry = PtyEntry {
        master: pair.master,
        writer: Mutex::new(writer),
        child: Arc::clone(&child),
        pid,
    };
    Ok((random_hex(12), entry, reader, child))
}

// ---- reading --------------------------------------------------------------

/// What the pump hands to its sink.
enum Msg {
    /// Raw bytes, already base64 encoded.
    Data(String),
    Exit(i32),
}

/// Drops ConPTY's opening cursor-position query, which `open` has already answered, from the
/// front of the stream. Everything after it, including a later query the program makes itself,
/// passes through untouched. A no-op everywhere but Windows.
#[derive(Default)]
struct Opening {
    #[cfg(windows)]
    seen: Vec<u8>,
    done: bool,
}

impl Opening {
    /// The bytes to forward, or `None` when the whole read was swallowed (a partial query).
    fn filter<'a>(&mut self, chunk: &'a [u8]) -> Option<&'a [u8]> {
        if self.done || !cfg!(windows) {
            self.done = true;
            return Some(chunk);
        }
        #[cfg(windows)]
        {
            self.seen.extend_from_slice(chunk);
            // Still inside a possible query: wait for the rest rather than guess.
            if self.seen.len() < CPR_QUERY.len() && CPR_QUERY.starts_with(&self.seen) {
                return None;
            }
            self.done = true;
            if self.seen.starts_with(CPR_QUERY) {
                // The query never spans a read in practice, so what is left is this chunk's tail.
                let dropped = CPR_QUERY.len() - (self.seen.len() - chunk.len());
                return Some(&chunk[dropped..]);
            }
        }
        Some(chunk)
    }
}

/// A buffer filled by the reader thread and drained by the flusher thread.
#[derive(Default)]
struct Buf {
    bytes: Vec<u8>,
    eof: bool,
}

/// Starts the two threads that turn pty output into `Msg`s: one blocks in `read`, the other
/// emits at most one chunk per `COALESCE` window and finally the exit code.
fn pump<S: Fn(Msg) + Send + 'static>(
    mut reader: Box<dyn Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    sink: S,
) {
    let shared = Arc::new((Mutex::new(Buf::default()), Condvar::new()));

    let producer = Arc::clone(&shared);
    spawn_named("pty-read", move || {
        let (buf, cv) = &*producer;
        let mut chunk = vec![0u8; READ_BUF];
        let mut opening = Opening::default();
        loop {
            match reader.read(&mut chunk) {
                // EOF on Windows shows up as a broken-pipe error rather than a zero read.
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let Some(out) = opening.filter(&chunk[..n]) else { continue };
                    lock(buf).bytes.extend_from_slice(out);
                    cv.notify_all();
                }
            }
        }
        lock(buf).eof = true;
        cv.notify_all();
    });

    spawn_named("pty-emit", move || {
        let (buf, cv) = &*shared;
        // ConPTY holds the output pipe open for as long as the pseudoconsole lives, so EOF is
        // not the end of a session: the child's own status is. `finished` is when it was first
        // seen gone, and the loop keeps draining for `DRAIN` after that so nothing trailing is
        // lost. On unix EOF arrives as well and ends the loop the short way.
        let mut finished: Option<Instant> = None;
        loop {
            {
                let g = lock(buf);
                if g.bytes.is_empty() && !g.eof {
                    let _ = cv.wait_timeout(g, POLL);
                }
            }
            let (pending, eof) = {
                let g = lock(buf);
                (!g.bytes.is_empty(), g.eof)
            };

            if pending {
                // Let the rest of this burst land before taking the buffer.
                thread::sleep(COALESCE);
                let bytes = std::mem::take(&mut lock(buf).bytes);
                if !bytes.is_empty() {
                    sink(Msg::Data(base64::engine::general_purpose::STANDARD.encode(&bytes)));
                }
                continue;
            }
            if eof {
                break;
            }
            match lock(&child).try_wait() {
                Ok(Some(_)) if finished.is_some_and(|t| t.elapsed() >= DRAIN) => break,
                Ok(Some(_)) => finished.get_or_insert_with(Instant::now),
                Ok(None) => continue,
                Err(_) => break,
            };
        }
        sink(Msg::Exit(wait_for_exit(&child, EXIT_GRACE)));
    });
}

/// Polls rather than blocking in `wait()`, so the child mutex is never held across a wait and
/// `ptyKill` can always reach the child.
fn wait_for_exit(child: &Mutex<Box<dyn Child + Send + Sync>>, timeout: Duration) -> i32 {
    let deadline = Instant::now() + timeout;
    loop {
        match lock(child).try_wait() {
            Ok(Some(status)) => return status.exit_code() as i32,
            Ok(None) => {}
            Err(_) => return -1,
        }
        if Instant::now() >= deadline {
            return -1;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// `{id, data}` while it runs, `{id, exit}` once. The entry is dropped from the table with the
/// exit event, so a later `ptyKill` is a no-op rather than an error.
fn emit(app: &AppHandle, id: &str, msg: Msg) {
    let payload = match &msg {
        Msg::Data(b64) => json!({ "id": id, "data": b64 }),
        Msg::Exit(code) => json!({ "id": id, "exit": code }),
    };
    if let Msg::Exit(_) = msg {
        if let Some(st) = tauri::Manager::try_state::<AppState>(app) {
            lock(&st.ptys.map).remove(id);
        }
    }
    let _ = app.emit("pty", payload);
}

fn spawn_named<F: FnOnce() + Send + 'static>(name: &str, f: F) {
    if thread::Builder::new().name(name.to_string()).spawn(f).is_err() {
        eprintln!("failed to start the {name} thread");
    }
}

// ---- ids ------------------------------------------------------------------

fn splitmix64(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Local ids only: a counter, the clock and a stack address, mixed. Nothing here is a secret.
fn random_hex(n: usize) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let addr = std::ptr::addr_of!(c) as usize as u64;
    let mut x = splitmix64(now ^ splitmix64(c ^ addr));
    let mut s = String::with_capacity(n + 16);
    while s.len() < n {
        x = splitmix64(x);
        s.push_str(&format!("{x:016x}"));
    }
    s.truncate(n);
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn ids_are_shaped_and_unique() {
        assert_eq!(random_hex(12).len(), 12);
        assert_ne!(random_hex(12), random_hex(12));
    }

    #[test]
    fn dimensions_are_sane() {
        assert_eq!(dim(Some(&json!(120)), 80), 120);
        assert_eq!(dim(Some(&json!(0)), 80), 80);
        assert_eq!(dim(Some(&json!("x")), 24), 24);
        assert_eq!(dim(None, 24), 24);
        assert_eq!(dim(Some(&json!(99_999)), 80), 1020);
    }

    #[test]
    fn options_come_off_the_rpc_argument() {
        let root = std::env::temp_dir();
        let args = vec![json!({
            "cwd": "",
            "cols": 120,
            "rows": 40,
            "cmd": "  cmd.exe  ",
            "args": ["/c", "echo hi"],
            "env": { "FOO": "bar", "N": 3 },
        })];
        let o = Opts::from_args(&root, &args).unwrap();
        assert_eq!(o.cwd, root);
        assert_eq!(o.cmd, PathBuf::from("cmd.exe"));
        assert_eq!(o.args, ["/c", "echo hi"]);
        assert_eq!(o.env, [("FOO".to_string(), "bar".to_string())]); // non-strings are dropped
        assert_eq!((o.cols, o.rows), (120, 40));

        // A cwd that is not a directory falls back to the root, and one outside it is refused.
        let o = Opts::from_args(&root, &[json!({ "cwd": "nope", "cmd": "cmd.exe" })]).unwrap();
        assert_eq!(o.cwd, root);
        assert_eq!((o.cols, o.rows), (80, 24));
        assert!(Opts::from_args(&root, &[json!({ "cwd": "../x", "cmd": "cmd.exe" })]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn the_opening_query_is_swallowed_once() {
        let mut o = Opening::default();
        assert_eq!(o.filter(b"\x1b[6nhello").unwrap(), b"hello");
        // A later query is the program's own and has to reach the terminal.
        assert_eq!(o.filter(b"\x1b[6n").unwrap(), b"\x1b[6n");

        // Split across reads.
        let mut o = Opening::default();
        assert!(o.filter(b"\x1b[").is_none());
        assert_eq!(o.filter(b"6nhi").unwrap(), b"hi");

        // Output that merely starts with an escape is not a query.
        let mut o = Opening::default();
        assert_eq!(o.filter(b"\x1b[2Jx").unwrap(), b"\x1b[2Jx");
    }

    /// The real thing: a command run through `open` + `pump`, with a channel where the app
    /// handle would be. Output has to arrive base64 encoded and the exit event has to follow.
    #[test]
    fn echoes_through_a_real_pty() {
        let (cmd, args) = if cfg!(windows) {
            ("cmd.exe", vec!["/c".to_string(), "echo ptyok".to_string()])
        } else {
            ("/bin/sh", vec!["-c".to_string(), "echo ptyok".to_string()])
        };
        let opts = Opts {
            cwd: std::env::temp_dir(),
            cmd: PathBuf::from(cmd),
            args,
            env: Vec::new(),
            cols: 80,
            rows: 24,
        };

        let (id, entry, reader, child) = open(&opts).expect("the pty opens");
        assert_eq!(id.len(), 12);

        let (tx, rx) = channel();
        pump(reader, child, move |msg| {
            let _ = tx.send(match msg {
                Msg::Data(b64) => {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(&b64)
                        .expect("chunks are valid base64");
                    Some(String::from_utf8_lossy(&bytes).into_owned())
                }
                Msg::Exit(code) => {
                    assert_eq!(code, 0, "echo exits cleanly");
                    None
                }
            });
        });

        let mut seen = String::new();
        loop {
            let msg = rx
                .recv_timeout(Duration::from_secs(20))
                .expect("data then exit arrive");
            match msg {
                Some(text) => seen.push_str(&text),
                None => break, // the exit event ends the stream
            }
        }
        assert!(seen.contains("ptyok"), "pty output was {seen:?}");

        // The entry stays usable until it is dropped; resizing a finished pty must not panic.
        let _ = entry.master.resize(size(100, 30));
    }
}
