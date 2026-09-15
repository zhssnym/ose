//! `run`: starting a program from the vault, with its output streamed back line by line.
//!
//! This is the one hose that reaches outside the editor, so every part of it is narrow on
//! purpose. There is no shell: `cmd` is a program name looked up on PATH, or a vault-relative
//! path to a file inside the vault, and `args` is a list that is passed through untouched — so
//! nothing a person typed into a page can ever be re-parsed as a command line. A program may
//! only start when its name is in the caller's own allow list (a module's `module.json` `run`)
//! or in `settings.run.allow`, which is empty until the user puts something in it.
//!
//! Output is UTF-8 by construction: the child is given `PYTHONUTF8=1`,
//! `PYTHONIOENCODING=utf-8`, `LANG=C.UTF-8` and `LC_ALL=C.UTF-8` under whatever the caller
//! asked for, so `print('é')` comes back as `é` and not as two bytes of mojibake.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Emitter as _;

use crate::{arg_str, log_line, platform::quiet_command, state, vault, AppState, Ctx};

/// The default a caller gets when it names no timeout. Long enough for a judge or a formatter,
/// short enough that a wedged process cannot sit there for the afternoon.
const DEFAULT_TIMEOUT_MS: i64 = 60_000;
/// How often the waiter looks at the child. `wait()` would block the kill path, and a process
/// runner does not need millisecond resolution.
const POLL: Duration = Duration::from_millis(25);

/// The UTF-8 floor every child gets, under anything the caller passes in `env`.
const UTF8_ENV: &[(&str, &str)] = &[
    ("PYTHONUTF8", "1"),
    ("PYTHONIOENCODING", "utf-8"),
    ("LANG", "C.UTF-8"),
    ("LC_ALL", "C.UTF-8"),
];

/// Extensions that are part of a program's name on Windows and not part of what a caller means
/// when it allows "python".
const PROGRAM_EXTS: &[&str] = &["exe", "bat", "cmd", "com"];

// ---- the table of live processes -------------------------------------------

struct Entry {
    child: Arc<Mutex<Child>>,
    /// Set by `runKill` or by the timeout, so the `done` event can say which it was.
    timed_out: Arc<AtomicBool>,
}

/// Every process this host started, by the caller's id. Lives on `AppState`.
#[derive(Default)]
pub struct Processes(Mutex<HashMap<String, Entry>>);

impl Processes {
    fn insert(&self, id: String, entry: Entry) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).insert(id, entry);
    }

    fn remove(&self, id: &str) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
    }

    fn has(&self, id: &str) -> bool {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).contains_key(id)
    }

    /// Kills one. `timed_out` marks it as the timeout rather than a `runKill`.
    fn kill(&self, id: &str, timed_out: bool) -> bool {
        let map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(entry) = map.get(id) else { return false };
        entry.timed_out.store(timed_out, Ordering::Release);
        let _ = entry.child.lock().unwrap_or_else(|p| p.into_inner()).kill();
        true
    }

    /// Kills all of them: the app is exiting, or the vault changed under everything.
    pub fn kill_all(&self) -> usize {
        let map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        for entry in map.values() {
            let _ = entry.child.lock().unwrap_or_else(|p| p.into_inner()).kill();
        }
        map.len()
    }
}

/// Kills every process this host started. The window is gone, or the vault has changed: a
/// module's judge must not outlive the thing that asked for it.
pub fn kill_all(st: &AppState) {
    let n = st.processes.kill_all();
    if n > 0 {
        log_line(st, &format!("run: killed {n} running process(es)"));
    }
}

// ---- the allow rule --------------------------------------------------------

/// The name a caller means when it allows a program: the file name, without a directory and
/// without a Windows program extension. `tools/python.exe` and `python` are the same key;
/// `python3` is not.
pub fn program_key(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let stem = match base.rsplit_once('.') {
        Some((head, ext)) if !head.is_empty() && PROGRAM_EXTS.contains(&ext.to_ascii_lowercase().as_str()) => head,
        _ => base,
    };
    if cfg!(windows) {
        stem.to_ascii_lowercase()
    } else {
        stem.to_string()
    }
}

/// `settings.run.allow` in `.ose/state.json`: the programs the rice itself may start. Default
/// empty — until the user says otherwise, Ose runs nothing.
fn settings_allow(st: &AppState) -> Vec<String> {
    let Some(root) = st.root() else { return Vec::new() };
    state::get(&root)
        .get("settings")
        .and_then(|s| s.get("run"))
        .and_then(|r| r.get("allow"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(program_key).collect())
        .unwrap_or_default()
}

fn allowed(st: &AppState, cmd: &str, per_call: &[String]) -> bool {
    let key = program_key(cmd);
    per_call.iter().any(|a| program_key(a) == key) || settings_allow(st).contains(&key)
}

// ---- rpc -------------------------------------------------------------------

pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    match cmd {
        "run" => Some(start(ctx, args)),
        "runKill" => Some(kill_one(ctx, args)),
        _ => None,
    }
}

fn kill_one(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    let id = arg_str(args, 0)?;
    Ok(Value::Bool(ctx.st.processes.kill(&id, false)))
}

/// `run(id, cmd, args, opts)`. Resolves once the process is running; everything after that
/// arrives as the `run` event.
fn start(ctx: &Ctx, rpc_args: &[Value]) -> Result<Value, String> {
    let id = arg_str(rpc_args, 0)?;
    if id.trim().is_empty() {
        return Err("run needs an id".to_string());
    }
    if ctx.st.processes.has(&id) {
        return Err(format!("run id in use: {id}"));
    }
    let program = arg_str(rpc_args, 1)?;
    let argv = string_list(rpc_args.get(2)).ok_or("run: args must be a list of strings")?;
    let opts = rpc_args.get(3).cloned().unwrap_or(Value::Null);

    let per_call = opts
        .get("allow")
        .and_then(Value::as_array)
        .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    if !allowed(ctx.st, &program, &per_call) {
        return Err(format!("not allowed: {program}"));
    }

    let root = ctx.st.root();
    let exe = resolve_program(root.as_deref(), &program)?;
    let cwd = match opts.get("cwd").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        Some(rel) => {
            let root = root.clone().ok_or(crate::NO_VAULT)?;
            let dir = vault::resolve(&root, rel)?;
            if !dir.is_dir() {
                return Err(format!("no such folder: {rel}"));
            }
            Some(dir)
        }
        None => root.clone(),
    };

    let timeout_ms = opts.get("timeout").and_then(Value::as_i64).unwrap_or(DEFAULT_TIMEOUT_MS);
    let timeout = Duration::from_millis(if timeout_ms > 0 { timeout_ms as u64 } else { DEFAULT_TIMEOUT_MS as u64 });
    let input = opts.get("input").and_then(Value::as_str).map(str::to_string);

    let mut command = quiet_command(&exe);
    command.args(&argv);
    if let Some(dir) = &cwd {
        command.current_dir(dir);
    }
    for (k, v) in UTF8_ENV {
        command.env(k, v);
    }
    // The caller's own environment last, so a module can override the floor deliberately. A
    // null value removes the variable rather than setting it to "null".
    if let Some(env) = opts.get("env").and_then(Value::as_object) {
        for (k, v) in env {
            match v {
                Value::Null => command.env_remove(k),
                Value::String(s) => command.env(k, s),
                other => command.env(k, other.to_string()),
            };
        }
    }
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("cannot start {program}: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    let shared = Arc::new(Mutex::new(child));
    let timed_out = Arc::new(AtomicBool::new(false));
    ctx.st.processes.insert(
        id.clone(),
        Entry { child: shared.clone(), timed_out: timed_out.clone() },
    );
    log_line(
        ctx.st,
        &format!("run {id}: {} {} (pid {pid}{})", exe.display(), argv.join(" "), cwd.as_ref().map(|d| format!(", cwd {}", d.display())).unwrap_or_default()),
    );

    // stdin is written and then closed, always: a child reading until EOF must not wait for a
    // caller that passed nothing.
    if let Some(mut pipe) = stdin {
        let text = input.unwrap_or_default();
        std::thread::spawn(move || {
            let _ = pipe.write_all(text.as_bytes());
            let _ = pipe.flush();
            // dropping `pipe` closes the handle
        });
    }

    let out_reader = stdout.map(|s| stream(ctx.app.clone(), id.clone(), "stdout", s));
    let err_reader = stderr.map(|s| stream(ctx.app.clone(), id.clone(), "stderr", s));

    let app = ctx.app.clone();
    let waiter_id = id.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let status = loop {
            let finished = shared
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .try_wait()
                .unwrap_or(None);
            if let Some(status) = finished {
                break Some(status);
            }
            if started.elapsed() >= timeout && !timed_out.load(Ordering::Acquire) {
                timed_out.store(true, Ordering::Release);
                let _ = shared.lock().unwrap_or_else(|p| p.into_inner()).kill();
            }
            std::thread::sleep(POLL);
        };
        // Every line before `done`: the readers stop at EOF, which the kill above guarantees.
        if let Some(h) = out_reader {
            let _ = h.join();
        }
        if let Some(h) = err_reader {
            let _ = h.join();
        }
        let code = status.and_then(|s| s.code());
        let payload = json!({
            "id": waiter_id,
            "done": true,
            "code": code,
            "timedOut": timed_out.load(Ordering::Acquire),
        });
        let st = tauri::Manager::state::<AppState>(&app);
        st.processes.remove(&waiter_id);
        let _ = app.emit("run", payload);
    });

    Ok(json!({ "id": id, "pid": pid }))
}

/// One pipe, one thread, one event per line. Decoding is lossy on purpose: a program that
/// writes Latin-1 gives replacement characters rather than killing the run.
fn stream<R: Read + Send + 'static>(
    app: tauri::AppHandle,
    id: String,
    name: &'static str,
    pipe: R,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                buf.pop();
            }
            let line = String::from_utf8_lossy(&buf).to_string();
            let _ = app.emit("run", json!({ "id": id, "stream": name, "line": line }));
        }
    })
}

/// A program name resolved on PATH, or a vault-relative path to a file inside the vault.
/// Never an absolute path from the page, and never a shell.
fn resolve_program(root: Option<&Path>, program: &str) -> Result<PathBuf, String> {
    let name = program.trim();
    if name.is_empty() {
        return Err("run needs a program".to_string());
    }
    let looks_like_path = name.contains('/') || name.contains('\\');
    if !looks_like_path {
        // A bare name: `Command` asks the OS to look it up on PATH, which is what a caller
        // writing "python" means. A name with a drive letter or a NUL is not a bare name.
        if name.contains(':') || name.contains('\0') {
            return Err(format!("not a program name: {program}"));
        }
        return Ok(PathBuf::from(name));
    }
    let root = root.ok_or(crate::NO_VAULT)?;
    let full = vault::resolve(root, name)?;
    if !full.is_file() {
        return Err(format!("no such program in the vault: {program}"));
    }
    Ok(full)
}

fn string_list(v: Option<&Value>) -> Option<Vec<String>> {
    match v {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::Array(list)) => list
            .iter()
            .map(|a| a.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_key_is_the_bare_name() {
        assert_eq!(program_key("python"), "python");
        assert_eq!(program_key("tools/judge/python.exe"), "python");
        assert_eq!(program_key("tools\\python.EXE"), "python");
        // A version in the name is part of the name.
        assert_eq!(program_key("python3"), "python3");
        assert_eq!(program_key("python3.11"), "python3.11");
        // Not a program extension: nothing is stripped.
        assert_eq!(program_key("run.sh"), "run.sh");
        assert_eq!(program_key(".hidden"), ".hidden");
    }

    #[test]
    fn a_path_outside_the_vault_is_refused() {
        let root = std::env::temp_dir();
        assert!(resolve_program(Some(&root), "../python").is_err());
        assert!(resolve_program(Some(&root), "tools/nothing-here").is_err());
        // A bare name is never resolved against the disk; PATH answers it at spawn time.
        assert_eq!(resolve_program(Some(&root), "python").unwrap(), PathBuf::from("python"));
        assert!(resolve_program(Some(&root), "C:/Windows/System32/cmd.exe").is_err());
    }

    #[test]
    fn args_must_be_strings() {
        assert_eq!(string_list(None).unwrap().len(), 0);
        assert_eq!(string_list(Some(&json!(["a", "b"]))).unwrap(), ["a", "b"]);
        assert!(string_list(Some(&json!(["a", 2]))).is_none());
        assert!(string_list(Some(&json!("a"))).is_none());
    }
}
