//! The Ose host. One `rpc` command carries the whole bridge surface (docs/HOST.md "RPC");
//! window control is done by the adapter through Tauri's own window API and never reaches here.
//!
//! Each file below exposes `handle(ctx, cmd, args) -> Option<Result<Value, String>>`, where
//! `None` means "not mine", and `rpc` tries them in order. A name none of them claims is an
//! error, `[unknown_command] <cmd>`; only the names a past version retired still answer `null`
//! (`gone`).
//!
//! Every error a command sends back is a string of the form `[code] message` (docs/HOST.md
//! "Errors"), so the page can tell "the file is gone" from "the disk said no" without reading
//! prose.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub mod args;
pub mod drafts;
pub mod files;
pub mod hide;
pub mod local;
pub mod platform;
pub mod print;
pub mod protocol;
pub mod shell;
pub mod state;
pub mod trashbin;
pub mod vault;
pub mod vaults;
pub mod versions;
pub mod watcher;

/// The error every command that touches files returns while no vault is open.
pub const NO_VAULT: &str = "[no_vault] no vault is open";

/// `[code] message`: the one shape of every error a command answers (docs/HOST.md "Errors").
pub fn coded(code: &str, message: impl std::fmt::Display) -> String {
    format!("[{code}] {message}")
}

/// An I/O error on the vault path `rel`, with the code the page can act on: a missing file is
/// `not_found`, everything else is `io`.
pub fn io_error(rel: &str, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => coded("not_found", format!("{rel}: {e}")),
        _ => coded("io", format!("{rel}: {e}")),
    }
}

/// An error string that already carries a code keeps it; a bare one becomes `[io]`.
pub fn with_code(e: String) -> String {
    if e.starts_with('[') {
        e
    } else {
        coded("io", e)
    }
}

/// Where the open root came from, for `vaultInfo` and the log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// `--root <dir>`
    Arg,
    /// an ancestor of the executable that holds `.ose/` or `CLAUDE.md`
    Exe,
    /// `OSE_ROOT`
    Env,
    /// the `vault` file in the per-user app config folder
    Remembered,
    /// chosen in the native folder picker during this run
    Picked,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Arg => "arg",
            Source::Exe => "exe",
            Source::Env => "env",
            Source::Remembered => "remembered",
            Source::Picked => "picked",
        }
    }
}

/// The open vault: its absolute, normalised path and where it came from.
#[derive(Clone, Debug)]
pub struct Root {
    pub path: PathBuf,
    pub source: Source,
}

/// The native folder picker, supplied by the binary (main.rs) and called by `pickVault`:
/// `start` is the folder to open in, `done` receives the choice, `None` on cancel. The dialog
/// plugin is used in the binary only: on Windows its `rfd` backend imports `TaskDialogIndirect`,
/// which exists only in the Common Controls v6 comctl32 that an application manifest opts
/// into, and tauri-build embeds that manifest in bin targets alone. Keeping the plugin out of
/// the library keeps the library's test harness loadable.
pub type FolderPicker =
    fn(app: &tauri::AppHandle, start: Option<PathBuf>, done: Box<dyn FnOnce(Option<PathBuf>) + Send>);

/// The native save dialog behind `printToPdf`, supplied by the binary for the same reason as
/// the folder picker above: `start` is the folder to open in, `name` the file name to offer,
/// `done` receives the choice and `None` on cancel.
pub type FileSaver = fn(
    app: &tauri::AppHandle,
    start: Option<PathBuf>,
    name: String,
    done: Box<dyn FnOnce(Option<PathBuf>) + Send>,
);

/// Everything the host owns, managed by Tauri and reachable from any command or thread.
///
/// The root is optional: the app starts without one and lets the shell ask (docs/HOST.md
/// "The vault root"). It is read through `root()` / `require_root()` at call time, never
/// cached by a caller, so `pickVault` changing it is seen by the next command and by the
/// `vault` protocol alike.
pub struct AppState {
    root: RwLock<Option<Root>>,
    /// Which vault the page is talking about (docs/HOST.md "Epoch"). 1 at startup, one more on
    /// every `adopt`. A mutating command that names another epoch is refused with
    /// `[stale_vault]`, so the last save of a page from the vault that was just left can never
    /// land in the one that replaced it.
    epoch: AtomicU64,
    /// The per-machine app data folder (drafts live under it), set in `setup` once the app
    /// knows it. `None` in tests that do not set one, and on a platform without one.
    data_dir: RwLock<Option<PathBuf>>,
    /// The per-user app config folder: the remembered root, the recent vaults and the
    /// per-machine local store live under it (local.rs). Set in `setup`; `None` in tests.
    config_dir: RwLock<Option<PathBuf>>,
    pub log: Option<Mutex<File>>,
    pub watcher: Mutex<Option<watcher::Handle>>,
    pub picker: Option<FolderPicker>,
    pub saver: Option<FileSaver>,
    /// `--shell <dir>`, settled once at startup (shell.rs).
    shell: shell::Slot,
}

impl AppState {
    pub fn new(
        root: Option<Root>,
        log: Option<File>,
        picker: Option<FolderPicker>,
        saver: Option<FileSaver>,
    ) -> Self {
        crate::hide::set_root(root.as_ref().map(|r| r.path.as_path()));
        Self {
            root: RwLock::new(root),
            epoch: AtomicU64::new(1),
            data_dir: RwLock::new(None),
            config_dir: RwLock::new(None),
            log: log.map(Mutex::new),
            watcher: Mutex::new(None),
            picker,
            saver,
            shell: shell::slot(shell::Options::default()),
        }
    }

    /// `--shell`, as the binary parsed it.
    pub fn shell_options(&self) -> shell::Options {
        self.shell.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_shell_options(&self, options: shell::Options) {
        *self.shell.write().unwrap_or_else(|p| p.into_inner()) = options;
    }

    /// The open root's path, if any.
    pub fn root(&self) -> Option<PathBuf> {
        self.root_info().map(|r| r.path)
    }

    /// The open root with its source, if any.
    pub fn root_info(&self) -> Option<Root> {
        self.root
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// The open root, or the one error every file command shares.
    pub fn require_root(&self) -> Result<PathBuf, String> {
        self.root().ok_or_else(|| NO_VAULT.to_string())
    }

    /// The open root, for a command that said which epoch it belongs to. `None` is a caller that
    /// did not say (every read, and an old page), and is let through. The root and the epoch are
    /// read under one lock, so a command can never pair the new root with the old epoch.
    pub fn require_root_at(&self, epoch: Option<u64>) -> Result<PathBuf, String> {
        let guard = self.root.read().unwrap_or_else(|p| p.into_inner());
        if let Some(asked) = epoch {
            let now = self.epoch.load(Ordering::SeqCst);
            if asked != now {
                return Err(coded(
                    "stale_vault",
                    format!("this page belongs to vault epoch {asked}, the open vault is epoch {now}"),
                ));
            }
        }
        guard.as_ref().map(|r| r.path.clone()).ok_or_else(|| NO_VAULT.to_string())
    }

    /// The current epoch (docs/HOST.md "Epoch").
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// The root found at startup (the remembered one): the page has not seen any other yet, so
    /// the epoch stays where it is.
    pub fn set_root(&self, path: PathBuf, source: Source) {
        crate::hide::set_root(Some(&path));
        *self.root.write().unwrap_or_else(|p| p.into_inner()) = Some(Root { path, source });
    }

    /// A vault adopted while the app runs: the root changes and the epoch goes up by one, both
    /// under the write lock.
    pub fn adopt_root(&self, path: PathBuf, source: Source) -> u64 {
        let mut guard = self.root.write().unwrap_or_else(|p| p.into_inner());
        let next = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        crate::hide::set_root(Some(&path));
        *guard = Some(Root { path, source });
        next
    }

    /// The per-machine app data folder, when the app has told us.
    pub fn data_dir(&self) -> Option<PathBuf> {
        self.data_dir.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_data_dir(&self, dir: PathBuf) {
        *self.data_dir.write().unwrap_or_else(|p| p.into_inner()) = Some(dir);
    }

    /// The per-user app config folder, when the app has told us.
    pub fn config_dir(&self) -> Option<PathBuf> {
        self.config_dir.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_config_dir(&self, dir: PathBuf) {
        *self.config_dir.write().unwrap_or_else(|p| p.into_inner()) = Some(dir);
    }

    /// (Re)starts the watcher on `root`. Dropping the previous handle stops its thread.
    pub fn watch(&self, app: &tauri::AppHandle, root: PathBuf) {
        let started = watcher::start(app.clone(), root);
        *self.watcher.lock().unwrap_or_else(|p| p.into_inner()) = Some(started);
    }
}

/// What a module handler gets: the app (for events) and the state (for the root).
pub struct Ctx<'a> {
    pub app: &'a tauri::AppHandle,
    pub st: &'a AppState,
}

// ---- the log ---------------------------------------------------------------

/// How much a line matters. The persistent log keeps every level; the page picks one for its
/// own lines (`log(text, level)`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug => "debug",
        }
    }

    /// The page's word for a level; anything else is `info`.
    pub fn parse(s: &str) -> Level {
        match s.trim().to_ascii_lowercase().as_str() {
            "error" | "err" => Level::Error,
            "warn" | "warning" => Level::Warn,
            "debug" | "trace" => Level::Debug,
            _ => Level::Info,
        }
    }
}

/// One timestamped line into every log there is: the persistent one in the app's log folder
/// (M54: it exists in every build, without a flag), the `--log` file when one was named, and
/// stderr for a console build and CI. Never fails: logging must not break a command.
pub fn log_line(st: &AppState, s: &str) {
    log_at(st, Level::Info, s);
}

/// `log_line` at a chosen level.
pub fn log_at(st: &AppState, level: Level, s: &str) {
    let line = format!("{} {} {}\n", stamp(), level.as_str(), s);
    persist(&line);
    to_flag_log(st, &line);
}

/// A line for the `--log` file and stderr only: the name of every rpc, which is what a person
/// debugging with `--log` wants and what would drown the persistent log in noise.
pub fn trace_line(st: &AppState, s: &str) {
    let line = format!("{} debug {}\n", stamp(), s);
    to_flag_log(st, &line);
}

fn to_flag_log(st: &AppState, line: &str) {
    eprint!("{line}");
    let Some(file) = &st.log else { return };
    // A poisoned log mutex still holds a usable File; a panic while logging must not
    // silence every later line.
    let mut guard = match file.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let _ = guard.write_all(line.as_bytes());
    let _ = guard.flush();
}

/// Rotated at this size, keeping `ose.log`, `ose.1.log` and `ose.2.log`.
const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
const LOG_KEEP: usize = 3;
/// Lines written before the log folder is known (the first lines of `main`) wait here, and are
/// written first once it is. Capped, so a log that never opens cannot grow memory.
const LOG_EARLY_CAP: usize = 500;

struct Persistent {
    dir: PathBuf,
    file: Option<File>,
    size: u64,
}

impl Persistent {
    fn path(&self, n: usize) -> PathBuf {
        if n == 0 {
            self.dir.join("ose.log")
        } else {
            self.dir.join(format!("ose.{n}.log"))
        }
    }

    fn open(&mut self) {
        let path = self.path(0);
        self.file = std::fs::OpenOptions::new().create(true).append(true).open(&path).ok();
        self.size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    }

    fn rotate(&mut self) {
        self.file = None;
        let _ = std::fs::remove_file(self.path(LOG_KEEP - 1));
        for n in (0..LOG_KEEP - 1).rev() {
            let _ = std::fs::rename(self.path(n), self.path(n + 1));
        }
        self.open();
    }

    fn write(&mut self, line: &str) {
        if self.size + line.len() as u64 > LOG_MAX_BYTES {
            self.rotate();
        }
        if let Some(f) = &mut self.file {
            if f.write_all(line.as_bytes()).is_ok() {
                self.size += line.len() as u64;
            }
        }
    }
}

enum LogSink {
    Early(Vec<String>),
    Open(Persistent),
}

fn sink() -> &'static Mutex<LogSink> {
    static SINK: OnceLock<Mutex<LogSink>> = OnceLock::new();
    SINK.get_or_init(|| Mutex::new(LogSink::Early(Vec::new())))
}

fn persist(line: &str) {
    let mut guard = sink().lock().unwrap_or_else(|p| p.into_inner());
    match &mut *guard {
        LogSink::Early(lines) => {
            if lines.len() < LOG_EARLY_CAP {
                lines.push(line.to_string());
            }
        }
        LogSink::Open(p) => p.write(line),
    }
}

/// Opens `<dir>/ose.log` (created with its folder), writes what was logged before it existed,
/// and keeps every later line there. Answers the file's path, which `platform` reports.
pub fn open_persistent_log(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut p = Persistent { dir: dir.to_path_buf(), file: None, size: 0 };
    p.open();
    if p.file.is_none() {
        return Err(format!("cannot open {}", p.path(0).display()));
    }
    let path = p.path(0);
    let mut guard = sink().lock().unwrap_or_else(|p| p.into_inner());
    if let LogSink::Early(lines) = &*guard {
        for line in lines {
            p.write(line);
        }
    }
    *guard = LogSink::Open(p);
    Ok(path)
}

/// The persistent log's path, or `None` before it is open.
pub fn persistent_log_path() -> Option<PathBuf> {
    let guard = sink().lock().unwrap_or_else(|p| p.into_inner());
    match &*guard {
        LogSink::Open(p) => Some(p.path(0)),
        LogSink::Early(_) => None,
    }
}

/// The `log` crate's records (Tauri's, notify's, the webview's) into the same persistent log,
/// warnings and errors only. One of them is also a signal: notify's Windows backend reports a
/// dead `ReadDirectoryChangesW` (a buffer overflow during a checkout, a network hiccup) with a
/// `log::error!` and nothing else, and then stops watching for good (H9). The watcher reads
/// that flag and restarts, telling the page to re-read.
struct Records;

impl log::Log for Records {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        meta.level() <= log::Level::Warn
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let level = match record.level() {
            log::Level::Error => Level::Error,
            _ => Level::Warn,
        };
        if record.level() == log::Level::Error && record.target().starts_with("notify") {
            watcher::fault();
        }
        let line = format!("{} {} {}: {}\n", stamp(), level.as_str(), record.target(), record.args());
        eprint!("{line}");
        persist(&line);
    }

    fn flush(&self) {}
}

/// Installs `Records` as the process's `log` logger. Called once, first thing in `main`.
pub fn install_log_records() {
    static RECORDS: Records = Records;
    if log::set_logger(&RECORDS).is_ok() {
        log::set_max_level(log::LevelFilter::Warn);
    }
}

/// `2026-09-06 18:42:01.037`, UTC. Enough to correlate lines in a log; no date crate needed.
fn stamp() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let (secs, milli) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}.{milli:03}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days since the Unix epoch to a civil date (Howard Hinnant's algorithm). The log stamp above
/// and `versions.rs`'s version ids are the two callers; there is one copy of it in the crate.
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Tauri's `#[command]` on a `pub` fn exports a helper macro to the crate root; a command defined
/// at the root therefore collides with its own macro (E0255). Commands live in a submodule.
pub mod commands {
    use super::*;
    use tauri::Manager as _;

    /// The whole bridge. `cmd` is the bridge method name in camelCase; errors are
    /// `[code] message` strings (docs/HOST.md "Errors").
    #[tauri::command]
    pub async fn rpc(
        app: tauri::AppHandle,
        app_state: tauri::State<'_, AppState>,
        cmd: String,
        args: Vec<Value>,
    ) -> Result<Value, String> {
        let st = app_state.inner();
        let ctx = Ctx { app: &app, st };

        // `log` is the UI writing into the host log; it has no module of its own. The page
        // names a level (`error`, `warn`, `info`, `debug`) and its window errors arrive here.
        if cmd == "log" {
            let text = args
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let level = Level::parse(args.get(1).and_then(Value::as_str).unwrap_or("info"));
            log_at(st, level, &format!("ui: {text}"));
            return Ok(Value::Null);
        }

        trace_line(st, &format!("rpc {cmd}"));

        // Quitting goes through the window's close path, never around it: `close()` raises
        // CloseRequested, the adapter holds it open until the editor's last save has settled,
        // and only then destroys the window (S16). Cmd+Q and Ctrl+Q therefore save like the
        // close button does.
        if cmd == "quit" {
            return match app.get_webview_window("main") {
                Some(w) => {
                    log_line(st, "quit requested by the UI");
                    w.close().map(|_| Value::Null).map_err(|e| coded("io", e))
                }
                None => {
                    app.exit(0);
                    Ok(Value::Null)
                }
            };
        }

        // The two commands that wait: the save dialog waits on the user and `PrintToPdf` waits
        // on the webview, so `printToPdf` is awaited here rather than dispatched through the
        // synchronous module handlers. Its other half, `showPrintUI`, returns at once and goes
        // through print.rs's `handle` below.
        if cmd == "printToPdf" {
            let r = print::to_pdf(&ctx, &args).await;
            return log_err(st, &cmd, r);
        }

        // The folder picker is the one command that waits on the user, so it is awaited here
        // rather than dispatched through the synchronous module handlers. `{adopt:false}` only
        // chooses: the page leaves the old vault first (saving into it) and opens the new one
        // afterwards with `openVault`, which records it then.
        if cmd == "pickVault" {
            let adopt = args
                .first()
                .and_then(Value::as_object)
                .and_then(|o| o.get("adopt"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let r = vault::pick_vault(&ctx, adopt).await;
            // A vault the user chose is a vault they may want back: the recent list is written
            // here, where both the picker and `openVault` pass through.
            if adopt {
                if let Ok(Value::Object(o)) = &r {
                    if let Some(p) = o.get("root").and_then(Value::as_str) {
                        if let Err(e) = vaults::record(&app, std::path::Path::new(p)) {
                            log_line(st, &format!("recent vaults: {e}"));
                        }
                    }
                }
            }
            return log_err(st, &cmd, r);
        }

        // Before vault.rs: the recent list owns `recentVaults`, `openVault` and the
        // one-argument `forgetVault`; the no-argument one falls through to vault.rs.
        if let Some(r) = vaults::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }

        // `search` walks every file in the vault, `tree` reads every directory and `copyPath`
        // may copy a whole folder: synchronous all three, and on a big vault any of them would
        // hold a tokio worker for its whole length. The trash goes through COM on Windows, and
        // a listing of the system bin takes a moment. Each runs on a blocking worker and is
        // awaited here; a mutating one that names a stale epoch is refused before it starts.
        // Everything else in vault.rs touches one path and stays inline.
        let blocking_vault = vault::BLOCKING.contains(&cmd.as_str());
        if blocking_vault || trashbin::COMMANDS.contains(&cmd.as_str()) {
            let root = match root_for(st, &cmd, &args) {
                Ok(r) => r,
                Err(e) => return log_err(st, &cmd, Err(e)),
            };
            let (c, a) = (cmd.clone(), args.clone());
            let r = tauri::async_runtime::spawn_blocking(move || {
                if blocking_vault {
                    vault::dispatch(&root, &c, &a)
                } else {
                    trashbin::dispatch(&root, &c, &a)
                }
            })
            .await
            .unwrap_or_else(|e| Err(coded("io", format!("{cmd} worker failed: {e}"))));
            return log_err(st, &cmd, r);
        }

        if let Some(r) = vault::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = files::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = drafts::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = state::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = local::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = shell::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = versions::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = platform::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = print::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        gone(st, &cmd)
    }

    /// The names 1.0.0 took away: `riceInfo`, `riceReady` and `riceFailed` (0.5.0 command
    /// names) and every `update*`. A page that still calls one has not caught up yet and is
    /// not broken, so it gets `null`, which every such caller already handles.
    pub fn retired(cmd: &str) -> bool {
        matches!(cmd, "riceInfo" | "riceReady" | "riceFailed") || cmd.starts_with("update")
    }

    /// A command this host does not implement. A retired name answers `null`, logged the first
    /// time it is asked for; any other name is `[unknown_command] <cmd>`, so a caller can never
    /// mistake "this host has no such command" for success (a `null` read as "saved" is how a
    /// page could lose text against an older host).
    fn gone(st: &AppState, cmd: &str) -> Result<Value, String> {
        static SAID: Mutex<Option<std::collections::BTreeSet<String>>> = Mutex::new(None);
        let mut guard = SAID.lock().unwrap_or_else(|p| p.into_inner());
        let seen = guard.get_or_insert_with(Default::default);
        let first = seen.insert(cmd.to_string());
        if retired(cmd) {
            if first {
                log_line(st, &format!("rpc {cmd}: this host has no such command any more, answering null"));
            }
            return Ok(Value::Null);
        }
        if first {
            log_at(st, Level::Warn, &format!("rpc {cmd}: no such command"));
        }
        Err(coded("unknown_command", cmd))
    }

    fn log_err(st: &AppState, cmd: &str, r: Result<Value, String>) -> Result<Value, String> {
        match r {
            Err(e) => {
                let e = with_code(e);
                log_at(st, Level::Warn, &format!("rpc {cmd} failed: {e}"));
                Err(e)
            }
            ok => ok,
        }
    }

    /// The `epoch` a mutating command carries in its trailing options object (docs/HOST.md
    /// "Epoch"), or `None` when it names none. One table, so a handler cannot forget where its
    /// options sit.
    pub fn epoch_of(cmd: &str, args: &[Value]) -> Option<u64> {
        let at = match cmd {
            "writeText" | "appendText" | "writeBinary" | "rename" | "saveFile" | "copyFile"
            | "copyPath" | "appendLine" | "draftWrite" | "versionRestore" | "localSet" => 2,
            // `versionKeep(path, text, opts)`: the legacy boolean `opts` is not an object, so it
            // names no epoch and is let through.
            "versionKeep" => 2,
            // `setState(state, opts?)` and `draftDrop(path, opts?)`: sent late from a page of the
            // vault that was just left, either would land in the new one.
            "mkdir" | "trash" | "trashRestore" | "setState" | "draftDrop" => 1,
            "replaceLine" => 4,
            // `createNew(path, text = '', opts?)`: the text may be left out.
            "createNew" => {
                if args.get(1).map(Value::is_object).unwrap_or(false) {
                    1
                } else {
                    2
                }
            }
            _ => return None,
        };
        let v = args.get(at)?.as_object()?.get("epoch")?;
        v.as_u64()
            .or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64))
    }

    /// The open root for `cmd`, refused with `[stale_vault]` when the command names an epoch
    /// that is no longer the open one.
    pub fn root_for(st: &AppState, cmd: &str, args: &[Value]) -> Result<PathBuf, String> {
        st.require_root_at(epoch_of(cmd, args))
    }

    // ---- argument helpers, shared by the module handlers -----------------------

    /// The .NET `Str(a, i)`: the argument must be a string.
    pub fn arg_str(args: &[Value], i: usize) -> Result<String, String> {
        match args.get(i) {
            Some(Value::String(s)) => Ok(s.clone()),
            _ => Err(coded("bad_arg", format!("argument {i} must be a string"))),
        }
    }

    /// The .NET `Str(a, i, fallback)`: anything that is not a string becomes the fallback.
    pub fn arg_str_or(args: &[Value], i: usize, fallback: &str) -> String {
        match args.get(i) {
            Some(Value::String(s)) => s.clone(),
            _ => fallback.to_string(),
        }
    }

    /// A string field of an options object argument, empty and blank treated as absent.
    pub fn opt_field_str(args: &[Value], i: usize, key: &str) -> Option<String> {
        args.get(i)?
            .as_object()?
            .get(key)?
            .as_str()
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
    }

    /// An integer field of an options object argument.
    pub fn opt_field_i64(args: &[Value], i: usize, key: &str, fallback: i64) -> i64 {
        args.get(i)
            .and_then(Value::as_object)
            .and_then(|o| o.get(key))
            .and_then(Value::as_i64)
            .unwrap_or(fallback)
    }
}

pub use commands::rpc;
pub use commands::{arg_str, arg_str_or, epoch_of, opt_field_i64, opt_field_str, root_for};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_000), (2022, 1, 8));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    /// `tauri.macos.conf.json` is merged into `tauri.conf.json` with RFC 7396, and RFC 7396
    /// replaces an array wholesale: a key added to the base window object and not repeated in
    /// the macOS one silently disappears on macOS. That is how `dragDropEnabled: false` was
    /// lost, and how every drop and drag-to-move on a Mac stopped working (S17/S49). The two
    /// files carry no comments — tauri parses them as strict JSON — so the rule is a test:
    /// every key of the base window must appear in the macOS window.
    #[test]
    fn the_macos_window_mirrors_every_key_of_the_base_window() {
        const BASE: &str = include_str!("../tauri.conf.json");
        const MAC: &str = include_str!("../tauri.macos.conf.json");
        let window = |text: &str| -> serde_json::Map<String, Value> {
            serde_json::from_str::<Value>(text).expect("config is valid JSON")["app"]["windows"][0]
                .as_object()
                .expect("one window object")
                .clone()
        };
        let (base, mac) = (window(BASE), window(MAC));
        let missing: Vec<&String> = base.keys().filter(|k| !mac.contains_key(*k)).collect();
        assert!(
            missing.is_empty(),
            "tauri.macos.conf.json must repeat every window key of tauri.conf.json; missing: {missing:?}"
        );
        // The one that matters most, spelled out so a future merge cannot quietly drop it.
        assert_eq!(mac.get("dragDropEnabled"), Some(&Value::Bool(false)));
    }

    /// A write from a page of the vault that was just left is refused, never landed in the new
    /// one (docs/HOST.md "Epoch").
    #[test]
    fn a_stale_epoch_is_refused() {
        let st = AppState::new(
            Some(Root { path: PathBuf::from("/one"), source: Source::Arg }),
            None,
            None,
            None,
        );
        assert_eq!(st.epoch(), 1);
        assert_eq!(st.require_root_at(Some(1)).unwrap(), PathBuf::from("/one"));
        assert_eq!(st.adopt_root(PathBuf::from("/two"), Source::Picked), 2);
        let e = st.require_root_at(Some(1)).unwrap_err();
        assert!(e.starts_with("[stale_vault]"), "{e}");
        assert_eq!(st.require_root_at(Some(2)).unwrap(), PathBuf::from("/two"));
        // A caller that names no epoch (a read, an old page) is let through.
        assert_eq!(st.require_root_at(None).unwrap(), PathBuf::from("/two"));

        // Where each command carries it.
        let o = serde_json::json!({ "epoch": 1 });
        assert_eq!(epoch_of("saveFile", &[Value::from("a"), Value::from("t"), o.clone()]), Some(1));
        assert_eq!(epoch_of("trash", &[Value::from("a"), o.clone()]), Some(1));
        assert_eq!(epoch_of("createNew", &[Value::from("a"), o.clone()]), Some(1));
        assert_eq!(epoch_of("createNew", &[Value::from("a"), Value::from(""), o.clone()]), Some(1));
        assert_eq!(
            epoch_of("replaceLine", &[Value::from("a"), Value::from(0), Value::from("x"), Value::from("y"), o.clone()]),
            Some(1)
        );
        assert_eq!(epoch_of("setState", &[serde_json::json!({}), o.clone()]), Some(1));
        assert_eq!(epoch_of("draftDrop", &[Value::from("a"), o.clone()]), Some(1));
        assert_eq!(epoch_of("copyPath", &[Value::from("a"), Value::from("b"), o.clone()]), Some(1));
        assert_eq!(epoch_of("trashRestore", &[serde_json::json!(["vault:x"]), o.clone()]), Some(1));
        assert_eq!(epoch_of("localSet", &[Value::from("vault"), serde_json::json!({}), o.clone()]), Some(1));
        assert_eq!(epoch_of("localGet", &[Value::from("vault"), o.clone()]), None);
        assert_eq!(epoch_of("versionKeep", &[Value::from("a"), Value::from("t"), o.clone()]), Some(1));
        assert_eq!(epoch_of("versionKeep", &[Value::from("a"), Value::from("t"), Value::from(true)]), None);
        assert_eq!(epoch_of("setState", &[serde_json::json!({})]), None);
        assert_eq!(epoch_of("readFile", &[Value::from("a"), o]), None);
    }

    #[test]
    fn a_page_level_is_parsed_and_defaults_to_info() {
        assert_eq!(Level::parse("error"), Level::Error);
        assert_eq!(Level::parse("WARN"), Level::Warn);
        assert_eq!(Level::parse("debug"), Level::Debug);
        assert_eq!(Level::parse("loud"), Level::Info);
    }

    #[test]
    fn the_persistent_log_rotates() {
        let dir = std::env::temp_dir().join(format!("ose-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut p = Persistent { dir: dir.clone(), file: None, size: 0 };
        p.open();
        let line = format!("{}\n", "x".repeat(1023));
        for _ in 0..(3 * 2048 + 10) {
            p.write(&line);
        }
        assert!(dir.join("ose.log").is_file());
        assert!(dir.join("ose.1.log").is_file());
        assert!(dir.join("ose.2.log").is_file());
        assert!(!dir.join("ose.3.log").exists(), "three files kept, no more");
        assert!(std::fs::metadata(dir.join("ose.1.log")).unwrap().len() <= LOG_MAX_BYTES);
        drop(p);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn arg_helpers() {
        let args = vec![Value::String("a".into()), serde_json::json!({ "limit": 5 })];
        assert_eq!(arg_str(&args, 0).unwrap(), "a");
        assert!(arg_str(&args, 1).is_err());
        assert_eq!(arg_str_or(&args, 9, "x"), "x");
        assert_eq!(opt_field_i64(&args, 1, "limit", 200), 5);
        assert_eq!(opt_field_i64(&args, 0, "limit", 200), 200);
    }
}
