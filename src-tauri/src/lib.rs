//! The Ose host (docs/HOST.md). Every operation the page asks of it is one typed command
//! (commands.rs), with serde structs in and out and one error type (error.rs); the TypeScript
//! bindings the kernel imports are generated from them (bindings.rs). Window control is done by
//! the page through Tauri's own window API and never reaches here.
//!
//! The modules under the commands speak `Result<_, String>` with a `[code] message` prefix
//! (docs/HOST.md "Errors"); `HostError::from` reads the code back out at the command.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod args;
pub mod bindings;
pub mod commands;
pub mod drafts;
pub mod encoding;
pub mod error;
pub mod files;
pub mod hide;
pub mod local;
pub mod outside;
pub mod platform;
pub mod print;
pub mod protocol;
pub mod state;
pub mod trashbin;
pub mod vault;
pub mod vaults;
pub mod versions;
pub mod watcher;
pub mod windows;

pub use error::{HostError, HostResult};
pub use windows::{Host, Win};

/// The error every command that touches files returns while no vault is open.
pub const NO_VAULT: &str = "[no_vault] no vault is open";

/// `[code] message`: the one shape of every error a module answers (docs/HOST.md "Errors").
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
    /// opened from the OS: a folder, or the vault a file handed to the app belongs to
    Opened,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Arg => "arg",
            Source::Exe => "exe",
            Source::Env => "env",
            Source::Remembered => "remembered",
            Source::Picked => "picked",
            Source::Opened => "opened",
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
pub type FolderPicker = fn(
    app: &tauri::AppHandle,
    parent: Option<tauri::WebviewWindow>,
    start: Option<PathBuf>,
    done: Box<dyn FnOnce(Option<PathBuf>) + Send>,
);

/// The native save dialog behind `printToPdf`, supplied by the binary for the same reason as
/// the folder picker above: `start` is the folder to open in, `name` the file name to offer,
/// `done` receives the choice and `None` on cancel.
pub type FileSaver = fn(
    app: &tauri::AppHandle,
    parent: Option<tauri::WebviewWindow>,
    start: Option<PathBuf>,
    name: String,
    done: Box<dyn FnOnce(Option<PathBuf>) + Send>,
);

/// The native open-file dialog behind `pickFile`, supplied by the binary for the same reason:
/// `title` heads it, `done` receives the file and `None` on cancel.
pub type FilePicker = fn(
    app: &tauri::AppHandle,
    parent: Option<tauri::WebviewWindow>,
    title: String,
    done: Box<dyn FnOnce(Option<PathBuf>) + Send>,
);

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
pub fn log_line(st: &Host, s: &str) {
    log_at(st, Level::Info, s);
}

/// `log_line` at a chosen level.
pub fn log_at(st: &Host, level: Level, s: &str) {
    let line = format!("{} {} {}\n", stamp(), level.as_str(), s);
    persist(&line);
    to_flag_log(st, &line);
}

/// A line for the `--log` file and stderr only: the name of every rpc, which is what a person
/// debugging with `--log` wants and what would drown the persistent log in noise.
pub fn trace_line(st: &Host, s: &str) {
    let line = format!("{} debug {}\n", stamp(), s);
    to_flag_log(st, &line);
}

fn to_flag_log(st: &Host, line: &str) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_000), (2022, 1, 8));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
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
}
