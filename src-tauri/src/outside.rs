//! Files outside the vault (docs/HOST.md "Outside files", H24, M19).
//!
//! A file opened from the OS or with "Open file…" that belongs to no vault opens in a tab of its
//! own, marked "outside vault". The page names it `abs:<absolute path>`, with forward slashes, the
//! drive letter in capitals, no `\\?\` prefix, and NFC on macOS: `abs:D:/Notes/todo.md`,
//! `abs:/Users/h/Notes/a.md`.
//!
//! A window may only touch an outside file it opened itself (`outsideOpen`), for the window's
//! life. Opening one registers it, and that allows:
//!
//! - reads and saves of that file, through the commands marked **A** in docs/HOST.md;
//! - read-only media under its folder, recursively, through the `vault` origin at
//!   `/~abs/<percent-encoded absolute path>`, so the images of an outside note show;
//! - a watch of its folder (not recursive), whose changes to a registered file go to that
//!   window as `abs:` paths. A rename arrives as a delete and a create.
//!
//! Versions, renames, moves, the trash, links and attachments are refused on them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, NoCache};
use serde_json::json;
use tauri::Emitter as _;

use crate::vault;

/// The prefix of an outside path in the page.
pub const ABS: &str = "abs:";

/// Quiet period before a change to an outside file goes out.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// The outside files one window opened, and the watches on their folders.
#[derive(Default)]
pub struct Outside {
    files: RwLock<Vec<PathBuf>>,
    watches: Mutex<HashMap<String, Watch>>,
}

/// A running watch of one folder; dropping it stops the watch.
struct Watch {
    _debouncer: notify_debouncer_full::Debouncer<RecommendedWatcher, NoCache>,
}

// The one fold of every path comparison (`vaults::fold`: case, and NFC on macOS).
use crate::vaults::fold;

/// Is `p` an outside path (`abs:…`)?
pub fn is_abs(p: &str) -> bool {
    p.starts_with(ABS)
}

/// `abs:` and the absolute path the page names: forward slashes, the drive letter in capitals,
/// no verbatim prefix, NFC on macOS.
pub fn js_path(full: &Path) -> String {
    let mut s = full.to_string_lossy().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/UNC/") {
        s = format!("//{rest}");
    } else if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        s = format!("{}{}", (b[0] as char).to_ascii_uppercase(), &s[1..]);
    }
    format!("{ABS}{}", vault::nfc(s))
}

/// The native absolute path an `abs:` path (or a native absolute path) names, normalised.
/// Anything relative is `[bad_arg]`.
pub fn native(p: &str) -> Result<PathBuf, String> {
    let raw = p.strip_prefix(ABS).unwrap_or(p);
    let raw = if cfg!(windows) { raw.replace('/', "\\") } else { raw.to_string() };
    let path = PathBuf::from(&raw);
    if raw.is_empty() || !path.is_absolute() || raw.contains('\0') {
        return Err(crate::coded("bad_arg", format!("not an absolute path: {p}")));
    }
    Ok(vault::normalize(&path))
}

impl Outside {
    /// Registers `full` for this window (idempotent) and watches its folder.
    pub fn register(&self, app: &tauri::AppHandle, label: &str, full: &Path) {
        let full = vault::normalize(full);
        {
            let mut files = self.files.write().unwrap_or_else(|p| p.into_inner());
            if !files.iter().any(|f| fold(f) == fold(&full)) {
                files.push(full.clone());
            }
        }
        let Some(dir) = full.parent().map(Path::to_path_buf) else { return };
        let key = fold(&dir);
        let mut watches = self.watches.lock().unwrap_or_else(|p| p.into_inner());
        if watches.contains_key(&key) {
            return;
        }
        match watch(app.clone(), label.to_string(), dir.clone()) {
            Ok(w) => {
                watches.insert(key, w);
            }
            Err(e) => log::warn!("outside watch {}: {e}", dir.display()),
        }
    }

    /// Registers `full` without a watch: the tests, which have no app.
    #[cfg(test)]
    pub fn register_quiet(&self, full: &Path) {
        let full = vault::normalize(full);
        self.files.write().unwrap().push(full);
    }

    /// Is `full` a file this window opened?
    pub fn is_registered(&self, full: &Path) -> bool {
        self.files.read().unwrap_or_else(|p| p.into_inner()).iter().any(|f| fold(f) == fold(full))
    }

    /// May the `vault` origin serve `full`? When it is under the folder of a registered file.
    pub fn media_allowed(&self, full: &Path) -> bool {
        self.files.read().unwrap_or_else(|p| p.into_inner()).iter().any(|reg| {
            reg.parent().is_some_and(|dir| crate::vaults::relative(dir, full).is_some_and(|rel| !rel.is_empty()))
        })
    }

    /// The registered file an `abs:` path names, or `[not_registered]`.
    pub fn resolve(&self, p: &str) -> Result<PathBuf, String> {
        let full = native(p)?;
        if !self.is_registered(&full) {
            return Err(crate::coded("not_registered", format!("this window has not opened {p}")));
        }
        Ok(full)
    }

    /// Every registered file, as the page names it.
    pub fn list(&self) -> Vec<String> {
        self.files.read().unwrap_or_else(|p| p.into_inner()).iter().map(|f| js_path(f)).collect()
    }

    /// Forgets everything and stops every watch (the window is gone).
    pub fn clear(&self) {
        self.files.write().unwrap_or_else(|p| p.into_inner()).clear();
        self.watches.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
}

/// Watches `dir`, not recursively; a change to a registered file goes to window `label` as an
/// `fs` event with its `abs:` path. Which files are registered is asked at event time, so a file
/// registered later in the same folder is seen too.
fn watch(app: tauri::AppHandle, label: String, dir: PathBuf) -> Result<Watch, String> {
    let (tx, rx) = channel::<DebounceEventResult>();
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        DEBOUNCE,
        None,
        tx,
        NoCache,
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    debouncer.watch(&dir, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    let thread_label = label.clone();
    std::thread::Builder::new()
        .name(format!("outside-watch-{label}"))
        .spawn(move || loop {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(Ok(events)) => {
                    let changes = changes_of(&app, &thread_label, events.iter().flat_map(|e| e.paths.iter()));
                    if !changes.is_empty() {
                        let payload = json!({ "changes": changes });
                        let _ = app.emit_to(tauri::EventTarget::webview_window(&thread_label), "fs", payload);
                    }
                }
                Ok(Err(_)) => {
                    let payload = json!({ "changes": [], "rescan": true });
                    let _ = app.emit_to(tauri::EventTarget::webview_window(&thread_label), "fs", payload);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Watch { _debouncer: debouncer })
}

/// The changes of one batch, for the registered files only: `modify` when the file is there,
/// `delete` when it is not. Asked of the window's live list, so a file registered after the watch
/// started is seen too.
fn changes_of<'a>(app: &tauri::AppHandle, label: &str, paths: impl Iterator<Item = &'a PathBuf>) -> Vec<serde_json::Value> {
    use tauri::Manager as _;
    let host = app.state::<crate::windows::Host>();
    let Some(win) = host.get(label) else { return Vec::new() };
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for p in paths {
        let full = vault::normalize(p);
        if !win.outside.is_registered(&full) {
            continue;
        }
        let key = fold(&full);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let kind = if full.is_file() { "modify" } else { "delete" };
        out.push(json!({ "path": js_path(&full), "kind": kind }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn the_page_spelling_on_windows() {
        assert_eq!(js_path(Path::new(r"d:\Notes\todo.md")), "abs:D:/Notes/todo.md");
        assert_eq!(js_path(Path::new(r"\\?\D:\Notes\a.md")), "abs:D:/Notes/a.md");
        assert_eq!(native("abs:D:/Notes/todo.md").unwrap(), PathBuf::from(r"D:\Notes\todo.md"));
        assert_eq!(native(r"D:\Notes\x\..\todo.md").unwrap(), PathBuf::from(r"D:\Notes\todo.md"));
    }

    #[cfg(not(windows))]
    #[test]
    fn the_page_spelling_elsewhere() {
        assert_eq!(js_path(Path::new("/Users/h/a.md")), "abs:/Users/h/a.md");
        assert_eq!(native("abs:/Users/h/a.md").unwrap(), PathBuf::from("/Users/h/a.md"));
    }

    #[test]
    fn a_relative_path_is_not_an_outside_path() {
        assert!(native("abs:notes/a.md").unwrap_err().starts_with("[bad_arg]"));
        assert!(native("abs:").unwrap_err().starts_with("[bad_arg]"));
    }

    #[test]
    fn only_a_registered_file_resolves_and_media_follow_its_folder() {
        let base = std::env::temp_dir().join(format!("ose-outside-reg-{}", std::process::id()));
        let o = Outside::default();
        let file = base.join("notes").join("a.md");
        let js = js_path(&file);
        assert!(o.resolve(&js).unwrap_err().starts_with("[not_registered]"));
        o.register_quiet(&file);
        assert_eq!(o.resolve(&js).unwrap(), vault::normalize(&file));
        assert!(o.media_allowed(&base.join("notes").join("img").join("x.png")));
        assert!(!o.media_allowed(&base.join("other").join("x.png")));
        assert!(!o.media_allowed(&base.join("notes2").join("x.png")), "a sibling that shares a prefix is not under it");
        assert!(o.resolve(&js_path(&base.join("notes").join("b.md"))).is_err(), "only the file itself");
        if cfg!(windows) {
            assert!(o.resolve(&js.to_lowercase()).is_ok(), "case folds on Windows");
        }
        assert_eq!(o.list(), vec![js]);
        o.clear();
        assert!(o.list().is_empty());
    }
}
