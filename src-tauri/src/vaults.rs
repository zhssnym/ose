//! Recent vaults (S46): `<app config dir>/vaults`, one absolute path per line, newest first,
//! at most ten. Per user, outside every vault, beside the `vault` file that holds the one
//! remembered root (vault.rs) — that file answers "which vault opens by itself", this one
//! answers "which vaults has this person had open", and the chooser lists it.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::vault;

/// Never more than this many lines, so the file cannot grow without bound and the chooser
/// never has to scroll.
const CAP: usize = 10;

/// `<app config dir>/vaults`. `None` on a platform with no config folder.
pub fn recent_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager as _;
    app.path().app_config_dir().ok().map(|d| d.join("vaults"))
}

/// The paths as written, in order, without touching the disk. Blank lines and a BOM are
/// dropped; nothing is validated here, because a vault on a USB stick that is not plugged in
/// today is still a recent vault.
fn parse(text: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for line in text.lines() {
        let line = line.trim().trim_start_matches('\u{feff}').trim();
        if line.is_empty() {
            continue;
        }
        let p = vault::normalize(Path::new(line));
        if !out.iter().any(|q| same(q, &p)) {
            out.push(p);
        }
    }
    out
}

/// Are `a` and `b` the same folder or file, as the filesystem would say (`fold`)? The one
/// answer to "is this the same vault": the window rule, the recent list, `route` and the
/// outside registrations all ask it here.
pub fn same(a: &Path, b: &Path) -> bool {
    fold(a) == fold(b)
}

/// `p` spelled so two spellings of one path compare equal: forward slashes, no trailing slash;
/// on Windows without case; on macOS without case and in NFC, since APFS and HFS+ ignore both
/// (Finder hands over NFD, a typed path is NFC); elsewhere as written. For comparing only: a
/// path that is used is always the caller's own spelling.
pub fn fold(p: &Path) -> String {
    fold_with(&p.to_string_lossy(), cfg!(any(windows, target_os = "macos")), cfg!(target_os = "macos"))
}

/// `fold` with the platform's choices given, so every platform's rules are tested everywhere.
pub fn fold_with(s: &str, caseless: bool, nfc: bool) -> String {
    let s = s.replace('\\', "/");
    let s = s.trim_end_matches('/');
    let s = if nfc { vault::to_nfc(s.to_string()) } else { s.to_string() };
    if caseless {
        s.to_lowercase()
    } else {
        s
    }
}

/// The segments of a folded path, empty ones dropped: `D:/a//b` and `D:/a/b` are one path.
fn segments(folded: &str) -> Vec<&str> {
    folded.split('/').filter(|s| !s.is_empty()).collect()
}

/// `full` relative to `root` with forward slashes when it is inside it (`""` for the root
/// itself), compared by whole segments after `fold`: `D:/a2` is not inside `D:/a`, and an NFD
/// file under an NFC root is inside it on macOS. The answer keeps `full`'s own spelling of the
/// segments below the root, in NFC on macOS (`vault::nfc`). Folding never adds or removes a
/// `/`, so the segments of the two spellings line up one for one, whatever their lengths.
pub fn relative(root: &Path, full: &Path) -> Option<String> {
    relative_with(root, full, &fold)
}

/// `relative` with the fold given, for the tests.
pub fn relative_with(root: &Path, full: &Path, fold: &dyn Fn(&Path) -> String) -> Option<String> {
    let (r, f) = (fold(root), fold(full));
    let (r, f) = (segments(&r), segments(&f));
    if f.len() < r.len() || f[..r.len()] != r[..] {
        return None;
    }
    let own = full.to_string_lossy().replace('\\', "/");
    let rest: Vec<&str> = segments(&own).into_iter().skip(r.len()).collect();
    Some(vault::nfc(rest.join("/")))
}

pub fn read(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let Some(file) = recent_file(app) else {
        return Vec::new();
    };
    match fs::read_to_string(file) {
        Ok(text) => parse(&text),
        Err(_) => Vec::new(),
    }
}

fn write(app: &tauri::AppHandle, list: &[PathBuf]) -> Result<(), String> {
    let file = recent_file(app).ok_or("no app config folder on this platform")?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let body: String = list
        .iter()
        .take(CAP)
        .map(|p| format!("{}\n", p.to_string_lossy()))
        .collect();
    fs::write(&file, body).map_err(|e| format!("{}: {e}", file.display()))
}

/// Puts `root` at the top of the list. Called when a vault is adopted and once at startup, so
/// the vault the app opened by itself is in the list too. A write that fails is not an error
/// worth failing a launch over: it is logged by the caller and forgotten.
pub fn record(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    let root = vault::normalize(root);
    let mut list = read(app);
    list.retain(|p| !same(p, &root));
    list.insert(0, root);
    list.truncate(CAP);
    write(app, &list)
}

/// Drops one entry. Removing something that is not in the list is not an error.
pub fn forget_one(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    let root = vault::normalize(root);
    let mut list = read(app);
    let before = list.len();
    list.retain(|p| !same(p, &root));
    if list.len() == before {
        return Ok(());
    }
    write(app, &list)
}

/// `recentVaults()` -> `[{path, name, exists, current}]`, newest first. `exists` is read here
/// so the chooser can grey a folder that is gone instead of opening it and failing; `current`
/// is the vault of the window that asks.
pub fn list_value(app: &tauri::AppHandle, current: Option<&Path>) -> Value {
    rows_value(read(app), current)
}

/// The rows of `list_value` for a list already read.
pub fn rows_value(list: Vec<PathBuf>, current: Option<&Path>) -> Value {
    let rows: Vec<Value> = list
        .into_iter()
        .map(|p| {
            json!({
                "path": p.to_string_lossy(),
                "name": p.file_name().map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.to_string_lossy().to_string()),
                "exists": p.is_dir(),
                "current": current.map(|o| same(o, &p)).unwrap_or(false),
            })
        })
        .collect();
    Value::Array(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_drops_blanks_and_duplicates() {
        let p = if cfg!(windows) { "D:\\a" } else { "/a" };
        let q = if cfg!(windows) { "D:\\b" } else { "/b" };
        let text = format!("\u{feff}{p}\n\n  {q}  \n{p}\n");
        let list = parse(&text);
        assert_eq!(list.len(), 2);
        assert!(same(&list[0], Path::new(p)));
        assert!(same(&list[1], Path::new(q)));
    }

    /// M49: one fold for every question of identity. On macOS an NFD spelling and a case change
    /// are the same vault, and an NFD file is inside an NFC root, with the path taken by
    /// segments rather than by counting characters.
    #[test]
    fn the_fold_is_nfc_and_caseless_on_macos() {
        let nfc_root = "/Users/h/Caf\u{e9}";
        let nfd_root = "/users/h/Cafe\u{301}/";
        let mac = |p: &Path| fold_with(&p.to_string_lossy(), true, true);
        let linux = |p: &Path| fold_with(&p.to_string_lossy(), false, false);
        assert_eq!(mac(Path::new(nfc_root)), mac(Path::new(nfd_root)));
        assert_ne!(linux(Path::new(nfc_root)), linux(Path::new(nfd_root)));
        let nfd_file = Path::new("/Users/h/Cafe\u{301}/Notes/De\u{301}ja\u{300}.md");
        let rel = relative_with(Path::new(nfc_root), nfd_file, &mac).unwrap();
        assert_eq!(vault::to_nfc(rel), "Notes/D\u{e9}j\u{e0}.md");
        assert_eq!(relative_with(Path::new(nfc_root), nfd_file, &linux), None, "no fold, no match");
        assert_eq!(relative_with(Path::new(nfc_root), Path::new(nfd_root), &mac).as_deref(), Some(""));
        assert_eq!(relative_with(Path::new("/a"), Path::new("/a2/x.md"), &mac), None);
        assert_eq!(fold_with(r"D:\Os\", true, false), "d:/os");
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_compare_without_case() {
        assert!(same(Path::new(r"D:\Os"), Path::new(r"d:\os")));
        assert!(!same(Path::new(r"D:\os"), Path::new(r"D:\other")));
    }
}
