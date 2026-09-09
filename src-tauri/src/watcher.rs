//! Vault watcher: `notify` on the root, recursive, hidden paths filtered, changes debounced
//! 150ms into one `fs` event.
//!
//! Ported from `host/Watcher.cs`. notify reports a different set of kinds than
//! FileSystemWatcher did, so two adjustments are made here. A rename arrives as
//! `Modify(Name(From))` immediately followed by `Modify(Name(To))` with no cookie joining
//! them (verified on Windows with notify 8), so the two are paired by arrival order. And the
//! raw kind is only a first guess: the kind that goes out is decided at flush time from the
//! raw kind plus whether the path still exists.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// Quiet period before a batch goes out.
const DEBOUNCE: Duration = Duration::from_millis(150);
/// How often the loop wakes to check the debounce and the stop flag.
const POLL: Duration = Duration::from_millis(25);
/// A flood (a git checkout, a sync) is flushed rather than accumulated.
const MAX_PENDING: usize = 2000;

/// Stops the watcher thread when dropped.
pub struct Handle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Starts watching `root`. Never fails: a watcher that cannot be created is retried on the
/// thread, exactly as the .NET host restarted its FileSystemWatcher on error.
pub fn start(app: AppHandle, root: PathBuf) -> Handle {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name("fs-watcher".to_string())
        .spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                match run(&app, &root, &flag) {
                    Ok(()) => break,
                    Err(e) => eprintln!("watcher error: {e}; restarting"),
                }
                // a second of backoff, still responsive to the stop flag
                for _ in 0..40 {
                    if flag.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(POLL);
                }
            }
        })
        .ok();
    if thread.is_none() {
        eprintln!("watcher error: could not start the watcher thread");
    }
    Handle { stop, thread }
}

/// One watcher's life. `Ok(())` means "asked to stop", `Err` means "restart me".
fn run(app: &AppHandle, root: &Path, stop: &AtomicBool) -> Result<(), String> {
    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let mut batch = Batch::default();
    let mut last = Instant::now();

    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        match rx.recv_timeout(POLL) {
            Ok(Ok(ev)) => {
                batch.queue(root, &ev);
                last = Instant::now();
            }
            Ok(Err(e)) => return Err(e.to_string()),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err("watcher stopped".to_string()),
        }
        if batch.ready(last) {
            flush(app, root, &mut batch);
        }
    }
}

// ---- collecting -----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Create,
    Modify,
    Delete,
    Rename,
    /// A rename half nothing could be paired with, or an event notify could not classify.
    /// Resolved at flush time by a metadata check.
    Ambiguous,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Create => "create",
            Kind::Modify => "modify",
            Kind::Delete => "delete",
            Kind::Rename => "rename",
            Kind::Ambiguous => "ambiguous",
        }
    }
}

/// What the raw notify kind says before anything is checked on disk.
enum Raw {
    Simple(Kind),
    /// `Modify(Name(From))`: the first half of a rename.
    From,
    /// `Modify(Name(To))`: the second half.
    To,
    /// `Modify(Name(Both))`: both paths in one event (other backends).
    Pair,
    Ignore,
}

fn classify(k: &EventKind) -> Raw {
    match k {
        EventKind::Create(_) => Raw::Simple(Kind::Create),
        EventKind::Remove(_) => Raw::Simple(Kind::Delete),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => Raw::Pair,
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Raw::From,
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => Raw::To,
        // FSEvents reports a rename as Name(Any), one path at a time: undecidable here.
        EventKind::Modify(ModifyKind::Name(_)) => Raw::Simple(Kind::Ambiguous),
        EventKind::Modify(_) => Raw::Simple(Kind::Modify),
        EventKind::Any => Raw::Simple(Kind::Ambiguous),
        // Access and Other say nothing about content.
        _ => Raw::Ignore,
    }
}

struct Pending {
    kind: Kind,
    path: String,
    to: Option<String>,
}

#[derive(Default)]
struct Batch {
    pending: Vec<Pending>,
    seen: HashSet<String>,
    /// A `From` waiting for its `To`.
    rename_from: Option<String>,
}

impl Batch {
    fn queue(&mut self, root: &Path, ev: &notify::Event) {
        match classify(&ev.kind) {
            Raw::Ignore => {}
            Raw::To => {
                let to = ev.paths.first().and_then(|p| rel(root, p));
                match (self.rename_from.take(), to) {
                    (Some(from), Some(to)) => self.rename(from, to),
                    // one end of the move is outside the vault
                    (Some(p), None) | (None, Some(p)) => self.add(Kind::Ambiguous, p),
                    (None, None) => {}
                }
            }
            Raw::From => {
                self.settle();
                self.rename_from = ev.paths.first().and_then(|p| rel(root, p));
            }
            Raw::Pair => {
                self.settle();
                if ev.paths.len() >= 2 {
                    if let (Some(from), Some(to)) =
                        (rel(root, &ev.paths[0]), rel(root, &ev.paths[1]))
                    {
                        self.rename(from, to);
                    }
                }
            }
            Raw::Simple(kind) => {
                self.settle();
                for p in &ev.paths {
                    if let Some(r) = rel(root, p) {
                        self.add(kind, r);
                    }
                }
            }
        }
    }

    /// A `From` that never found its `To` is a change of its own.
    fn settle(&mut self) {
        if let Some(p) = self.rename_from.take() {
            self.add(Kind::Ambiguous, p);
        }
    }

    fn add(&mut self, kind: Kind, path: String) {
        if hidden(&path) {
            return;
        }
        self.push(Pending { kind, path, to: None });
    }

    fn rename(&mut self, from: String, to: String) {
        // As in the .NET host: a move is silent only when both ends are hidden.
        if hidden(&from) && hidden(&to) {
            return;
        }
        self.push(Pending {
            kind: Kind::Rename,
            path: from,
            to: Some(to),
        });
    }

    fn push(&mut self, c: Pending) {
        let key = format!(
            "{}|{}|{}",
            c.kind.as_str(),
            c.path,
            c.to.as_deref().unwrap_or("")
        );
        if self.seen.insert(key) {
            self.pending.push(c);
        }
    }

    fn ready(&self, last: Instant) -> bool {
        !self.pending.is_empty() && (last.elapsed() >= DEBOUNCE || self.pending.len() >= MAX_PENDING)
    }
}

// ---- flushing -------------------------------------------------------------

fn flush(app: &AppHandle, root: &Path, batch: &mut Batch) {
    batch.settle();
    let changes = std::mem::take(&mut batch.pending);
    batch.seen.clear();

    let mut out: Vec<Value> = Vec::new();
    let mut emitted: HashSet<String> = HashSet::new();
    for c in &changes {
        if let Some(to) = c.to.as_deref() {
            if emitted.insert(format!("rename|{}|{to}", c.path)) {
                out.push(json!({ "path": c.path, "kind": "rename", "to": to }));
            }
            continue;
        }
        // The kind notify reported can be stale by now: a file created and deleted inside one
        // debounce window is a delete, a "removed" path that is back is a create.
        let exists = std::fs::symlink_metadata(root.join(&c.path)).is_ok();
        let kind = match (c.kind, exists) {
            (_, false) => "delete",
            (Kind::Create | Kind::Delete | Kind::Ambiguous, true) => "create",
            _ => "modify",
        };
        if emitted.insert(format!("{kind}|{}", c.path)) {
            out.push(json!({ "path": c.path, "kind": kind }));
        }
    }

    if out.is_empty() {
        return;
    }
    if let Err(e) = app.emit("fs", json!({ "changes": out })) {
        eprintln!("fs event dropped: {e}");
    }
}

// ---- paths ----------------------------------------------------------------

/// Vault-relative, forward slashes. `None` for the root itself and for anything outside it.
fn rel(root: &Path, p: &Path) -> Option<String> {
    if let Ok(r) = p.strip_prefix(root) {
        let mut out = String::new();
        for c in r.components() {
            let Component::Normal(s) = c else { return None };
            if !out.is_empty() {
                out.push('/');
            }
            out.push_str(&s.to_string_lossy());
        }
        return if out.is_empty() { None } else { Some(out) };
    }
    // FSEvents and ReadDirectoryChangesW can differ from the root in case or separator.
    let rs = root.to_string_lossy().replace('\\', "/");
    let rs = rs.trim_end_matches('/');
    let ps = p.to_string_lossy().replace('\\', "/");
    if rs.is_empty() || ps.len() <= rs.len() || !ps.is_char_boundary(rs.len()) {
        return None;
    }
    if ps.as_bytes()[rs.len()] != b'/' || !ps[..rs.len()].eq_ignore_ascii_case(rs) {
        return None;
    }
    let tail = ps[rs.len() + 1..].trim_matches('/');
    if tail.is_empty() || tail.split('/').any(|s| s == "." || s == "..") {
        None
    } else {
        Some(tail.to_string())
    }
}

/// The vault's own hidden list (one list, so a name the tree never shows is never reported
/// changing either: the update's `os.exe.new` being written would otherwise storm the UI).
fn hidden(rel: &str) -> bool {
    rel.split('/').any(crate::vault::is_hidden)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_segments() {
        assert!(hidden(".git/config"));
        assert!(hidden("App/src/main.js"));
        assert!(hidden("Personal/.obsidian/x"));
        assert!(hidden("os.exe"));
        assert!(!hidden("_Archive/old.md"));
        assert!(!hidden("Personal/1. Life/profile.md"));
    }

    #[cfg(windows)]
    #[test]
    fn relative_paths() {
        let root = Path::new(r"D:\os");
        assert_eq!(
            rel(root, Path::new(r"D:\os\a\b.md")).as_deref(),
            Some("a/b.md")
        );
        assert_eq!(rel(root, Path::new(r"D:\os")), None);
        assert_eq!(rel(root, Path::new(r"D:\other\b.md")), None);
    }

    #[test]
    fn pairs_a_rename_from_its_two_halves() {
        let root = Path::new(if cfg!(windows) { r"D:\os" } else { "/os" });
        let mut b = Batch::default();
        let ev = |kind: EventKind, name: &str| notify::Event {
            kind,
            paths: vec![root.join(name)],
            attrs: Default::default(),
        };
        b.queue(
            root,
            &ev(EventKind::Modify(ModifyKind::Name(RenameMode::From)), "a.md"),
        );
        b.queue(
            root,
            &ev(EventKind::Modify(ModifyKind::Name(RenameMode::To)), "b.md"),
        );
        assert_eq!(b.pending.len(), 1);
        assert_eq!(b.pending[0].kind, Kind::Rename);
        assert_eq!(b.pending[0].path, "a.md");
        assert_eq!(b.pending[0].to.as_deref(), Some("b.md"));
    }

    #[test]
    fn an_unpaired_half_is_still_reported() {
        let root = Path::new(if cfg!(windows) { r"D:\os" } else { "/os" });
        let mut b = Batch::default();
        b.queue(
            root,
            &notify::Event {
                kind: EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                paths: vec![root.join("a.md")],
                attrs: Default::default(),
            },
        );
        b.settle();
        assert_eq!(b.pending.len(), 1);
        assert_eq!(b.pending[0].kind, Kind::Ambiguous);
    }
}
