//! The one hide rule (docs/HOST.md "What is listed", H16, D7). One function answers, for a
//! vault path, whether it is **excluded** (never listed, walked, searched or reported by the
//! watcher, whatever the page asks), **hidden** (listed only when the page asks for hidden
//! items: a dotfile, or the system's own hidden attribute) or **shown** (everything else).
//!
//! Nothing is hidden by name. `App`, `app`, `dist`, `node_modules` and `_Archive` are folders
//! like any other; the only names this file knows are the app's own: its state folder `.ose`,
//! git's `.git`, the executable and what a build leaves beside it at the vault root, and the
//! temp files a save writes for a moment. `list`, `tree`, `search` and the watcher all ask
//! here, and the dev bridge (dev/files.mjs) has one port of it.
//!
//! The walker behind `tree` and `search` is the `ignore` crate with every filter of its own
//! off (`.gitignore` means nothing to a vault) and links never followed.

use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::Mutex;

/// What the rule says about one path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Visibility {
    /// Never listed, walked, searched or reported.
    Excluded,
    /// Listed only with `{hidden: true}`.
    Hidden,
    /// Everything else.
    Shown,
}

/// Folders that are excluded wherever they are, in any letter case: the app's state and git's.
const EXCLUDED_ANYWHERE: &[&str] = &[".ose", ".git"];

/// What the app itself leaves at the root of a vault: the executable (under its 1.0 name and
/// the pre-1.0 `os` one), the macOS bundle, the debug symbols, the DLL a local MinGW build
/// needs beside it, and the leftovers of a pre-1.0 build that updated itself. Excluded at the
/// root only: a page called `ose.exe` three folders down is somebody's content. The running
/// executable's own entry is added to these when it sits at the vault root (`OWN_ENTRY`).
const EXCLUDED_AT_ROOT: &[&str] = &[
    "ose.exe",
    "ose.pdb",
    "ose.exe.new",
    "ose.exe.old",
    "Ose.app",
    "Ose.app.old",
    "ose-update.zip",
    "ose-update-tmp",
    "WebView2Loader.dll",
    "os.exe",
    "os.pdb",
    "os.exe.new",
    "os.exe.old",
    "os.app",
    "os.app.old",
    "os-update.zip",
    "os-update-tmp",
];

/// The name of the app's own entry at the root of each vault, lowercased, by the vault's folded
/// root: the running executable, or the `.app` bundle it runs from, when that entry sits directly
/// in the vault root. `None` when the executable lives anywhere else: `D:\os\notes.exe` stays
/// listed when `D:\os` is opened with `--root` from `C:\Tools\notes.exe`, and a root folder called
/// `ose` (the repository inside the vault) is never taken for the Mac binary
/// `Ose.app/Contents/MacOS/ose`. Worked out once per vault: several windows, several vaults.
static OWN_ENTRY: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// The app's own entry at the root of `root`, if any.
pub fn own_entry_of(root: &Path) -> Option<String> {
    let key = fold(root);
    let mut guard = OWN_ENTRY.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(known) = map.get(&key) {
        return known.clone();
    }
    let name = std::env::current_exe().ok().and_then(|exe| own_entry(&exe, root));
    map.insert(key, name.clone());
    name
}

/// The name `exe` puts at the root of `root`, if any: the bundle (`X.app`) when the executable
/// runs from inside one, the executable itself otherwise, and only when that entry's folder is
/// the root.
fn own_entry(exe: &Path, root: &Path) -> Option<String> {
    let named = |p: &Path, want: &str| p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(want));
    let bundle = exe
        .parent()
        .filter(|m| named(m, "MacOS"))
        .and_then(Path::parent)
        .filter(|c| named(c, "Contents"))
        .and_then(Path::parent)
        .filter(|b| b.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase().ends_with(".app")));
    let entry = bundle.unwrap_or(exe);
    let parent = entry.parent()?;
    same_dir(parent, root).then(|| entry.file_name().map(|n| n.to_string_lossy().to_lowercase()))?
}

/// Two folders that are the same folder: by their canonical paths when both exist (a junction,
/// a subst drive), by their normalised spelling otherwise, ignoring case where the filesystem
/// folds it.
fn same_dir(a: &Path, b: &Path) -> bool {
    if let (Ok(x), Ok(y)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        return fold(&x) == fold(&y);
    }
    fold(&crate::vault::normalize(a)) == fold(&crate::vault::normalize(b))
}

fn fold(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(any(windows, target_os = "macos")) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}


/// `.<name>.<pid>.<n>.tmp`: the atomic writer's temp file (vault.rs `write_atomic_with`).
fn is_atomic_temp(name: &str) -> bool {
    let Some(core) = name.strip_prefix('.').and_then(|s| s.strip_suffix(".tmp")) else {
        return false;
    };
    let mut parts = core.rsplitn(3, '.');
    let (n, pid, stem) = (parts.next(), parts.next(), parts.next());
    let digits = |s: Option<&str>| s.is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
    digits(n) && digits(pid) && stem.is_some_and(|s| !s.is_empty())
}

/// `.<name>.<pid>.case`: the half-way name of a case-only rename (vault.rs `rename`).
fn is_case_temp(name: &str) -> bool {
    let Some(core) = name.strip_prefix('.').and_then(|s| s.strip_suffix(".case")) else {
        return false;
    };
    match core.rsplit_once('.') {
        Some((stem, pid)) => !stem.is_empty() && !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// A name that is somebody's temp file, anywhere: ours, an Office owner file (`~$report.docx`)
/// and a LibreOffice lock (`.~lock.report.odt#`).
fn is_temp(name: &str) -> bool {
    is_atomic_temp(name) || is_case_temp(name) || name.starts_with("~$") || (name.starts_with(".~lock.") && name.ends_with('#'))
}

/// One segment of a vault path, at `depth` (0 = a child of the root); `own` is the app's own
/// entry at that root.
fn segment_excluded(seg: &str, depth: usize, own: Option<&str>) -> bool {
    if EXCLUDED_ANYWHERE.iter().any(|x| x.eq_ignore_ascii_case(seg)) || is_temp(seg) {
        return true;
    }
    depth == 0
        && (EXCLUDED_AT_ROOT.iter().any(|x| x.eq_ignore_ascii_case(seg))
            || own.is_some_and(|o| o == seg.to_lowercase()))
}

/// The segments of a vault path: forward or back slashes, empty ones and `.` skipped.
fn segments(rel: &str) -> impl Iterator<Item = &str> {
    rel.split(['/', '\\']).filter(|s| !s.is_empty() && *s != ".")
}

/// Is `rel` (vault-relative) excluded? True when any of its segments is: a file inside `.git`
/// is as excluded as `.git` itself. The vault bin's sidecars (`.trash/.info`) are the app's
/// bookkeeping, like `.ose`: never listed, searched or reported, whatever the page asks.
pub fn excluded(root: &Path, rel: &str) -> bool {
    excluded_with(own_entry_of(root).as_deref(), rel)
}

/// `excluded` with the app's own entry at the root already worked out (`own_entry_of`), for a
/// caller that asks for many paths of one vault.
pub fn excluded_with(own: Option<&str>, rel: &str) -> bool {
    segments(rel).enumerate().any(|(depth, seg)| segment_excluded(seg, depth, own)) || bin_info(rel)
}

/// Inside the vault's own bin, `.trash` at the root (trashbin.rs): hidden, listed with Show
/// hidden items, but never searched (a trashed page is neither a backlink nor a link to rewrite)
/// and never one end of a rename.
pub fn in_bin(rel: &str) -> bool {
    segments(rel).next().is_some_and(|s| s.eq_ignore_ascii_case(".trash"))
}

/// `.trash/.info` and everything in it.
fn bin_info(rel: &str) -> bool {
    let mut s = segments(rel);
    s.next().is_some_and(|a| a.eq_ignore_ascii_case(".trash")) && s.next().is_some_and(|b| b.eq_ignore_ascii_case(".info"))
}

/// A dotfile or dotfolder: hidden by its name.
pub fn hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

/// Does any segment of `rel` start with a dot? The watcher's `hidden` flag: a change inside a
/// dotfolder is as hidden as the folder.
pub fn path_hidden(rel: &str) -> bool {
    segments(rel).any(hidden_name)
}

/// The system's own hidden flag: `FILE_ATTRIBUTE_HIDDEN` on Windows, `UF_HIDDEN` on macOS.
#[cfg(windows)]
pub fn os_hidden(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(target_os = "macos")]
pub fn os_hidden(meta: &Metadata) -> bool {
    use std::os::macos::fs::MetadataExt as _;
    const UF_HIDDEN: u32 = 0x8000;
    meta.st_flags() & UF_HIDDEN != 0
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn os_hidden(_meta: &Metadata) -> bool {
    false
}

/// The rule for one entry: `rel` is its vault path, `meta` its own metadata (not followed
/// through a link) when the caller has it. Hidden is judged by the entry's own name and flag,
/// so listing the inside of a dotfolder the page asked for by name shows what is in it.
pub fn classify(root: &Path, rel: &str, meta: Option<&Metadata>) -> Visibility {
    classify_with(own_entry_of(root).as_deref(), rel, meta)
}

fn classify_with(own: Option<&str>, rel: &str, meta: Option<&Metadata>) -> Visibility {
    if excluded_with(own, rel) {
        return Visibility::Excluded;
    }
    let name = segments(rel).last().unwrap_or("");
    if hidden_name(name) || meta.is_some_and(os_hidden) {
        Visibility::Hidden
    } else {
        Visibility::Shown
    }
}

// ---- links -----------------------------------------------------------------

/// What a symlink or junction points at (docs/HOST.md "Links"), for the `link` field of an
/// entry: `file` or `dir` inside the vault; `broken` when nothing is there; `outside` when the
/// target leaves the vault; `loop` for a folder link whose target is the link's own folder or
/// one of its ancestors. `root_canon` is the vault root, canonicalised once by the caller.
pub fn link_kind(root_canon: &Path, full: &Path) -> (&'static str, Option<Metadata>) {
    let Ok(target) = std::fs::canonicalize(full) else {
        return ("broken", None);
    };
    let meta = std::fs::metadata(&target).ok();
    let Some(m) = &meta else { return ("broken", None) };
    if !target.starts_with(root_canon) {
        return ("outside", meta);
    }
    if m.is_dir() {
        let parent = full.parent().and_then(|p| std::fs::canonicalize(p).ok());
        if parent.is_some_and(|p| p.starts_with(&target)) {
            return ("loop", meta);
        }
        return ("dir", meta);
    }
    ("file", meta)
}

/// The vault root as `canonicalize` spells it (a `\\?\` path on Windows), the form `link_kind`
/// compares targets against. The root itself when it cannot be canonicalised.
pub fn canonical_root(root: &Path) -> PathBuf {
    std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

// ---- the walker ------------------------------------------------------------

/// A walker over `dir` (inside `root`) that applies the rule: excluded entries are never
/// yielded nor entered, hidden ones only with `hidden`, links are yielded but never followed,
/// and nothing deeper than `max_depth` below `dir` is read. The `ignore` crate's own filters
/// (`.gitignore`, `.ignore`, its hidden-file rule) are all off.
pub fn walker(root: &Path, dir: &Path, hidden: bool, max_depth: usize) -> ignore::Walk {
    let own = own_entry_of(root);
    let root = root.to_path_buf();
    ignore::WalkBuilder::new(dir)
        .standard_filters(false)
        .follow_links(false)
        .max_depth(Some(max_depth))
        .filter_entry(move |e| {
            if e.depth() == 0 {
                return true;
            }
            let rel = crate::vault::relative(&root, e.path());
            match classify_with(own.as_deref(), &rel, e.metadata().ok().as_ref()) {
                Visibility::Excluded => false,
                Visibility::Hidden => hidden,
                Visibility::Shown => true,
            }
        })
        .build()
}

/// The path an `ignore` walk error is about, when it names one: a folder that could not be read.
pub fn error_path(e: &ignore::Error) -> Option<PathBuf> {
    match e {
        ignore::Error::WithPath { path, .. } => Some(path.clone()),
        ignore::Error::WithDepth { err, .. } | ignore::Error::WithLineNumber { err, .. } => error_path(err),
        ignore::Error::Partial(list) => list.iter().find_map(error_path),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A vault root the test harness does not sit in.
    fn r() -> &'static Path {
        Path::new(if cfg!(windows) { r"Z:\no-vault" } else { "/no-vault" })
    }

    /// The contract's own list (docs/HOST.md "What is listed"): nothing by name but the app's.
    #[test]
    fn only_the_app_s_own_names_are_excluded() {
        for shown in ["app", "App", "2-nsi/app/index.md", "node_modules", "dist", "_Archive/old.md", "ose.md", "ose"] {
            assert_eq!(classify(r(), shown, None), Visibility::Shown, "{shown}");
        }
        for gone in [".git", ".git/config", ".ose", ".OSE/state.json", "sub/.git/HEAD", "a/b/.ose"] {
            assert_eq!(classify(r(), gone, None), Visibility::Excluded, "{gone}");
        }
        for hidden in [".obsidian", ".trash", "notes/.draft.md", ".env", ".claude"] {
            assert_eq!(classify(r(), hidden, None), Visibility::Hidden, "{hidden}");
        }
        // The bin's sidecars are bookkeeping; a `.info` anywhere else is somebody's dotfolder.
        for gone in [".trash/.info", ".Trash/.INFO/1700-a.md.json"] {
            assert_eq!(classify(r(), gone, None), Visibility::Excluded, "{gone}");
        }
        assert_eq!(classify(r(), "notes/.trash/.info", None), Visibility::Hidden);
        assert!(in_bin(".trash/1700-a.md") && !in_bin("notes/.trash/x.md"));
        // A `.unsaved-*` copy is an ordinary file a person must see (C3).
        assert_eq!(classify(r(), "page.unsaved-20260925-101500.md", None), Visibility::Shown);
    }

    #[test]
    fn the_executable_is_excluded_at_the_root_only() {
        for name in ["ose.exe", "OSE.EXE", "Ose.app", "Ose.app/Contents/MacOS/ose", "WebView2Loader.dll", "os.exe", "os-update-tmp"] {
            assert!(excluded(r(), name), "{name} at the root");
        }
        assert!(!excluded(r(), "tools/ose.exe"), "a copy three folders down is content");
        assert!(!excluded(r(), "backup/WebView2Loader.dll"));
    }

    /// The running executable (or its bundle) is excluded only when it sits at the vault root:
    /// a root folder called `ose` is content when the Mac binary is `Ose.app/Contents/MacOS/ose`,
    /// and so is `notes.exe` in a vault opened from an exe that lives elsewhere.
    #[test]
    fn the_running_executable_is_excluded_only_beside_the_vault() {
        let (root, other) = if cfg!(windows) { (r"D:\os", r"C:\Tools") } else { ("/os", "/tools") };
        let root = Path::new(root);
        let at = |p: &str| root.join(p);
        // The Mac bundle at the root: its name, never the bare `ose` inside it.
        assert_eq!(own_entry(&at("Ose.app/Contents/MacOS/ose"), root).as_deref(), Some("ose.app"));
        assert_eq!(own_entry(&at("Notes.app/Contents/MacOS/ose"), root).as_deref(), Some("notes.app"));
        // An exe at the root under whatever name it was given.
        assert_eq!(own_entry(&at("notes.exe"), root).as_deref(), Some("notes.exe"));
        assert_eq!(own_entry(&at("OSE"), root).as_deref(), Some("ose"));
        // Anywhere else: nothing of the vault is taken for it.
        assert_eq!(own_entry(&Path::new(other).join("notes.exe"), root), None);
        assert_eq!(own_entry(&at("tools/notes.exe"), root), None);
        assert_eq!(own_entry(&Path::new(other).join("Ose.app/Contents/MacOS/ose"), root), None);
        // The test harness does not sit in any vault: its name is content, and so is `ose`.
        let me = std::env::current_exe().unwrap();
        let me = me.file_name().unwrap().to_string_lossy().to_string();
        assert!(!excluded(r(), &me));
        assert!(!excluded(r(), "ose"));
    }

    #[test]
    fn temp_files_are_excluded_anywhere() {
        for name in [
            ".page.md.1234.0.tmp",
            "notes/.page.md.99.12.tmp",
            ".Notes.md.4242.case",
            "~$report.docx",
            "docs/.~lock.report.odt#",
        ] {
            assert!(excluded(r(), name), "{name}");
        }
        for name in [".tmp", "a.tmp", ".x.tmp", ".page.md.abc.0.tmp", "tmp/.keep", ".case"] {
            assert!(!excluded(r(), name), "{name} is not one of ours");
        }
    }

    #[test]
    fn a_path_is_hidden_when_any_segment_is_a_dotfile() {
        assert!(path_hidden(".obsidian/app.json"));
        assert!(path_hidden("notes/.hidden/x.md"));
        assert!(!path_hidden("notes/x.md"));
    }
}
