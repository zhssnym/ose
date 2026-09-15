//! The os editor host. One `rpc` command carries the whole bridge surface of CONTRACT.md;
//! window control is done by the adapter through Tauri's own window API and never reaches here.
//!
//! Each module exposes
//! `handle(ctx, cmd, args) -> Option<Result<Value, String>>`, where `None` means "not mine",
//! and `rpc` tries vault, state, platform in that order.

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub mod args;
pub mod platform;
pub mod protocol;
pub mod rice;
pub mod run;
pub mod state;
pub mod update;
pub mod vault;
pub mod vaults;
pub mod versions;
pub mod watcher;

/// The error every command that touches files returns while no vault is open.
pub const NO_VAULT: &str = "no vault is open";

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

/// What the binary does on the ordinary close path (window geometry, theme into the state
/// file), supplied so `updateApply`, which exits from a worker thread, can do the same before
/// the process goes away.
pub type BeforeRestart = fn(app: &tauri::AppHandle);

/// Everything the host owns, managed by Tauri and reachable from any command or thread.
///
/// The root is optional: the app now starts without one and lets the UI ask (CONTRACT.md,
/// vault resolution). It is read through `root()` / `require_root()` at call time, never
/// cached by a module, so `pickVault` changing it is seen by the next command and by the
/// `vault` protocol alike.
pub struct AppState {
    root: RwLock<Option<Root>>,
    pub log: Option<Mutex<File>>,
    pub watcher: Mutex<Option<watcher::Handle>>,
    pub picker: Option<FolderPicker>,
    pub before_restart: Option<BeforeRestart>,
    /// `--rice <dir>` and `--no-rice`, settled once at startup (rice.rs).
    rice: rice::Slot,
    /// Every program `run` started, so they can all be killed when the app goes (run.rs).
    pub processes: run::Processes,
}

impl AppState {
    pub fn new(root: Option<Root>, log: Option<File>, picker: Option<FolderPicker>) -> Self {
        Self {
            root: RwLock::new(root),
            log: log.map(Mutex::new),
            watcher: Mutex::new(None),
            picker,
            before_restart: None,
            rice: rice::slot(rice::Options::default()),
            processes: run::Processes::default(),
        }
    }

    /// `--rice` and `--no-rice`, as the binary parsed them.
    pub fn rice_options(&self) -> rice::Options {
        self.rice.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_rice_options(&self, options: rice::Options) {
        *self.rice.write().unwrap_or_else(|p| p.into_inner()) = options;
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

    pub fn set_root(&self, path: PathBuf, source: Source) {
        *self.root.write().unwrap_or_else(|p| p.into_inner()) = Some(Root { path, source });
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

/// Appends one timestamped line to the `--log` file, and mirrors it to stderr so a console
/// build and CI see it too. Never fails: logging must not break a command.
pub fn log_line(st: &AppState, s: &str) {
    let line = format!("{}  {}\n", stamp(), s);
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

    /// The whole bridge. `cmd` is the CONTRACT.md method name in camelCase; errors are plain strings.
    #[tauri::command]
    pub async fn rpc(
        app: tauri::AppHandle,
        app_state: tauri::State<'_, AppState>,
        cmd: String,
        args: Vec<Value>,
    ) -> Result<Value, String> {
        let st = app_state.inner();
        let ctx = Ctx { app: &app, st };

        // `log` is the UI writing into the host log; it has no module of its own.
        if cmd == "log" {
            let text = args
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            log_line(st, &format!("ui: {text}"));
            return Ok(Value::Null);
        }

        log_line(st, &format!("rpc {cmd}"));

        // Quitting goes through the window's close path, never around it: `close()` raises
        // CloseRequested, the adapter holds it open until the editor's last save has settled,
        // and only then destroys the window (S16). Cmd+Q and Ctrl+Q therefore save like the
        // close button does.
        if cmd == "quit" {
            return match app.get_webview_window("main") {
                Some(w) => {
                    log_line(st, "quit requested by the UI");
                    w.close().map(|_| Value::Null).map_err(|e| e.to_string())
                }
                None => {
                    app.exit(0);
                    Ok(Value::Null)
                }
            };
        }

        // The folder picker is the one command that waits on the user, so it is awaited here
        // rather than dispatched through the synchronous module handlers.
        if cmd == "pickVault" {
            let r = vault::pick_vault(&ctx).await;
            // A vault the user chose is a vault they may want back: the recent list is written
            // here, where both the picker and `openVault` pass through.
            if let Ok(Value::Object(o)) = &r {
                if let Some(p) = o.get("root").and_then(Value::as_str) {
                    if let Err(e) = vaults::record(&app, std::path::Path::new(p)) {
                        log_line(st, &format!("recent vaults: {e}"));
                    }
                }
            }
            return log_err(st, &cmd, r);
        }

        // The update commands talk to the network and the disk for seconds at a time; each
        // runs on a blocking worker and is awaited here, like the picker.
        if let Some(r) = update::handle(&app, &cmd).await {
            return log_err(st, &cmd, r);
        }

        // Before vault.rs: the recent list owns `recentVaults`, `openVault` and the
        // one-argument `forgetVault`; the no-argument one falls through to vault.rs.
        if let Some(r) = vaults::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }

        // `search` walks every file in the vault and `tree` reads every directory: both are
        // synchronous, and on a big vault either would hold a tokio worker for the length of
        // the walk. Each runs on a blocking worker and is awaited here, exactly as the update
        // commands do above. Everything else in vault.rs touches one path and stays inline.
        if vault::BLOCKING.contains(&cmd.as_str()) {
            let root = match st.require_root() {
                Ok(r) => r,
                Err(e) => return log_err(st, &cmd, Err(e)),
            };
            let (c, a) = (cmd.clone(), args.clone());
            let r = tauri::async_runtime::spawn_blocking(move || vault::dispatch(&root, &c, &a))
                .await
                .unwrap_or_else(|e| Err(format!("{cmd} worker failed: {e}")));
            return log_err(st, &cmd, r);
        }

        if let Some(r) = vault::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = state::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = rice::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = run::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = versions::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        if let Some(r) = platform::handle(&ctx, &cmd, &args) {
            return log_err(st, &cmd, r);
        }
        Err(format!("unknown command: {cmd}"))
    }

    fn log_err(st: &AppState, cmd: &str, r: Result<Value, String>) -> Result<Value, String> {
        if let Err(e) = &r {
            log_line(st, &format!("rpc {cmd} failed: {e}"));
        }
        r
    }

    // ---- argument helpers, shared by the module handlers -----------------------

    /// The .NET `Str(a, i)`: the argument must be a string.
    pub fn arg_str(args: &[Value], i: usize) -> Result<String, String> {
        match args.get(i) {
            Some(Value::String(s)) => Ok(s.clone()),
            _ => Err(format!("argument {i} must be a string")),
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
pub use commands::{arg_str, arg_str_or, opt_field_str, opt_field_i64};

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
