//! Recent vaults (S46): `<app config dir>/vaults`, one absolute path per line, newest first,
//! at most ten. Per user, outside every vault, beside the `vault` file that holds the one
//! remembered root (vault.rs) — that file answers "which vault opens by itself", this one
//! answers "which vaults has this person had open", and the chooser lists it.
//!
//! Kept out of vault.rs so the recent list has an owner of its own: `handle` runs before
//! vault.rs in lib.rs and claims `recentVaults`, `openVault`, and the one-argument form of
//! `forgetVault` (dropping a single entry). `forgetVault()` with no argument still means
//! "stop remembering a root at all" and falls through to vault.rs.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::{vault, Ctx, Source};

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

/// Windows paths differ in case and nothing else; elsewhere they are compared as written.
pub fn same(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
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
/// so the chooser can grey a folder that is gone instead of opening it and failing.
fn list_value(ctx: &Ctx) -> Value {
    let open = ctx.st.root();
    let rows: Vec<Value> = read(ctx.app)
        .into_iter()
        .map(|p| {
            json!({
                "path": p.to_string_lossy(),
                "name": p.file_name().map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.to_string_lossy().to_string()),
                "exists": p.is_dir(),
                "current": open.as_deref().map(|o| same(o, &p)).unwrap_or(false),
            })
        })
        .collect();
    Value::Array(rows)
}

/// `openVault(path)`: adopt a folder the user picked out of the recent list, with no dialog.
/// Same path as `pickVault` from the moment the folder is known, so it is remembered, watched
/// and recorded exactly the same way.
fn open(ctx: &Ctx, path: &str) -> Result<Value, String> {
    let dir = PathBuf::from(path);
    if !dir.is_dir() {
        return Err(format!("not a folder: {}", dir.display()));
    }
    let info = vault::adopt(ctx, &dir, Source::Picked)?;
    if let Err(e) = record(ctx.app, &dir) {
        crate::log_line(ctx.st, &format!("recent vaults: {e}"));
    }
    Ok(info)
}

pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    match cmd {
        "recentVaults" => Some(Ok(list_value(ctx))),
        "openVault" => match args.first().and_then(Value::as_str) {
            Some(p) if !p.trim().is_empty() => Some(open(ctx, p)),
            _ => Some(Err("openVault needs a path".to_string())),
        },
        // With a path: drop that one recent entry. Without: not ours — vault.rs deletes the
        // remembered-root file, which is what `forgetVault()` has always meant.
        "forgetVault" => match args.first().and_then(Value::as_str) {
            Some(p) if !p.trim().is_empty() => {
                Some(forget_one(ctx.app, Path::new(p)).map(|_| Value::Null))
            }
            _ => None,
        },
        _ => None,
    }
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

    #[cfg(windows)]
    #[test]
    fn windows_paths_compare_without_case() {
        assert!(same(Path::new(r"D:\Os"), Path::new(r"d:\os")));
        assert!(!same(Path::new(r"D:\os"), Path::new(r"D:\other")));
    }
}
