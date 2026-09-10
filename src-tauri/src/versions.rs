//! Versions (batch 12, package P5): the previous content of a vault file, kept under
//! `.ose/versions/<rel path>/<timestamp>.md` before a save changes it, with a cap per file
//! and per vault. See docs/CONTRACT.md batch 12 "Versions".
//!
//! The file's own name is a folder, so `7-scratchpad/note.md` keeps its versions under
//! `.ose/versions/7-scratchpad/note.md/2026-09-10-201500.md`. `.ose` is hidden from the tree
//! (vault.rs `HIDDEN`) and gitignored, so a version never shows up as a page.
//!
//! Nothing here overwrites in place: every write goes to a temp file beside the target and is
//! renamed onto it, so a version — and a restored file — is either the old bytes or the new
//! ones, never a half-written mixture.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::{arg_str, vault, Ctx};

/// Where every version lives, vault-relative.
const ROOT_DIR: &str = ".ose/versions";

/// At most one version per file per five minutes. A newer save inside the window keeps
/// nothing, so what survives is the state the file had before the editing session started —
/// which is the state a user asks for. `force` is the way past it (the conflict dialog).
const MIN_INTERVAL_MS: i64 = 5 * 60 * 1000;

/// Per file, oldest pruned first.
const MAX_PER_FILE: usize = 20;

/// Per vault, oldest pruned first, never the newest version of a file.
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;

// ---- ids -------------------------------------------------------------------

/// `2026-09-10-201500`, UTC, from epoch milliseconds. The `at` a listing reports is the file's
/// mtime, so the UI shows local time; the id only has to sort and be unique.
fn id_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}-{:02}{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days since the Unix epoch to a civil date (Howard Hinnant's algorithm). lib.rs has the same
/// twelve lines for the log stamp and keeps them private; a version id must not depend on a
/// module another package owns, so it carries its own copy rather than asking for a `pub`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
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

/// An id is a file name we built: digits and hyphens only. Anything else could climb out of
/// the versions folder, so it is refused before it ever reaches the filesystem.
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 40
        || !id.chars().all(|c| c.is_ascii_digit() || c == '-')
    {
        return Err(format!("not a version id: {id}"));
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- paths -----------------------------------------------------------------

/// The folder holding the versions of `rel`. `vault::resolve` does the containment, so a
/// `..` in the page path can never reach outside `.ose/versions`.
fn dir_for(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let cleaned = rel.replace('\\', "/");
    let cleaned = cleaned.trim().trim_start_matches('/');
    if cleaned.is_empty() {
        return Err("a version needs a file".to_string());
    }
    let base = vault::resolve(root, ROOT_DIR)?;
    let full = vault::resolve(root, &format!("{ROOT_DIR}/{cleaned}"))?;
    // `resolve` only promises the vault. `.ose/versions/../pages` is inside the vault and
    // outside the history, so the containment is checked here as well.
    if !full.starts_with(&base) || full == base {
        return Err(format!("path escapes the version history: {rel}"));
    }
    Ok(full)
}

/// UTF-8 bytes onto `full` through a temp file beside it, so a reader never sees a half file.
fn write_atomic(full: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = full
        .parent()
        .ok_or_else(|| format!("no parent folder: {}", full.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let tmp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    match fs::rename(&tmp, full) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(format!("{}: {e}", full.display()))
        }
    }
}

// ---- listing ---------------------------------------------------------------

/// One version on disk.
#[derive(Clone, Debug)]
struct Entry {
    id: String,
    at: i64,
    bytes: u64,
    path: PathBuf,
}

/// The versions of `rel`, newest first. A missing folder is an empty list, never an error.
fn entries(root: &Path, rel: &str) -> Result<Vec<Entry>, String> {
    let dir = dir_for(root, rel)?;
    let mut out = Vec::new();
    let Ok(read) = fs::read_dir(&dir) else {
        return Ok(out);
    };
    for e in read.flatten() {
        let path = e.path();
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".md") else { continue };
        if check_id(id).is_err() {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        out.push(Entry {
            id: id.to_string(),
            at: mtime_ms(&meta),
            bytes: meta.len(),
            path,
        });
    }
    // By id, which is the timestamp: a clock that jumps must not shuffle the history.
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

fn to_json(list: &[Entry]) -> Value {
    Value::Array(
        list.iter()
            .map(|e| json!({ "id": e.id, "at": e.at, "bytes": e.bytes }))
            .collect(),
    )
}

// ---- pruning ---------------------------------------------------------------

/// Keep at most `MAX_PER_FILE` versions of one file. `list` is newest first.
fn prune_file(list: &[Entry]) {
    for e in list.iter().skip(MAX_PER_FILE) {
        let _ = fs::remove_file(&e.path);
    }
}

/// Every version file in the vault, with the folder it belongs to, oldest first.
fn walk_all(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, Entry)>) {
    if depth > 32 {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    for e in read.flatten() {
        let path = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            walk_all(&path, depth + 1, out);
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".md") else { continue };
        if check_id(id).is_err() {
            continue;
        }
        out.push((
            dir.to_path_buf(),
            Entry {
                id: id.to_string(),
                at: mtime_ms(&meta),
                bytes: meta.len(),
                path,
            },
        ));
    }
}

/// Hold the whole vault's versions under `MAX_TOTAL_BYTES`, dropping the oldest first and
/// never the last version a file has left.
fn prune_vault(root: &Path) {
    let Ok(base) = vault::resolve(root, ROOT_DIR) else {
        return;
    };
    let mut all = Vec::new();
    walk_all(&base, 0, &mut all);
    let mut total: u64 = all.iter().map(|(_, e)| e.bytes).sum();
    if total <= MAX_TOTAL_BYTES {
        return;
    }
    all.sort_by(|a, b| a.1.id.cmp(&b.1.id));
    // How many versions each folder still has, so the newest of a file is never taken.
    let mut left: std::collections::HashMap<PathBuf, usize> = std::collections::HashMap::new();
    for (dir, _) in &all {
        *left.entry(dir.clone()).or_insert(0) += 1;
    }
    for (dir, e) in &all {
        if total <= MAX_TOTAL_BYTES {
            break;
        }
        let n = left.entry(dir.clone()).or_insert(1);
        if *n <= 1 {
            continue;
        }
        if fs::remove_file(&e.path).is_ok() {
            *n -= 1;
            total = total.saturating_sub(e.bytes);
        }
    }
}

// ---- the four commands -----------------------------------------------------

/// Keep `text` as a version of `rel`. Inside the five-minute window, or when the newest
/// version already holds exactly this text, nothing is written.
pub fn keep(root: &Path, rel: &str, text: &str, force: bool) -> Result<Value, String> {
    if text.is_empty() {
        return Ok(json!({ "kept": false, "id": null }));
    }
    let list = entries(root, rel)?;
    if let Some(newest) = list.first() {
        if fs::read_to_string(&newest.path).ok().as_deref() == Some(text) {
            return Ok(json!({ "kept": false, "id": null }));
        }
        if !force && now_ms().saturating_sub(newest.at) < MIN_INTERVAL_MS {
            return Ok(json!({ "kept": false, "id": null }));
        }
    }

    let dir = dir_for(root, rel)?;
    // A second save in the same second must not land on the id already taken.
    let mut ms = now_ms();
    let mut id = id_from_ms(ms);
    while list.iter().any(|e| e.id == id) {
        ms += 1000;
        id = id_from_ms(ms);
    }
    write_atomic(&dir.join(format!("{id}.md")), text.as_bytes())?;

    let after = entries(root, rel)?;
    prune_file(&after);
    prune_vault(root);
    Ok(json!({ "kept": true, "id": id }))
}

pub fn list(root: &Path, rel: &str) -> Result<Value, String> {
    Ok(to_json(&entries(root, rel)?))
}

pub fn read(root: &Path, rel: &str, id: &str) -> Result<String, String> {
    check_id(id)?;
    let full = dir_for(root, rel)?.join(format!("{id}.md"));
    let bytes = fs::read(&full).map_err(|e| format!("version {id} of {rel}: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("not valid UTF-8: version {id}"))?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// The current text becomes a version (always: this is the one moment losing it would be the
/// user's own doing), then the chosen version is written over the file, atomically.
pub fn restore(root: &Path, rel: &str, id: &str) -> Result<Value, String> {
    let text = read(root, rel, id)?;
    let full = vault::resolve(root, rel)?;
    let current = fs::read_to_string(&full).unwrap_or_default();
    let kept = if current.is_empty() || current == text {
        json!({ "kept": false, "id": null })
    } else {
        keep(root, rel, &current, true)?
    };
    write_atomic(&full, text.as_bytes())?;
    Ok(kept)
}

// ---- dispatch --------------------------------------------------------------

const COMMANDS: &[&str] = &["versionKeep", "versionList", "versionRead", "versionRestore"];

/// `None` means "not mine", like every module handler.
pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if !COMMANDS.contains(&cmd) {
        return None;
    }
    let root = match ctx.st.require_root() {
        Ok(r) => r,
        Err(e) => return Some(Err(e)),
    };
    Some(dispatch(&root, cmd, args))
}

fn dispatch(root: &Path, cmd: &str, args: &[Value]) -> Result<Value, String> {
    match cmd {
        "versionKeep" => {
            let force = args.get(2).and_then(Value::as_bool).unwrap_or(false);
            keep(root, &arg_str(args, 0)?, &arg_str(args, 1)?, force)
        }
        "versionList" => list(root, &arg_str(args, 0)?),
        "versionRead" => Ok(Value::String(read(
            root,
            &arg_str(args, 0)?,
            &arg_str(args, 1)?,
        )?)),
        "versionRestore" => restore(root, &arg_str(args, 0)?, &arg_str(args, 1)?),
        _ => Err(format!("unknown command: {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp dir, removed when dropped.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir()
                .join(format!("ose-versions-{tag}-{stamp}-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn count(root: &Path, rel: &str) -> usize {
        entries(root, rel).unwrap().len()
    }

    /// Put a version on disk with a chosen id, bypassing the interval rule.
    fn plant(root: &Path, rel: &str, id: &str, text: &str) {
        let dir = dir_for(root, rel).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{id}.md")), text).unwrap();
    }

    #[test]
    fn an_id_is_a_utc_timestamp() {
        assert_eq!(id_from_ms(0), "1970-01-01-000000");
        // 2026-09-10 20:15:00 UTC
        assert_eq!(id_from_ms(1_757_535_300_000), "2025-09-10-201500");
        assert!(check_id("2026-09-10-201500").is_ok());
        assert!(check_id("../../etc/passwd").is_err());
        assert!(check_id("a").is_err());
        assert!(check_id("").is_err());
    }

    #[test]
    fn a_version_lands_under_the_file_name_as_a_folder() {
        let t = Tmp::new("keep");
        let root = &t.0;
        fs::write(root.join("note.md"), "# one\n").unwrap();
        let r = keep(root, "note.md", "# one\n", false).unwrap();
        assert_eq!(r["kept"], json!(true));
        let dir = root.join(".ose").join("versions").join("note.md");
        assert!(dir.is_dir(), "the versions folder is the page's own name");
        assert_eq!(count(root, "note.md"), 1);
        let listed = list(root, "note.md").unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        let id = listed[0]["id"].as_str().unwrap().to_string();
        assert_eq!(read(root, "note.md", &id).unwrap(), "# one\n");
    }

    #[test]
    fn five_minutes_between_versions_unless_forced() {
        let t = Tmp::new("interval");
        let root = &t.0;
        assert_eq!(keep(root, "a.md", "one", false).unwrap()["kept"], json!(true));
        // A second save straight away keeps nothing: the pre-session state stays the newest.
        assert_eq!(keep(root, "a.md", "two", false).unwrap()["kept"], json!(false));
        assert_eq!(count(root, "a.md"), 1);
        // The conflict dialog forces one through.
        assert_eq!(keep(root, "a.md", "two", true).unwrap()["kept"], json!(true));
        assert_eq!(count(root, "a.md"), 2);
        // The same text is never kept twice, forced or not.
        assert_eq!(keep(root, "a.md", "two", true).unwrap()["kept"], json!(false));
        assert_eq!(count(root, "a.md"), 2);
        // An empty previous text is nothing to keep.
        assert_eq!(keep(root, "a.md", "", true).unwrap()["kept"], json!(false));
    }

    #[test]
    fn twenty_per_file_oldest_first() {
        let t = Tmp::new("cap");
        let root = &t.0;
        for i in 0..25 {
            plant(root, "b.md", &format!("2026-01-01-0000{i:02}"), &format!("v{i}"));
        }
        assert_eq!(count(root, "b.md"), 25);
        keep(root, "b.md", "the newest", true).unwrap();
        let left = entries(root, "b.md").unwrap();
        assert_eq!(left.len(), MAX_PER_FILE);
        assert_eq!(
            read(root, "b.md", &left[0].id).unwrap(),
            "the newest",
            "the newest survives"
        );
        assert!(
            !left.iter().any(|e| e.id == "2026-01-01-000000"),
            "the oldest is the one pruned"
        );
    }

    #[test]
    fn restore_keeps_the_current_text_first() {
        let t = Tmp::new("restore");
        let root = &t.0;
        fs::write(root.join("c.md"), "# now\n").unwrap();
        plant(root, "c.md", "2026-01-01-000000", "# then\n");
        let r = restore(root, "c.md", "2026-01-01-000000").unwrap();
        assert_eq!(r["kept"], json!(true), "the text being replaced is kept");
        assert_eq!(fs::read_to_string(root.join("c.md")).unwrap(), "# then\n");
        let listed = entries(root, "c.md").unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(read(root, "c.md", &listed[0].id).unwrap(), "# now\n");
    }

    #[test]
    fn a_version_never_escapes_the_versions_folder() {
        let t = Tmp::new("escape");
        let root = &t.0;
        assert!(dir_for(root, "../outside.md").is_err());
        assert!(read(root, "c.md", "../../../secret").is_err());
        assert!(dir_for(root, "").is_err());
    }

    #[test]
    fn the_vault_cap_never_empties_a_file() {
        let t = Tmp::new("vault-cap");
        let root = &t.0;
        let big = "x".repeat(2 * 1024 * 1024);
        for i in 0..30 {
            plant(
                root,
                &format!("page-{i}.md"),
                &format!("2026-01-01-0000{i:02}"),
                &big,
            );
        }
        prune_vault(root);
        let mut total = 0u64;
        for i in 0..30 {
            let n = count(root, &format!("page-{i}.md"));
            assert_eq!(n, 1, "every file keeps its last version");
            total += big.len() as u64;
        }
        assert!(total > MAX_TOTAL_BYTES, "the test data is over the cap");
    }
}
