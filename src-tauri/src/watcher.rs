//! Vault watcher: `notify` on the root, recursive, through `notify-debouncer-full` (H9), the
//! hide rule applied (hide.rs), and one `fs` event per burst.
//!
//! The debouncer does what this file used to do by hand, and better: it waits about 150 ms of
//! quiet per path, merges what happened to a path in that time into one change, and pairs the
//! two halves of a rename by the file's id on Windows and macOS (by the kernel's cookie on
//! Linux), so a rename made in Explorer or Finder arrives as one rename instead of a delete and
//! a create. The id cache it pairs with is `VaultIds` below: the vault's files under the one
//! rule, never through a link, never inside `.git` or `.ose`.
//!
//! What goes out is decided at flush time: the kind from the debounced event plus whether the
//! path still exists, and each change says whether it is a folder (`dir`) and whether it is
//! hidden (`hidden`), so the tree can patch one row instead of reading the vault again (M16).
//! Excluded paths are never reported (hide.rs): the app's own writes into `.ose` and the vault
//! bin's sidecars are never events, and an atomic save is the page's `modify` (the debouncer
//! reports it as the page removed and created, and `changes_of` puts the two back together).
//!
//! "You may have missed something" is said too: the backend's Rescan flag, a Windows
//! `ReadDirectoryChangesW` that died (a buffer overflow during a checkout: notify only logs it,
//! and `lib.rs` turns that record into `fault()`), a debouncer error, and every restart after
//! one send `{changes: [], rescan: true}`, and the page re-reads what it shows. A rename moves
//! the file's history and drafts with it, as a rename through the app does.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::file_id::{get_file_id, FileId};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, FileIdCache};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager as _};

use crate::hide;

/// Quiet period per path before the debouncer lets a change go.
const DEBOUNCE: Duration = Duration::from_millis(150);
/// What the debouncer lets go within this much of each other goes out as one batch.
const COALESCE: Duration = Duration::from_millis(50);
/// How often the loop wakes to check the stop flag, the fault flag and the vault folder.
const POLL: Duration = Duration::from_millis(25);
/// A flood (a git checkout, a sync) is flushed rather than accumulated.
const MAX_PENDING: usize = 2000;
/// How often the watcher asks whether the vault folder is still there (S29).
const LIVENESS: Duration = Duration::from_secs(1);
/// How deep the id cache walks, the same bound as the tree's.
const MAX_DEPTH: usize = 25;

/// Set by `fault()` when notify reports, through the `log` crate, that it stopped watching. The
/// running watcher sees it within a poll and restarts.
static FAULT: AtomicBool = AtomicBool::new(false);

/// notify said it gave up on the watch (lib.rs `Records`): restart, and tell the page to re-read.
pub fn fault() {
    FAULT.store(true, Ordering::SeqCst);
}

/// Where the watcher's output goes: the `fs` event, and the drafts folder a rename re-keys.
/// The app gives the Tauri event and its data folder; a test gives a channel.
pub struct Sink {
    pub emit: Box<dyn Fn(Value) + Send>,
    pub data_dir: Box<dyn Fn() -> Option<PathBuf> + Send>,
}

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

/// Starts watching `root` for the app: changes become the `fs` event.
pub fn start(app: AppHandle, root: PathBuf) -> Handle {
    let (a, b) = (app.clone(), app);
    start_with(
        Sink {
            emit: Box::new(move |payload| {
                if let Err(e) = a.emit("fs", payload) {
                    eprintln!("fs event dropped: {e}");
                }
            }),
            data_dir: Box::new(move || b.state::<crate::AppState>().data_dir()),
        },
        root,
    )
}

/// Starts watching `root`. Never fails: a watcher that cannot be created is retried on the
/// thread, exactly as the .NET host restarted its FileSystemWatcher on error.
pub fn start_with(sink: Sink, root: PathBuf) -> Handle {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name("fs-watcher".to_string())
        .spawn(move || {
            // The vault folder itself going away used to be an error line a second, for ever,
            // with an empty tree and a toast per failed call. It is said once, as a fact about
            // the vault rather than about the watcher, and once more when it comes back (S29).
            let mut lost = false;
            // Set by a watcher that failed; the next one to start says `rescan` once it is up.
            let mut missed = false;
            while !flag.load(Ordering::Relaxed) {
                // Asked before the watcher is (re)built, so the folder coming back is noticed
                // in the same breath as the watch that succeeds on it.
                let gone = !root.is_dir();
                if gone != lost {
                    lost = gone;
                    eprintln!("vault root {}: {}", if lost { "lost" } else { "back" }, root.display());
                    // `changes` stays present and empty: every subscriber reads it.
                    (sink.emit)(json!({ "changes": [], "lost": lost }));
                }
                match run(&sink, &root, &flag, &mut missed) {
                    Ok(()) => break,
                    Err(e) => {
                        missed = true;
                        eprintln!("watcher error: {e}; restarting");
                    }
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
fn run(sink: &Sink, root: &Path, stop: &AtomicBool, missed: &mut bool) -> Result<(), String> {
    // A fault from the watcher being replaced is not this one's.
    FAULT.store(false, Ordering::SeqCst);
    let (tx, rx) = channel::<DebounceEventResult>();
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, VaultIds>(
        DEBOUNCE,
        None,
        tx,
        VaultIds::new(root),
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    debouncer.watch(root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    if std::mem::take(missed) {
        (sink.emit)(json!({ "changes": [], "rescan": true }));
    }

    let mut batch = Batch::default();
    let mut last = Instant::now();
    let mut checked = Instant::now();

    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        if FAULT.swap(false, Ordering::SeqCst) {
            return Err("notify stopped watching".to_string());
        }
        // The vault folder can go away without notify saying a word: on Windows the backend
        // holds a handle to the directory and simply stops reporting when the drive is
        // unplugged or the folder is deleted from underneath it (S29). One metadata call a
        // second is what it costs to notice, and returning Err hands it to the restart loop.
        if checked.elapsed() >= LIVENESS {
            checked = Instant::now();
            if !root.is_dir() {
                return Err("the vault root is gone".to_string());
            }
        }
        match rx.recv_timeout(POLL) {
            Ok(Ok(events)) => {
                for ev in &events {
                    if ev.need_rescan() {
                        batch.rescan = true;
                    }
                    batch.queue(root, &ev.event);
                }
                last = Instant::now();
            }
            Ok(Err(errors)) => {
                let text: Vec<String> = errors.iter().map(|e| e.to_string()).collect();
                return Err(text.join("; "));
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err("the debouncer stopped".to_string()),
        }
        if batch.ready(last) {
            flush(sink, root, &mut batch);
        }
    }
}

// ---- the id cache ----------------------------------------------------------

/// The file ids the debouncer pairs renames with: the vault's entries under the one rule
/// (hidden ones included, excluded folders and links never entered). A path the debouncer adds
/// one at a time (a create) is cached even when its own name is excluded — an atomic save's
/// temp file must be known for its rename onto the page to be paired — but nothing inside
/// `.git` or `.ose` ever is.
pub(crate) struct VaultIds {
    root: PathBuf,
    paths: HashMap<PathBuf, FileId>,
}

impl VaultIds {
    pub(crate) fn new(root: &Path) -> Self {
        Self { root: root.to_path_buf(), paths: HashMap::new() }
    }

    /// Is `path` inside an excluded folder (its parent segments, not its own name)?
    fn under_excluded(&self, path: &Path) -> bool {
        let Some(rel) = rel(&self.root, path) else { return false };
        match rel.rsplit_once('/') {
            Some((parent, _)) => hide::excluded(parent),
            None => false,
        }
    }
}

impl FileIdCache for VaultIds {
    fn cached_file_id(&self, path: &Path) -> Option<impl AsRef<FileId>> {
        self.paths.get(path)
    }

    fn add_path(&mut self, path: &Path, recursive_mode: RecursiveMode) {
        if self.under_excluded(path) {
            return;
        }
        if let Ok(id) = get_file_id(path) {
            self.paths.insert(path.to_path_buf(), id);
        }
        let is_dir = std::fs::symlink_metadata(path).map(|m| m.is_dir()).unwrap_or(false);
        if recursive_mode != RecursiveMode::Recursive || !is_dir {
            return;
        }
        if path != self.root && rel(&self.root, path).is_some_and(|r| hide::excluded(&r)) {
            return;
        }
        for entry in hide::walker(&self.root, path, true, MAX_DEPTH).flatten() {
            if entry.depth() == 0 {
                continue;
            }
            if let Ok(id) = get_file_id(entry.path()) {
                self.paths.insert(entry.path().to_path_buf(), id);
            }
        }
    }

    fn remove_path(&mut self, path: &Path) {
        self.paths.retain(|p, _| !p.starts_with(path));
    }
}

// ---- collecting -----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Create,
    Modify,
    Delete,
    Rename,
    /// Half a move that nothing could be paired with (a move into or out of the vault), or an
    /// event notify could not classify. Resolved at flush time by a metadata check.
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

struct Pending {
    kind: Kind,
    path: String,
    to: Option<String>,
}

#[derive(Default)]
struct Batch {
    pending: Vec<Pending>,
    seen: HashSet<String>,
    /// The backend flagged an event with Rescan: the batch goes out with `rescan: true`.
    rescan: bool,
}

impl Batch {
    /// One debounced event. A rename arrives whole (`Name(Both)`, both paths), paired by the
    /// debouncer; a `From` or `To` alone is half a move across the vault's edge.
    fn queue(&mut self, root: &Path, ev: &notify::Event) {
        match &ev.kind {
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if ev.paths.len() >= 2 => {
                match (rel(root, &ev.paths[0]), rel(root, &ev.paths[1])) {
                    (Some(from), Some(to)) => self.rename(from, to),
                    // one end of the move is outside the vault
                    (Some(p), None) | (None, Some(p)) => self.add(Kind::Ambiguous, p),
                    (None, None) => {}
                }
            }
            EventKind::Modify(ModifyKind::Name(_)) | EventKind::Any => self.each(root, ev, Kind::Ambiguous),
            EventKind::Create(_) => self.each(root, ev, Kind::Create),
            EventKind::Remove(_) => self.each(root, ev, Kind::Delete),
            EventKind::Modify(_) => self.each(root, ev, Kind::Modify),
            // Access and Other say nothing about content.
            _ => {}
        }
    }

    fn each(&mut self, root: &Path, ev: &notify::Event, kind: Kind) {
        for p in &ev.paths {
            if let Some(r) = rel(root, p) {
                self.add(kind, r);
            }
        }
    }

    fn add(&mut self, kind: Kind, path: String) {
        if hide::excluded(&path) {
            return;
        }
        self.push(Pending { kind, path, to: None });
    }

    fn rename(&mut self, from: String, to: String) {
        match (hide::excluded(&from), hide::excluded(&to)) {
            (true, true) => {}
            // An atomic save: a temp file renamed onto the page is the page changing.
            (true, false) => self.push(Pending { kind: Kind::Modify, path: to, to: None }),
            // Moved into an excluded place: gone, as far as the vault is concerned.
            (false, true) => self.push(Pending { kind: Kind::Ambiguous, path: from, to: None }),
            // Into the vault's bin or out of it (a trash, a restore): the file left the vault or
            // came back, which is a delete and a create, never a rename a page would follow.
            (false, false) if hide::in_bin(&from) != hide::in_bin(&to) => {
                self.push(Pending { kind: Kind::Ambiguous, path: from, to: None });
                self.push(Pending { kind: Kind::Ambiguous, path: to, to: None });
            }
            (false, false) => self.push(Pending { kind: Kind::Rename, path: from, to: Some(to) }),
        }
    }

    fn push(&mut self, c: Pending) {
        let key = format!("{}|{}|{}", c.kind.as_str(), c.path, c.to.as_deref().unwrap_or(""));
        if self.seen.insert(key) {
            self.pending.push(c);
        }
    }

    fn ready(&self, last: Instant) -> bool {
        (self.rescan || !self.pending.is_empty()) && (last.elapsed() >= COALESCE || self.pending.len() >= MAX_PENDING)
    }
}

// ---- flushing -------------------------------------------------------------

/// `{path, kind, to?, dir?, hidden?}`: `dir` when the path (the new one, for a rename) is a
/// folder that is still there; `hidden` when it is a dotfile, inside a dotfolder, or carries
/// the system's hidden flag.
fn change(root: &Path, path: &str, kind: &str, to: Option<&str>) -> Value {
    let at = to.unwrap_or(path);
    let meta = std::fs::symlink_metadata(root.join(at)).ok();
    let mut c = json!({ "path": path, "kind": kind });
    if let Some(to) = to {
        c["to"] = json!(to);
    }
    if let Some(m) = &meta {
        if m.is_dir() {
            c["dir"] = json!(true);
        }
    }
    if hide::path_hidden(at) || meta.as_ref().is_some_and(hide::os_hidden) {
        c["hidden"] = json!(true);
    }
    c
}

/// The changes of a batch as they go out, with renames followed (history, drafts).
fn changes_of(root: &Path, batch: &mut Batch, follow: &dyn Fn(&str, &str)) -> (Vec<Value>, bool) {
    let changes = std::mem::take(&mut batch.pending);
    let rescan = std::mem::take(&mut batch.rescan);
    batch.seen.clear();

    // A path that was removed and created again in one batch, and is a file now, was replaced
    // in place: the app's own atomic save (the debouncer drops the temp file's rename, since it
    // saw the temp file created, and reports the page removed and created), or another editor's
    // delete-then-write. For the page and the tree that is the file changing, a `modify`.
    let of = |k: Kind| changes.iter().filter(move |c| c.to.is_none() && c.kind == k).map(|c| c.path.as_str());
    let removed: HashSet<&str> = of(Kind::Delete).collect();
    let replaced: HashSet<&str> = of(Kind::Create).filter(|p| removed.contains(p)).collect();

    let mut out: Vec<Value> = Vec::new();
    let mut emitted: HashSet<String> = HashSet::new();
    for c in &changes {
        if let Some(to) = c.to.as_deref() {
            if emitted.insert(format!("rename|{}|{to}", c.path)) {
                follow(&c.path, to);
                out.push(change(root, &c.path, "rename", Some(to)));
            }
            continue;
        }
        // The kind the backend reported can be stale by now: a file created and deleted inside
        // one debounce window is a delete, a "removed" path that is back is a create.
        let meta = std::fs::symlink_metadata(root.join(&c.path)).ok();
        let kind = match (c.kind, &meta) {
            (_, None) => "delete",
            (_, Some(m)) if m.is_file() && replaced.contains(c.path.as_str()) => "modify",
            (Kind::Create | Kind::Delete | Kind::Ambiguous, Some(_)) => "create",
            _ => "modify",
        };
        if emitted.insert(format!("{kind}|{}", c.path)) {
            out.push(change(root, &c.path, kind, None));
        }
    }
    (out, rescan)
}

fn flush(sink: &Sink, root: &Path, batch: &mut Batch) {
    let follow = |from: &str, to: &str| follow_rename(sink, root, from, to);
    let (out, rescan) = changes_of(root, batch, &follow);
    if out.is_empty() && !rescan {
        return;
    }
    let payload = if rescan {
        json!({ "changes": out, "rescan": true })
    } else {
        json!({ "changes": out })
    };
    (sink.emit)(payload);
}

/// A rename made outside the app: the history and the drafts of `from` move to `to`, as they do
/// for a rename through the app (vault.rs). Only a real move counts — `from` gone and `to`
/// there — so an editor that renames the file aside and writes a new one in its place (a
/// backup-then-write save) keeps its history where it was. A rename through the app arrives here
/// too, after the fact, and finds nothing left to move.
fn follow_rename(sink: &Sink, root: &Path, from: &str, to: &str) {
    if root.join(from).exists() || !root.join(to).exists() {
        return;
    }
    if let Err(e) = crate::versions::move_history(root, from, to) {
        eprintln!("history: {from} -> {to}: {e}");
    }
    if let Some(data) = (sink.data_dir)() {
        if let Err(e) = crate::drafts::rekey_in(&data, root, from, to) {
            eprintln!("drafts: {from} -> {to}: {e}");
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn root() -> &'static Path {
        Path::new(if cfg!(windows) { r"D:\os" } else { "/os" })
    }

    fn ev(kind: EventKind, names: &[&str]) -> notify::Event {
        notify::Event { kind, paths: names.iter().map(|n| root().join(n)).collect(), attrs: Default::default() }
    }

    #[cfg(windows)]
    #[test]
    fn relative_paths() {
        let root = Path::new(r"D:\os");
        assert_eq!(rel(root, Path::new(r"D:\os\a\b.md")).as_deref(), Some("a/b.md"));
        assert_eq!(rel(root, Path::new(r"D:\os")), None);
        assert_eq!(rel(root, Path::new(r"D:\other\b.md")), None);
    }

    #[test]
    fn a_paired_rename_is_one_change() {
        let mut b = Batch::default();
        b.queue(root(), &ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["a.md", "b.md"]));
        assert_eq!(b.pending.len(), 1);
        assert_eq!(b.pending[0].kind, Kind::Rename);
        assert_eq!(b.pending[0].path, "a.md");
        assert_eq!(b.pending[0].to.as_deref(), Some("b.md"));
    }

    /// A trash into `.trash` and a restore out of it are a delete and a create, never a rename
    /// the history, the drafts or an open page would follow.
    #[test]
    fn a_move_into_the_bin_is_not_a_rename() {
        let mut b = Batch::default();
        b.queue(root(), &ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["a.md", ".trash/1700-a.md"]));
        assert_eq!(b.pending.len(), 2);
        assert!(b.pending.iter().all(|p| p.kind == Kind::Ambiguous && p.to.is_none()));
    }

    #[test]
    fn half_a_move_is_still_reported() {
        let mut b = Batch::default();
        b.queue(root(), &ev(EventKind::Modify(ModifyKind::Name(RenameMode::From)), &["a.md"]));
        assert_eq!(b.pending.len(), 1);
        assert_eq!(b.pending[0].kind, Kind::Ambiguous);
    }

    /// The hide rule decides what is reported: `.git` and `.ose` never, a dotfile yes (flagged
    /// hidden at flush), and an atomic save is the page's modify.
    #[test]
    fn excluded_paths_are_never_reported_and_a_save_is_a_modify() {
        let mut b = Batch::default();
        b.queue(root(), &ev(EventKind::Create(notify::event::CreateKind::File), &[".git/index.lock", ".ose/state.json"]));
        assert!(b.pending.is_empty());
        b.queue(root(), &ev(EventKind::Create(notify::event::CreateKind::File), &[".obsidian/app.json", "App/x.md"]));
        assert_eq!(b.pending.len(), 2);
        b.queue(
            root(),
            &ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &[".page.md.12.0.tmp", "page.md"]),
        );
        let last = b.pending.last().unwrap();
        assert_eq!((last.kind, last.path.as_str(), last.to.is_none()), (Kind::Modify, "page.md", true));
    }

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("ose-watch-{tag}-{stamp}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            // The watcher reports paths under the root as the system spells them.
            Tmp(crate::vault::normalize(&dir))
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn watch(root: &Path) -> (Handle, Receiver<Value>) {
        let (tx, rx) = channel::<Value>();
        let tx = std::sync::Mutex::new(tx);
        let handle = start_with(
            Sink {
                emit: Box::new(move |v| {
                    let _ = tx.lock().unwrap().send(v);
                }),
                data_dir: Box::new(|| None),
            },
            root.to_path_buf(),
        );
        (handle, rx)
    }

    /// Every change the watcher sent within `wait`, until `done` says enough.
    fn collect(rx: &Receiver<Value>, wait: Duration, done: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let until = Instant::now() + wait;
        let mut all = Vec::new();
        while Instant::now() < until && !done(&all) {
            if let Ok(v) = rx.recv_timeout(Duration::from_millis(50)) {
                if let Some(list) = v["changes"].as_array() {
                    all.extend(list.iter().cloned());
                }
            }
        }
        all
    }

    /// H9: a rename made outside the app, across the debounce window, arrives as one rename —
    /// paired by the file's id on Windows and macOS, by the kernel's cookie on Linux.
    #[test]
    fn a_rename_is_paired_across_the_debounce() {
        let t = Tmp::new("rename");
        std::fs::write(t.0.join("a.md"), "# a\n").unwrap();
        let (handle, rx) = watch(&t.0);
        // Let the watch and the id cache settle before the move.
        std::thread::sleep(Duration::from_millis(500));
        std::fs::rename(t.0.join("a.md"), t.0.join("b.md")).unwrap();
        let seen = collect(&rx, Duration::from_secs(5), |all| all.iter().any(|c| c["kind"] == "rename"));
        drop(handle);
        let rename = seen.iter().find(|c| c["kind"] == "rename").unwrap_or_else(|| panic!("no rename in {seen:?}"));
        assert_eq!(rename["path"], "a.md");
        assert_eq!(rename["to"], "b.md");
        assert!(rename.get("dir").is_none());
    }

    /// The app's own save, for real: `write_atomic` writes a temp file and renames it over the
    /// page. The debouncer reports that as the page removed and created; it goes out as one
    /// `modify`, so the tree patches a row instead of re-listing the folder (M16).
    #[test]
    fn an_atomic_save_is_one_modify() {
        let t = Tmp::new("save");
        std::fs::write(t.0.join("page.md"), "# one
").unwrap();
        let (handle, rx) = watch(&t.0);
        std::thread::sleep(Duration::from_millis(500));
        crate::vault::write_atomic(&t.0.join("page.md"), b"# two
").map_err(|f| f.error).unwrap();
        let seen = collect(&rx, Duration::from_secs(3), |_| false);
        drop(handle);
        let page: Vec<&Value> = seen.iter().filter(|c| c["path"] == "page.md").collect();
        assert!(!page.is_empty(), "no change for the page in {seen:?}");
        assert!(page.iter().all(|c| c["kind"] == "modify"), "{seen:?}");
        assert!(seen.iter().all(|c| c["path"] == "page.md"), "only the page: {seen:?}");
    }

    /// A batch that holds the page removed and created is a modify; a new file is a create.
    #[test]
    fn a_remove_and_create_of_one_file_is_a_modify() {
        let t = Tmp::new("replace");
        std::fs::write(t.0.join("page.md"), "x").unwrap();
        std::fs::write(t.0.join("new.md"), "y").unwrap();
        std::fs::create_dir_all(t.0.join("dir")).unwrap();
        let mut b = Batch::default();
        let at = |n: &str| notify::Event {
            kind: EventKind::Any,
            paths: vec![t.0.join(n)],
            attrs: Default::default(),
        };
        let with = |mut e: notify::Event, k: EventKind| {
            e.kind = k;
            e
        };
        b.queue(&t.0, &with(at("page.md"), EventKind::Remove(notify::event::RemoveKind::Any)));
        b.queue(&t.0, &with(at("page.md"), EventKind::Create(notify::event::CreateKind::Any)));
        b.queue(&t.0, &with(at("new.md"), EventKind::Create(notify::event::CreateKind::Any)));
        b.queue(&t.0, &with(at("dir"), EventKind::Remove(notify::event::RemoveKind::Any)));
        b.queue(&t.0, &with(at("dir"), EventKind::Create(notify::event::CreateKind::Any)));
        let (out, _) = changes_of(&t.0, &mut b, &|_, _| {});
        let kind = |p: &str| out.iter().filter(|c| c["path"] == p).map(|c| c["kind"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(kind("page.md"), ["modify"]);
        assert_eq!(kind("new.md"), ["create"]);
        // A folder replaced in place is re-listed: a create, as before.
        assert_eq!(kind("dir"), ["create"]);
    }

    /// The vault bin's sidecars are bookkeeping: a trash into `.trash` reports the page gone and
    /// the item in the bin, never `.trash/.info`.
    #[test]
    fn a_trash_sidecar_is_never_an_event() {
        let t = Tmp::new("sidecar");
        std::fs::write(t.0.join("page.md"), "x").unwrap();
        let (handle, rx) = watch(&t.0);
        std::thread::sleep(Duration::from_millis(500));
        crate::trashbin::trash(&t.0, "page.md", "vault").unwrap();
        let seen = collect(&rx, Duration::from_secs(3), |_| false);
        drop(handle);
        assert!(seen.iter().any(|c| c["path"] == "page.md" && c["kind"] == "delete"), "{seen:?}");
        assert!(seen.iter().all(|c| !c["path"].as_str().unwrap_or("").to_lowercase().starts_with(".trash/.info")), "{seen:?}");
    }

    /// The app's own writes into `.ose` are never events; a dotfile is, flagged hidden.
    #[test]
    fn the_state_folder_is_silent_and_a_dotfile_is_flagged() {
        let t = Tmp::new("silent");
        std::fs::create_dir_all(t.0.join(".ose")).unwrap();
        let (handle, rx) = watch(&t.0);
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(t.0.join(".ose/state.json"), "{}").unwrap();
        std::fs::write(t.0.join(".env"), "A=1\n").unwrap();
        let seen = collect(&rx, Duration::from_secs(5), |all| all.iter().any(|c| c["path"] == ".env"));
        drop(handle);
        assert!(seen.iter().all(|c| !c["path"].as_str().unwrap_or("").starts_with(".ose")), "{seen:?}");
        let env = seen.iter().find(|c| c["path"] == ".env").unwrap_or_else(|| panic!("no .env in {seen:?}"));
        assert_eq!(env["hidden"], true);
    }
}
