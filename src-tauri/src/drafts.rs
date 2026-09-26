//! Drafts (docs/HOST.md "Drafts", C4, D5): the buffer of a page that could not be written, kept
//! on this machine, outside the vault, so a failed save, a crash or a closed window never costs
//! the text.
//!
//! One JSON file per page at `<app local data>/drafts/<vaultKey>/<pathKey>.json`, where
//! `vaultKey` is the hash of the vault's absolute root (lowercased on Windows and macOS, whose
//! filesystems fold case) and `pathKey` the hash of the page's vault path. The file carries
//! `v: 1`, the vault's root and the page's path, so a folder of drafts explains itself. Never
//! synced, never in the vault: a draft is this machine's memory of what was typed here.
//!
//! Every write goes through `vault::write_atomic_owned`: the text is still in the page, so a
//! rename that never goes through removes its temp file instead of setting a copy aside that
//! would read as a second draft. Every command that reads a draft and then writes or removes
//! one holds `GATE`, so a `draftDrop` can never remove a draft written after its rev check.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::{arg_str, coded, vault, AppState, Ctx};

/// One draft command at a time. Drafts are small and rare; one lock for all of them is simpler
/// than one per file and costs nothing.
static GATE: Mutex<()> = Mutex::new(());

/// How long a draft's rename is tried again: short, the page retries and the text is in it.
const BUDGET_MS: u64 = 500;

/// A draft file's name: 16 lowercase hex digits (the path's hash) and `.json`. Anything else in
/// the folder (a temp file, a copy someone made) is not a draft.
fn is_draft_name(name: &str) -> bool {
    name.strip_suffix(".json")
        .map(|stem| stem.len() == 16 && stem.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .unwrap_or(false)
}

/// The folder of one vault's drafts, under the app's data folder.
fn vault_dir(data: &Path, root: &Path) -> PathBuf {
    let mut key = vault::normalize(root).to_string_lossy().replace('\\', "/");
    if cfg!(any(windows, target_os = "macos")) {
        key = key.to_lowercase();
    }
    data.join("drafts").join(vault::hash(key.as_bytes()))
}

/// A vault path as drafts key it: forward slashes, no leading or trailing slash.
fn clean(rel: &str) -> String {
    rel.replace('\\', "/").trim().trim_matches('/').to_string()
}

fn file_for(data: &Path, root: &Path, rel: &str) -> PathBuf {
    vault_dir(data, root).join(format!("{}.json", vault::hash(clean(rel).as_bytes())))
}

fn read_json(file: &Path) -> Option<Map<String, Value>> {
    let text = fs::read_to_string(file).ok()?;
    match serde_json::from_str::<Value>(&text).ok()? {
        Value::Object(o) if o.get("v").and_then(Value::as_u64) == Some(1) => Some(o),
        _ => None,
    }
}

/// The page-facing shape of a stored draft (`Draft`): everything but `v` and `vault`.
fn to_draft(o: &Map<String, Value>) -> Value {
    json!({
        "path": o.get("path").cloned().unwrap_or(Value::Null),
        "text": o.get("text").cloned().unwrap_or(json!("")),
        "baselineHash": o.get("baselineHash").cloned().unwrap_or(Value::Null),
        "mode": o.get("mode").cloned().unwrap_or(json!("rich")),
        "exact": o.get("exact").cloned().unwrap_or(json!(true)),
        "rev": o.get("rev").cloned().unwrap_or(json!(0)),
        "at": o.get("at").cloned().unwrap_or(json!(0)),
    })
}

fn write_json(file: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| coded("io", format!("{}: {e}", dir.display())))?;
    }
    let text = serde_json::to_string(value).map_err(|e| coded("io", e))?;
    vault::write_atomic_owned(file, text.as_bytes(), BUDGET_MS).map_err(|f| f.message("draft", None))
}

// ---- the four commands -----------------------------------------------------

/// `draftWrite(path, draft)` -> `{at}`. `draft` is `{text, baselineHash, mode, exact, rev}`; the
/// host sets `at`.
pub fn write(data: &Path, root: &Path, rel: &str, draft: &Value, now: i64) -> Result<Value, String> {
    let d = draft.as_object().ok_or_else(|| coded("bad_arg", "a draft is an object"))?;
    let text = d
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| coded("bad_arg", "a draft needs its text"))?;
    let baseline = match d.get("baselineHash") {
        Some(Value::String(h)) => json!(h),
        _ => Value::Null,
    };
    let mode = match d.get("mode").and_then(Value::as_str) {
        Some("source") => "source",
        _ => "rich",
    };
    let stored = json!({
        "v": 1,
        "vault": vault::normalize(root).to_string_lossy(),
        "path": clean(rel),
        "text": text,
        "baselineHash": baseline,
        "mode": mode,
        "exact": d.get("exact").and_then(Value::as_bool).unwrap_or(true),
        "rev": d.get("rev").filter(|v| v.is_number()).cloned().unwrap_or(json!(0)),
        "at": now,
    });
    let _gate = GATE.lock().unwrap_or_else(|p| p.into_inner());
    write_json(&file_for(data, root, rel), &stored)?;
    Ok(json!({ "at": now }))
}

/// `draftList()` -> `DraftInfo[]` of the open vault, newest first: a draft without its text,
/// with `bytes`, the text's size.
pub fn list(data: &Path, root: &Path) -> Value {
    let mut out: Vec<Value> = Vec::new();
    if let Ok(read) = fs::read_dir(vault_dir(data, root)) {
        for e in read.flatten() {
            let path = e.path();
            if !is_draft_name(&e.file_name().to_string_lossy()) {
                continue;
            }
            let Some(o) = read_json(&path) else { continue };
            let mut info = to_draft(&o);
            let bytes = info["text"].as_str().map(str::len).unwrap_or(0);
            if let Some(m) = info.as_object_mut() {
                m.remove("text");
                m.insert("bytes".into(), json!(bytes));
            }
            out.push(info);
        }
    }
    out.sort_by(|a, b| {
        let at = |v: &Value| v["at"].as_f64().unwrap_or(0.0);
        at(b).partial_cmp(&at(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    Value::Array(out)
}

/// `draftRead(path)` -> `Draft`, or `null` when there is none.
pub fn read(data: &Path, root: &Path, rel: &str) -> Value {
    read_json(&file_for(data, root, rel))
        .map(|o| to_draft(&o))
        .unwrap_or(Value::Null)
}

/// `draftDrop(path, {ifRev})` -> `{dropped}`. With `if_rev`, only a draft written at that edit
/// or before it goes: a newer one holds typing the caller has not seen saved.
pub fn drop(data: &Path, root: &Path, rel: &str, if_rev: Option<f64>) -> Result<Value, String> {
    let file = file_for(data, root, rel);
    let _gate = GATE.lock().unwrap_or_else(|p| p.into_inner());
    let Some(o) = read_json(&file) else {
        // Nothing readable there. A file that is not a draft of ours is left alone.
        return Ok(json!({ "dropped": false }));
    };
    if let Some(limit) = if_rev {
        let rev = o.get("rev").and_then(Value::as_f64).unwrap_or(0.0);
        if rev > limit {
            return Ok(json!({ "dropped": false }));
        }
    }
    match fs::remove_file(&file) {
        Ok(()) => Ok(json!({ "dropped": true })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "dropped": false })),
        Err(e) => Err(coded("io", format!("draft of {rel}: {e}"))),
    }
}

/// A rename of `from` (a file, or a folder and everything under it) to `to`: every draft at or
/// under `from` is re-keyed to the new path. When the new path already has a draft, the newer
/// of the two stays the draft and the older is kept as a version of the new path (reason
/// `conflict`), so neither text is lost; when that version cannot be written, both drafts stay
/// where they are.
pub fn rekey_in(data: &Path, root: &Path, from: &str, to: &str) -> Result<(), String> {
    let (from, to) = (clean(from), clean(to));
    if from.is_empty() || from == to {
        return Ok(());
    }
    let _gate = GATE.lock().unwrap_or_else(|p| p.into_inner());
    let Ok(read) = fs::read_dir(vault_dir(data, root)) else {
        return Ok(());
    };
    for e in read.flatten() {
        if !is_draft_name(&e.file_name().to_string_lossy()) {
            continue;
        }
        let old_file = e.path();
        let Some(mut o) = read_json(&old_file) else { continue };
        let Some(path) = o.get("path").and_then(Value::as_str).map(str::to_string) else { continue };
        let moved = if path == from {
            to.clone()
        } else if let Some(rest) = path.strip_prefix(&format!("{from}/")) {
            format!("{to}/{rest}")
        } else {
            continue;
        };
        let new_file = file_for(data, root, &moved);
        if let Some(there) = read_json(&new_file).filter(|_| new_file != old_file) {
            let at = |m: &Map<String, Value>| m.get("at").and_then(Value::as_f64).unwrap_or(0.0);
            let there_is_newer = at(&there) > at(&o);
            let older = if there_is_newer { &o } else { &there };
            let text = older.get("text").and_then(Value::as_str).unwrap_or("");
            let kept = crate::versions::keep(root, &moved, text.as_bytes(), true, crate::versions::Reason::Conflict);
            if let Err(err) = kept {
                eprintln!("drafts: {path} -> {moved}: both drafts stay, the older could not be kept: {err}");
                continue;
            }
            if there_is_newer {
                let _ = fs::remove_file(&old_file);
                continue;
            }
        }
        o.insert("path".into(), json!(moved));
        write_json(&new_file, &Value::Object(o))?;
        if new_file != old_file {
            let _ = fs::remove_file(&old_file);
        }
    }
    Ok(())
}

/// `rekey_in` for the open app: nothing to do without a data folder.
pub fn rekey(st: &AppState, root: &Path, from: &str, to: &str) -> Result<(), String> {
    match st.data_dir() {
        Some(data) => rekey_in(&data, root, from, to),
        None => Ok(()),
    }
}

// ---- dispatch --------------------------------------------------------------

const COMMANDS: &[&str] = &["draftWrite", "draftList", "draftRead", "draftDrop"];

/// `None` means "not mine", like every module handler.
pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if !COMMANDS.contains(&cmd) {
        return None;
    }
    let root = match crate::root_for(ctx.st, cmd, args) {
        Ok(r) => r,
        Err(e) => return Some(Err(e)),
    };
    let data = ctx.st.data_dir();
    Some(dispatch(data.as_deref(), &root, cmd, args))
}

fn dispatch(data: Option<&Path>, root: &Path, cmd: &str, args: &[Value]) -> Result<Value, String> {
    let need = || data.ok_or_else(|| coded("io", "this machine has no app data folder for drafts"));
    match cmd {
        "draftWrite" => {
            let draft = args.get(1).cloned().unwrap_or(Value::Null);
            write(need()?, root, &arg_str(args, 0)?, &draft, crate::versions::now_ms())
        }
        "draftList" => Ok(data.map(|d| list(d, root)).unwrap_or_else(|| json!([]))),
        "draftRead" => {
            let rel = arg_str(args, 0)?;
            Ok(data.map(|d| read(d, root, &rel)).unwrap_or(Value::Null))
        }
        "draftDrop" => {
            let rel = arg_str(args, 0)?;
            let if_rev = args.get(1).and_then(|o| o.get("ifRev")).and_then(Value::as_f64);
            match data {
                Some(d) => drop(d, root, &rel, if_rev),
                None => Ok(json!({ "dropped": false })),
            }
        }
        _ => Err(coded("unknown_command", cmd)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("ose-drafts-{tag}-{stamp}-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn draft(text: &str, rev: u64) -> Value {
        json!({ "text": text, "baselineHash": "af63dc4c8601ec8c", "mode": "source", "exact": false, "rev": rev })
    }

    #[test]
    fn a_draft_round_trips_outside_the_vault() {
        let t = Tmp::new("round");
        let (data, root) = (t.0.join("appdata"), t.0.join("vault"));
        fs::create_dir_all(&root).unwrap();
        assert_eq!(read(&data, &root, "a.md"), Value::Null);
        assert_eq!(list(&data, &root), json!([]));

        let r = write(&data, &root, "notes/a.md", &draft("my text", 7), 1000).unwrap();
        assert_eq!(r, json!({ "at": 1000 }));
        let d = read(&data, &root, "/notes/a.md");
        assert_eq!(d["text"], "my text");
        assert_eq!(d["path"], "notes/a.md");
        assert_eq!(d["baselineHash"], "af63dc4c8601ec8c");
        assert_eq!(d["mode"], "source");
        assert_eq!(d["exact"], false);
        assert_eq!(d["rev"], 7);
        assert_eq!(d["at"], 1000);
        // Nothing of it is in the vault.
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);

        write(&data, &root, "b.md", &json!({ "text": "bee", "baselineHash": null, "rev": 1 }), 2000).unwrap();
        let l = list(&data, &root);
        let l = l.as_array().unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(l[0]["path"], "b.md", "newest first");
        assert_eq!(l[0]["bytes"], 3);
        assert_eq!(l[0]["baselineHash"], Value::Null);
        assert!(l[0].get("text").is_none());

        // Another vault sees none of them.
        let other = t.0.join("other");
        fs::create_dir_all(&other).unwrap();
        assert_eq!(list(&data, &other), json!([]));

        assert!(write(&data, &root, "c.md", &json!({ "rev": 1 }), 1).unwrap_err().starts_with("[bad_arg]"));
    }

    #[test]
    fn a_drop_with_if_rev_spares_newer_typing() {
        let t = Tmp::new("ifrev");
        let (data, root) = (t.0.join("appdata"), t.0.join("vault"));
        write(&data, &root, "a.md", &draft("v9", 9), 1).unwrap();
        assert_eq!(drop(&data, &root, "a.md", Some(8.0)).unwrap(), json!({ "dropped": false }));
        assert_eq!(read(&data, &root, "a.md")["text"], "v9");
        assert_eq!(drop(&data, &root, "a.md", Some(9.0)).unwrap(), json!({ "dropped": true }));
        assert_eq!(read(&data, &root, "a.md"), Value::Null);
        write(&data, &root, "a.md", &draft("v12", 12), 2).unwrap();
        assert_eq!(drop(&data, &root, "a.md", None).unwrap(), json!({ "dropped": true }));
        assert_eq!(drop(&data, &root, "a.md", None).unwrap(), json!({ "dropped": false }));
    }

    #[test]
    fn drafts_follow_a_rename() {
        let t = Tmp::new("rekey");
        let (data, root) = (t.0.join("appdata"), t.0.join("vault"));
        write(&data, &root, "notes/a.md", &draft("a", 1), 1).unwrap();
        write(&data, &root, "notes/sub/b.md", &draft("b", 1), 2).unwrap();
        write(&data, &root, "notes-x.md", &draft("x", 1), 3).unwrap();
        rekey_in(&data, &root, "notes", "archive/notes").unwrap();
        assert_eq!(read(&data, &root, "archive/notes/a.md")["text"], "a");
        assert_eq!(read(&data, &root, "archive/notes/sub/b.md")["path"], "archive/notes/sub/b.md");
        assert_eq!(read(&data, &root, "notes/a.md"), Value::Null);
        assert_eq!(read(&data, &root, "notes-x.md")["text"], "x", "a sibling with a longer name stays");
        rekey_in(&data, &root, "archive/notes/a.md", "a.md").unwrap();
        assert_eq!(read(&data, &root, "a.md")["text"], "a");
        assert_eq!(list(&data, &root).as_array().unwrap().len(), 3);
    }

    /// Only `<16 hex>.json` is a draft: a leftover set-aside or temp file in the folder is
    /// neither listed nor re-keyed.
    #[test]
    fn only_a_draft_name_is_a_draft() {
        let t = Tmp::new("names");
        let (data, root) = (t.0.join("appdata"), t.0.join("vault"));
        write(&data, &root, "a.md", &draft("real", 1), 1).unwrap();
        let file = file_for(&data, &root, "a.md");
        let stem = file.file_stem().unwrap().to_string_lossy().to_string();
        let copy = file.with_file_name(format!("{stem}.unsaved-20260925-101500.json"));
        fs::copy(&file, &copy).unwrap();
        assert_eq!(list(&data, &root).as_array().unwrap().len(), 1);
        rekey_in(&data, &root, "a.md", "b.md").unwrap();
        assert_eq!(read(&data, &root, "b.md")["text"], "real");
        assert!(copy.exists(), "not a draft, left alone");
        assert!(is_draft_name("0123456789abcdef.json"));
        assert!(!is_draft_name("0123456789ABCDEF.json"));
        assert!(!is_draft_name("0123456789abcdef.unsaved-1.json"));
    }

    /// A rename onto a path that already has a draft keeps both texts: the newer stays the
    /// draft, the older becomes a version of the new path.
    #[test]
    fn a_rename_onto_a_draft_keeps_both() {
        let t = Tmp::new("collide");
        let (data, root) = (t.0.join("appdata"), t.0.join("vault"));
        fs::create_dir_all(&root).unwrap();
        write(&data, &root, "gone.md", &draft("recovered", 1), 1).unwrap();
        write(&data, &root, "moving.md", &draft("typing", 1), 2).unwrap();
        rekey_in(&data, &root, "moving.md", "gone.md").unwrap();
        assert_eq!(read(&data, &root, "gone.md")["text"], "typing", "the newer is the draft");
        assert_eq!(read(&data, &root, "moving.md"), Value::Null);
        let versions = crate::versions::list(&root, "gone.md").unwrap();
        let id = versions[0]["id"].as_str().unwrap().to_string();
        assert_eq!(crate::versions::read(&root, "gone.md", &id).unwrap(), "recovered", "the older is a version");

        // The other way round: the moving draft is the older one.
        write(&data, &root, "old.md", &draft("older", 1), 3).unwrap();
        write(&data, &root, "new.md", &draft("newer", 1), 4).unwrap();
        rekey_in(&data, &root, "old.md", "new.md").unwrap();
        assert_eq!(read(&data, &root, "new.md")["text"], "newer");
        assert_eq!(read(&data, &root, "old.md"), Value::Null);
        let versions = crate::versions::list(&root, "new.md").unwrap();
        let id = versions[0]["id"].as_str().unwrap().to_string();
        assert_eq!(crate::versions::read(&root, "new.md", &id).unwrap(), "older");

        // No vault folder to keep a version in: both drafts stay.
        let lost = t.0.join("lost");
        write(&data, &lost, "x.md", &draft("x", 1), 5).unwrap();
        write(&data, &lost, "y.md", &draft("y", 1), 6).unwrap();
        rekey_in(&data, &lost, "y.md", "x.md").unwrap();
        assert_eq!(read(&data, &lost, "x.md")["text"], "x");
        assert_eq!(read(&data, &lost, "y.md")["text"], "y");
    }
}
