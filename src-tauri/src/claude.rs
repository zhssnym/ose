//! Claude Code CLI sessions.
//!
//! One long-lived process per session in stream-json mode. Every stdout line the CLI writes is
//! forwarded to the web side untouched: the event JSON is built by string concatenation and
//! validated, never re-serialised, so key order and number formatting survive.
//!
//! Ported from `host/ClaudeProcess.cs`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::value::RawValue;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

#[cfg(unix)]
use std::process::Command;

use crate::{arg_str, arg_str_or, log_line, opt_field_str, platform, AppState, Ctx};

/// How long the stdout reader waits for the process to actually exit once its stdout closes.
const EXIT_GRACE: Duration = Duration::from_secs(10);
/// How long `claude --version` may take before the probe gives up.
const VERSION_TIMEOUT: Duration = Duration::from_secs(30);

// ---- session table --------------------------------------------------------

struct Session {
    id: String,
    pid: u32,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

/// The live sessions. The inner `Arc` is what the reader threads keep, so a session can remove
/// itself when its process exits without reaching back into `AppState`.
pub struct Sessions {
    map: Arc<Mutex<HashMap<String, Session>>>,
}

impl Default for Sessions {
    fn default() -> Self {
        Self { map: Arc::new(Mutex::new(HashMap::new())) }
    }
}

/// A poisoned mutex here only means a reader thread panicked; the data is still usable.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---- rpc ------------------------------------------------------------------

pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    match cmd {
        "claudeInfo" => Some(Ok(info())),
        "claudeStart" => Some(start(ctx, args)),
        "claudeSend" => Some(cmd_send(ctx, args)),
        "claudeInterrupt" => Some(cmd_interrupt(ctx, args)),
        "claudeStop" => Some(cmd_stop(ctx, args)),
        "claudeTranscript" => Some(Ok(transcript(ctx, &arg_str_or(args, 0, "")))),
        _ => None,
    }
}

fn cmd_send(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    let id = arg_str(args, 0)?;
    let text = arg_str(args, 1)?;
    send(ctx, &id, &text)?;
    Ok(Value::Null)
}

fn cmd_interrupt(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    interrupt(ctx, &arg_str(args, 0)?)?;
    Ok(Value::Null)
}

fn cmd_stop(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    stop(ctx, &arg_str(args, 0)?)?;
    Ok(Value::Null)
}

// ---- discovery ------------------------------------------------------------

struct Cli {
    path: PathBuf,
    version: Option<String>,
}

static CLI: OnceLock<Option<Cli>> = OnceLock::new();

/// Located once per run, `--version` included.
fn cli() -> Option<&'static Cli> {
    CLI.get_or_init(|| {
        let path = platform::find_claude()?;
        let version = run_capture(&path, &["--version"], VERSION_TIMEOUT)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Some(Cli { path, version })
    })
    .as_ref()
}

fn info() -> Value {
    match cli() {
        Some(c) => json!({ "path": c.path.display().to_string(), "version": c.version }),
        None => json!({ "path": Value::Null, "version": Value::Null }),
    }
}

/// Runs a short command and returns its stdout, or `None` on failure or timeout.
fn run_capture(exe: &std::path::Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = platform::quiet_command(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = child.wait_with_output().ok()?;
                return status
                    .success()
                    .then(|| String::from_utf8_lossy(&out.stdout).into_owned());
            }
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return None;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

// ---- start ----------------------------------------------------------------

fn start(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    let cli =
        cli().ok_or_else(|| "Claude Code CLI not found on PATH or in ~/.local/bin".to_string())?;

    let opt = |k: &str| opt_field_str(args, 0, k).map(|s| s.trim().to_string());
    let mode = opt("permissionMode").unwrap_or_else(|| "default".to_string());

    let mut workdir = crate::vault::resolve(&ctx.st.root, &opt("cwd").unwrap_or_default())?;
    if !workdir.is_dir() {
        workdir = ctx.st.root.clone();
    }

    let mut argv: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    argv.push(mode);
    if let Some(r) = opt("resume") {
        argv.push("--resume".to_string());
        argv.push(r);
    }
    if let Some(m) = opt("model") {
        argv.push("--model".to_string());
        argv.push(m);
    }

    let mut cmd = platform::quiet_command(&cli.path);
    cmd.current_dir(&workdir)
        .args(&argv)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        // Own process group, so stopping the session can kill the whole tree.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start the Claude Code CLI: {e}"))?;

    let id = random_hex(12);
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));

    lock(&ctx.st.claude.map).insert(
        id.clone(),
        Session {
            id: id.clone(),
            pid,
            child: Arc::clone(&child),
            stdin: Arc::new(Mutex::new(stdin)),
        },
    );
    log_line(
        ctx.st,
        &format!(
            "claude start {id}: {} (cwd {})",
            argv.join(" "),
            workdir.display()
        ),
    );

    if let Some(out) = stdout {
        let app = ctx.app.clone();
        let sid = id.clone();
        let map = Arc::clone(&ctx.st.claude.map);
        let child = Arc::clone(&child);
        spawn_named("claude-stdout", move || {
            read_lines(out, |line| forward_line(&app, &sid, line, false));
            // stdout closed: the process is finished or finishing.
            let code = wait_for_exit(&child, EXIT_GRACE);
            eprintln!("claude exit {sid}: {code}");
            emit_raw(&app, &sid, &format!("{{\"type\":\"exit\",\"code\":{code}}}"));
            lock(&map).remove(&sid);
        });
    }
    if let Some(err) = stderr {
        let app = ctx.app.clone();
        let sid = id.clone();
        spawn_named("claude-stderr", move || {
            read_lines(err, |line| forward_line(&app, &sid, line, true));
        });
    }

    Ok(json!({ "id": id }))
}

fn spawn_named<F: FnOnce() + Send + 'static>(name: &str, f: F) {
    if thread::Builder::new().name(name.to_string()).spawn(f).is_err() {
        eprintln!("failed to start the {name} thread");
    }
}

// ---- reading and forwarding ----------------------------------------------

/// Line reader that tolerates CRLF, a BOM and invalid UTF-8 (the CLI writes UTF-8, but a
/// crashing child can emit anything and it must not kill the reader).
fn read_lines<R: Read>(r: R, mut f: impl FnMut(&str)) {
    let mut reader = BufReader::new(r);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        while matches!(buf.last(), Some(b'\n' | b'\r')) {
            buf.pop();
        }
        if buf.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(&buf);
        let line = text.trim_start_matches('\u{feff}');
        if line.is_empty() {
            continue;
        }
        f(line);
    }
}

fn looks_like_json(line: &str) -> bool {
    matches!(line.trim_start().as_bytes().first(), Some(b'{') | Some(b'['))
}

fn forward_line(app: &AppHandle, id: &str, line: &str, is_stderr: bool) {
    let is_json = !is_stderr
        && looks_like_json(line)
        && serde_json::from_str::<serde::de::IgnoredAny>(line).is_ok();
    if is_json {
        emit_raw(app, id, line);
    } else {
        emit_raw(app, id, &json!({ "type": "stderr", "text": line }).to_string());
    }
}

/// `{"id": <id>, "event": <raw>}` built by concatenation: the CLI's own JSON is embedded, never
/// parsed and re-printed. `RawValue::from_string` validates the whole payload once.
fn emit_raw(app: &AppHandle, id: &str, raw_event: &str) {
    let id_json = serde_json::to_string(id).unwrap_or_else(|_| "\"\"".to_string());
    let payload = format!("{{\"id\":{id_json},\"event\":{raw_event}}}");
    match RawValue::from_string(payload) {
        Ok(v) => {
            let _ = app.emit("claude", v);
        }
        Err(e) => eprintln!("claude event dropped ({e})"),
    }
}

/// Polls instead of blocking in `wait()` so the mutex is never held across a wait and
/// `claudeStop` can always get at the child.
fn wait_for_exit(child: &Mutex<Child>, timeout: Duration) -> i32 {
    let deadline = Instant::now() + timeout;
    loop {
        {
            let mut c = lock(child);
            match c.try_wait() {
                Ok(Some(status)) => return status.code().unwrap_or(-1),
                Ok(None) => {}
                Err(_) => return -1,
            }
        }
        if Instant::now() >= deadline {
            return -1;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

// ---- writing --------------------------------------------------------------

fn write_line(ctx: &Ctx, id: &str, json_line: &str) -> Result<(), String> {
    let stdin = {
        let map = lock(&ctx.st.claude.map);
        let s = map
            .get(id)
            .ok_or_else(|| format!("no claude session {id}"))?;
        Arc::clone(&s.stdin)
    };
    let mut guard = lock(&stdin);
    let w = guard
        .as_mut()
        .ok_or_else(|| format!("claude session {id} has no stdin"))?;
    w.write_all(json_line.as_bytes())
        .and_then(|()| w.write_all(b"\n"))
        .and_then(|()| w.flush())
        .map_err(|e| format!("write to claude session {id} failed: {e}"))
}

fn send(ctx: &Ctx, id: &str, text: &str) -> Result<(), String> {
    let msg = json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    });
    write_line(ctx, id, &msg.to_string())
}

fn interrupt(ctx: &Ctx, id: &str) -> Result<(), String> {
    let msg = json!({
        "type": "control_request",
        "request_id": random_uuid(),
        "request": { "subtype": "interrupt" }
    });
    write_line(ctx, id, &msg.to_string())
}

// ---- stopping -------------------------------------------------------------

fn stop(ctx: &Ctx, id: &str) -> Result<(), String> {
    let removed = lock(&ctx.st.claude.map).remove(id);
    if let Some(s) = removed {
        log_line(ctx.st, &format!("claude stop {}", s.id));
        kill_session(&s);
    }
    Ok(())
}

/// Every session dies with the app.
pub fn kill_all(st: &AppState) {
    let sessions: Vec<Session> = {
        let mut map = lock(&st.claude.map);
        map.drain().map(|(_, s)| s).collect()
    };
    for s in &sessions {
        kill_session(s);
    }
}

fn kill_session(s: &Session) {
    kill_tree(s.pid);
    if let Ok(mut c) = s.child.try_lock() {
        let _ = c.kill();
    }
    if let Ok(mut g) = s.stdin.try_lock() {
        g.take();
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = platform::quiet_command("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    // The child was put in its own process group, so the negative pid kills the whole tree.
    let _ = Command::new("kill")
        .args(["-TERM", "--", &format!("-{pid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

// ---- transcripts ----------------------------------------------------------

/// The session log Claude Code keeps at `~/.claude/projects/<encoded root>/<id>.jsonl`.
/// The `user` and `assistant` entries in file order; a missing or unreadable file is an empty
/// array, never an error.
fn transcript(ctx: &Ctx, session_id: &str) -> Value {
    let id = session_id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Value::Array(Vec::new());
    }
    let file = platform::transcript_dir(&ctx.st.root).join(format!("{id}.jsonl"));
    let f = match std::fs::File::open(&file) {
        Ok(f) => f,
        Err(_) => return Value::Array(Vec::new()),
    };
    let mut out: Vec<Value> = Vec::new();
    read_lines(f, |line| {
        if !looks_like_json(line) {
            return;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            let keep = v
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|t| t == "user" || t == "assistant");
            if keep {
                out.push(v);
            }
        }
    });
    Value::Array(out)
}

// ---- ids ------------------------------------------------------------------

fn splitmix64(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Local ids only: a counter, the clock and a stack address, mixed. No crate needed and
/// nothing here is a secret.
fn seed() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let addr = std::ptr::addr_of!(n) as usize as u64;
    splitmix64(now ^ splitmix64(n ^ addr))
}

fn random_hex(n: usize) -> String {
    let mut x = seed();
    let mut s = String::with_capacity(n + 16);
    while s.len() < n {
        x = splitmix64(x);
        s.push_str(&format!("{x:016x}"));
    }
    s.truncate(n);
    s
}

fn random_uuid() -> String {
    let h = random_hex(32);
    format!(
        "{}-{}-4{}-a{}-{}",
        &h[0..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_shaped_and_unique() {
        assert_eq!(random_hex(12).len(), 12);
        assert_ne!(random_hex(12), random_hex(12));
        let u = random_uuid();
        assert_eq!(u.len(), 36);
        assert_eq!(u.match_indices('-').count(), 4);
    }

    #[test]
    fn json_detection() {
        assert!(looks_like_json("{\"type\":\"x\"}"));
        assert!(looks_like_json("  [1]"));
        assert!(!looks_like_json("Error: nope"));
    }
}
