//! Versions (docs/HOST.md "Versions", H10): the previous bytes of a vault file, kept under
//! `.ose/history/<rel path>/` before a save replaces them, thinned by age.
//!
//! The file's own name is a folder, so `7-scratchpad/note.md` keeps its versions under
//! `.ose/history/7-scratchpad/note.md/`. Each version is `<id>.<tag>.<ext>`: the id is the UTC
//! time it was kept (`2026-09-10-201500`), the tag its reason (`save`, `conflict`, `reload`,
//! `restore`) with `-s` when it was the first version of that file this session, and the
//! extension the file's own, so a version of `data.json` opens as JSON. The names are this
//! module's business: the page only ever sees ids.
//!
//! Retention, per file, after every keep:
//!
//! - under an hour: every version;
//! - an hour to a day: the newest of each clock hour;
//! - a day to thirty days: the newest of each calendar day (UTC);
//! - older: nothing but the file's newest version;
//! - a session's first version and every version whose reason is not `save` stay thirty days
//!   whatever the thinning says;
//!
//! and across the vault at most 200 MB, the oldest evicted first, never a file's newest version
//! and never one younger than a day.
//!
//! The history follows a file: `rename` moves `.ose/history/<from>` to `<to>` (a file's folder
//! or a folder's whole subtree), merging when the target already has one. `.ose` is hidden from
//! the tree, so a version is never a page. Every write goes through `vault::write_atomic`.
//!
//! Before 1.1 the folder was `.ose/versions` and every version was `<id>.md`. The first use
//! renames the folder when `.ose/history` does not exist yet, and those names still read: an
//! old version is a `save` of this session's past, and its id is still valid.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::{arg_str, civil_from_days, coded, vault, Ctx};

/// Where every version lives, vault-relative.
const ROOT_DIR: &str = ".ose/history";
/// Where they lived before 1.1 (moved on first use).
const OLD_DIR: &str = ".ose/versions";

/// At most one version per file per minute, unless forced. A save inside the window keeps
/// nothing: the version before it already holds a state from under a minute ago.
const MIN_INTERVAL_MS: i64 = 60 * 1000;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;
const MONTH_MS: i64 = 30 * DAY_MS;

/// Per vault, oldest evicted first, never a file's newest and never anything under a day old.
const MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;

/// Why a version was kept. Everything but `Save` is a moment the user chose or was asked about,
/// and is kept a month whatever the thinning says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// the bytes a save replaced
    Save,
    /// "Keep mine" over a file changed on disk
    Conflict,
    /// the buffer, before "Reload from disk" or "Discard" threw it away
    Reload,
    /// the file, before a version was restored over it
    Restore,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Save => "save",
            Reason::Conflict => "conflict",
            Reason::Reload => "reload",
            Reason::Restore => "restore",
        }
    }

    pub fn parse(s: &str) -> Option<Reason> {
        match s {
            "save" => Some(Reason::Save),
            "conflict" => Some(Reason::Conflict),
            "reload" => Some(Reason::Reload),
            "restore" => Some(Reason::Restore),
            _ => None,
        }
    }
}

// ---- ids -------------------------------------------------------------------

/// `2026-09-10-201500`, UTC, from epoch milliseconds. It sorts, it is unique per file (a
/// second one in the same second moves on a second), and it is the time the version was kept.
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

/// The inverse of `id_from_ms`, to the second. A merge may have added `-<n>` after the time;
/// it is the same moment.
fn ms_from_id(id: &str) -> Option<i64> {
    let b = id.as_bytes();
    if b.len() < 17 {
        return None;
    }
    let num = |from: usize, to: usize| id.get(from..to)?.parse::<i64>().ok();
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hh, mm, ss) = (num(11, 13)?, num(13, 15)?, num(15, 17)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    Some((days_from_civil(y, m as u32, d as u32) * 86_400 + hh * 3600 + mm * 60 + ss) * 1000)
}

/// A civil date to days since the Unix epoch (Howard Hinnant's algorithm), the inverse of
/// `civil_from_days`.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// An id is a name we built: digits and hyphens only. Anything else could climb out of the
/// history folder, so it is refused before it ever reaches the filesystem.
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err(coded("bad_arg", format!("not a version id: {id}")));
    }
    Ok(())
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- names -----------------------------------------------------------------

/// The extension of the last segment of a vault path, without the dot; empty for none and for
/// a dotfile such as `.env`.
fn ext_of(rel: &str) -> String {
    let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_string(),
        _ => String::new(),
    }
}

/// `<id>.<reason>[-s][.<ext>]`.
fn file_name(id: &str, reason: Reason, session: bool, ext: &str) -> String {
    let s = if session { "-s" } else { "" };
    if ext.is_empty() {
        format!("{id}.{}{s}", reason.as_str())
    } else {
        format!("{id}.{}{s}.{ext}", reason.as_str())
    }
}

/// A version file's id, reason and session flag, or `None` when the name is not one of ours.
/// `<id>.md` is the pre-1.1 name, read as a `save` that was not a session's first.
fn parse_name(name: &str) -> Option<(String, Reason, bool)> {
    let (id, rest) = name.split_once('.')?;
    check_id(id).ok()?;
    // `<id>.save.unsaved-<stamp>.md` is the copy `write_atomic` set aside when a version's own
    // rename never went through: the same id as a real version would list it twice.
    if rest.contains(".unsaved-") {
        return None;
    }
    let tag = rest.split_once('.').map(|(t, _)| t).unwrap_or(rest);
    let (tag, session) = match tag.strip_suffix("-s") {
        Some(t) => (t, true),
        None => (tag, false),
    };
    match Reason::parse(tag) {
        Some(reason) => Some((id.to_string(), reason, session)),
        None if rest.eq_ignore_ascii_case("md") => Some((id.to_string(), Reason::Save, false)),
        None => None,
    }
}

// ---- paths -----------------------------------------------------------------

/// The pre-1.1 folder becomes the new one, once, when there is no new one yet. Old ids stay
/// valid, because `parse_name` still reads `<id>.md`.
fn migrate(root: &Path) {
    let old = root.join(OLD_DIR);
    let new = root.join(ROOT_DIR);
    if old.is_dir() && !new.exists() {
        if let Err(e) = fs::rename(&old, &new) {
            eprintln!("history: could not move .ose/versions to .ose/history: {e}");
        }
    }
}

/// The folder holding the versions of `rel`. `vault::resolve` does the containment, so a `..`
/// in the page path can never reach outside `.ose/history`.
fn dir_for(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let cleaned = rel.replace('\\', "/");
    let cleaned = cleaned.trim().trim_start_matches('/');
    if cleaned.is_empty() {
        return Err(coded("bad_arg", "a version needs a file"));
    }
    let base = vault::resolve(root, ROOT_DIR)?;
    let full = vault::resolve(root, &format!("{ROOT_DIR}/{cleaned}"))?;
    // `resolve` only promises the vault. `.ose/history/../pages` is inside the vault and
    // outside the history, so the containment is checked here as well.
    if !full.starts_with(&base) || full == base {
        return Err(coded("escapes_vault", format!("path escapes the version history: {rel}")));
    }
    Ok(full)
}

// ---- listing ---------------------------------------------------------------

/// One version on disk.
#[derive(Clone, Debug)]
struct Entry {
    id: String,
    at: i64,
    bytes: u64,
    reason: Reason,
    session: bool,
    path: PathBuf,
}

fn entries_in(dir: &Path) -> Vec<Entry> {
    let mut out = Vec::new();
    let Ok(read) = fs::read_dir(dir) else {
        return out;
    };
    for e in read.flatten() {
        let path = e.path();
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let Some((id, reason, session)) = parse_name(&name) else { continue };
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let at = ms_from_id(&id).unwrap_or_else(|| {
            meta.modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });
        out.push(Entry { id, at, bytes: meta.len(), reason, session, path });
    }
    // Newest first, by id, which is the time: a clock that jumps must not shuffle the history.
    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

/// The versions of `rel`, newest first. A missing folder is an empty list, never an error.
fn entries(root: &Path, rel: &str) -> Result<Vec<Entry>, String> {
    Ok(entries_in(&dir_for(root, rel)?))
}

fn to_json(list: &[Entry]) -> Value {
    Value::Array(
        list.iter()
            .map(|e| {
                json!({
                    "id": e.id,
                    "at": e.at,
                    "bytes": e.bytes,
                    "reason": e.reason.as_str(),
                    "session": e.session,
                })
            })
            .collect(),
    )
}

// ---- retention -------------------------------------------------------------

/// Which versions of one file survive at `now` (docs/HOST.md "Versions"). `list` is newest
/// first; the answer is parallel to it.
fn survivors(list: &[Entry], now: i64) -> Vec<bool> {
    let mut keep = vec![false; list.len()];
    let mut hours: HashSet<i64> = HashSet::new();
    let mut days: HashSet<i64> = HashSet::new();
    for (i, e) in list.iter().enumerate() {
        let age = now - e.at;
        let protected = e.session || e.reason != Reason::Save;
        // The newest, anything under an hour, and a protected one under a month: always.
        keep[i] = if i == 0 || age < HOUR_MS || (protected && age < MONTH_MS) {
            true
        } else if age < DAY_MS {
            hours.insert(e.at.div_euclid(HOUR_MS))
        } else if age < MONTH_MS {
            days.insert(e.at.div_euclid(DAY_MS))
        } else {
            false
        };
    }
    keep
}

fn prune_file(root: &Path, rel: &str, now: i64) {
    let Ok(list) = entries(root, rel) else { return };
    for (e, keep) in list.iter().zip(survivors(&list, now)) {
        if !keep {
            let _ = fs::remove_file(&e.path);
        }
    }
}

/// Every version file under `dir`, with the folder it belongs to.
fn walk_all(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, Entry)>) {
    if depth > 32 {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut here = false;
    for e in read.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            walk_all(&e.path(), depth + 1, out);
        } else {
            here = true;
        }
    }
    if here {
        for e in entries_in(dir) {
            out.push((dir.to_path_buf(), e));
        }
    }
}

/// Hold the whole vault's history under `MAX_TOTAL_BYTES`: the oldest version goes first,
/// never the newest a file has and never one younger than a day. Answers the bytes left.
fn prune_vault(root: &Path, now: i64) -> u64 {
    let Ok(base) = vault::resolve(root, ROOT_DIR) else {
        return 0;
    };
    let mut all = Vec::new();
    walk_all(&base, 0, &mut all);
    let mut total: u64 = all.iter().map(|(_, e)| e.bytes).sum();
    if total <= MAX_TOTAL_BYTES {
        return total;
    }
    let mut newest: std::collections::HashMap<PathBuf, String> = std::collections::HashMap::new();
    for (dir, e) in &all {
        let n = newest.entry(dir.clone()).or_insert_with(|| e.id.clone());
        if e.id > *n {
            *n = e.id.clone();
        }
    }
    all.sort_by(|a, b| a.1.id.cmp(&b.1.id));
    for (dir, e) in &all {
        if total <= MAX_TOTAL_BYTES {
            break;
        }
        if newest.get(dir) == Some(&e.id) || now - e.at < DAY_MS {
            continue;
        }
        if fs::remove_file(&e.path).is_ok() {
            total = total.saturating_sub(e.bytes);
        }
    }
    total
}

/// Each vault's history size as last walked, plus every version kept since. Only ever too
/// high (a version removed by thinning or by hand is still counted), so a walk is skipped only
/// when the history is surely under the cap.
static TOTALS: Mutex<Option<std::collections::HashMap<PathBuf, u64>>> = Mutex::new(None);

fn grew(root: &Path, bytes: u64) {
    let mut guard = TOTALS.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(t) = guard.get_or_insert_with(Default::default).get_mut(root) {
        *t = t.saturating_add(bytes);
    }
}

/// `prune_vault`, but only when the running total says the cap may be exceeded: the walk reads
/// every file under `.ose/history`, and a keep happens on every save. The first call of a run
/// walks once to learn the total.
fn prune_vault_if_over(root: &Path, now: i64) {
    let known = TOTALS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_or_insert_with(Default::default)
        .get(root)
        .copied();
    if matches!(known, Some(t) if t <= MAX_TOTAL_BYTES) {
        return;
    }
    let left = prune_vault(root, now);
    TOTALS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_or_insert_with(Default::default)
        .insert(root.to_path_buf(), left);
}

/// The vault-wide cap, for a caller that kept a version with `keep_now` under a file's lock and
/// has let go of it.
pub(crate) fn settle(root: &Path) {
    prune_vault_if_over(root, now_ms());
}

// ---- keeping ---------------------------------------------------------------

/// Which files have had a version kept in this process: the first one of each is the state the
/// file had before this session changed it, and is marked so.
static SESSION: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn session_key(root: &Path, rel: &str) -> String {
    format!("{}|{}", root.display(), rel.replace('\\', "/").trim_start_matches('/'))
}

/// Keep `bytes` as a version of `rel` (now), then hold the vault under its cap. See `keep_at`.
pub fn keep(root: &Path, rel: &str, bytes: &[u8], force: bool, reason: Reason) -> Result<Value, String> {
    let now = now_ms();
    let r = keep_at(root, rel, bytes, force, reason, now);
    prune_vault_if_over(root, now);
    r
}

/// `keep` without the vault-wide cap, for a caller holding a file's lock: it calls `settle`
/// once it has let go, so the walk of the whole history never runs under that lock.
pub(crate) fn keep_now(root: &Path, rel: &str, bytes: &[u8], force: bool, reason: Reason) -> Result<Value, String> {
    keep_at(root, rel, bytes, force, reason, now_ms())
}

/// Keep `bytes` as a version of `rel` at `now`. Nothing is written when the bytes are empty,
/// when the newest version already holds exactly these bytes, or (unless `force`) when the
/// newest version is under a minute old. Answers `{kept, id}`. One keep of a file at a time
/// (the lock of its history folder), so two keeps in the same second cannot pick the same id.
pub(crate) fn keep_at(
    root: &Path,
    rel: &str,
    bytes: &[u8],
    force: bool,
    reason: Reason,
    now: i64,
) -> Result<Value, String> {
    migrate(root);
    if bytes.is_empty() {
        return Ok(json!({ "kept": false, "id": null }));
    }
    vault::require_vault(root)?;
    let dir = dir_for(root, rel)?;
    let lock = crate::files::lock_for(&dir);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let list = entries_in(&dir);
    if let Some(newest) = list.first() {
        if fs::read(&newest.path).ok().as_deref() == Some(bytes) {
            return Ok(json!({ "kept": false, "id": null }));
        }
        if !force && now.saturating_sub(newest.at) < MIN_INTERVAL_MS {
            return Ok(json!({ "kept": false, "id": null }));
        }
    }

    let key = session_key(root, rel);
    let session = {
        let guard = SESSION.lock().unwrap_or_else(|p| p.into_inner());
        !guard.as_ref().map(|s| s.contains(&key)).unwrap_or(false)
    };

    // A second version in the same second must not land on the id already taken.
    let mut ms = now;
    let mut id = id_from_ms(ms);
    while list.iter().any(|e| e.id == id) {
        ms += 1000;
        id = id_from_ms(ms);
    }
    let full = dir.join(file_name(&id, reason, session, &ext_of(rel)));
    vault::ensure_parent(root, &full)?;
    vault::write_atomic(&full, bytes).map_err(|f| f.message(&format!("version of {rel}"), Some(root)))?;
    grew(root, bytes.len() as u64);
    SESSION
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_or_insert_with(Default::default)
        .insert(key);

    prune_file(root, rel, now);
    Ok(json!({ "kept": true, "id": id }))
}

pub fn list(root: &Path, rel: &str) -> Result<Value, String> {
    migrate(root);
    Ok(to_json(&entries(root, rel)?))
}

fn find(root: &Path, rel: &str, id: &str) -> Result<Entry, String> {
    check_id(id)?;
    entries(root, rel)?
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| coded("not_found", format!("no version {id} of {rel}")))
}

/// A version is a copy of the file's own bytes, so it comes back exactly as it went in, a
/// byte-order mark included (F14: `vault::read_text` keeps it too, and `doc.js` owns it).
pub fn read(root: &Path, rel: &str, id: &str) -> Result<String, String> {
    migrate(root);
    let e = find(root, rel, id)?;
    let bytes = fs::read(&e.path).map_err(|err| crate::io_error(&format!("version {id} of {rel}"), &err))?;
    String::from_utf8(bytes).map_err(|_| coded("not_utf8", format!("not valid UTF-8: version {id} of {rel}")))
}

/// The current bytes become a version (always, reason `restore`: this is the one moment losing
/// them would be the user's own doing), then the chosen version is written over the file,
/// atomically. Answers `{kept, id, hash}`, the id being the version just kept and the hash the
/// file's new one.
///
/// Only `NotFound` means "there is nothing to keep". Every other read error (a file locked by a
/// sync client, a transient EBUSY) is a file whose content this process cannot see, and writing
/// the old version over it would destroy bytes no version holds. The restore fails instead, and
/// the file is left exactly as it was. Bytes that are not UTF-8 are still bytes, and are kept.
pub fn restore(root: &Path, rel: &str, id: &str) -> Result<Value, String> {
    migrate(root);
    let entry = find(root, rel, id)?;
    let text = fs::read(&entry.path).map_err(|e| crate::io_error(&format!("version {id} of {rel}"), &e))?;
    let full = vault::resolve(root, rel)?;
    vault::require_vault(root)?;
    // The file's own lock, the one `saveFile` takes: a save cannot land between the read of the
    // current bytes and the write of the restored ones.
    let lock = crate::files::lock_for(&full);
    let held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let current = match fs::read(&full) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(crate::io_error(rel, &e)),
    };
    let mut kept = if current.is_empty() || current == text {
        json!({ "kept": false, "id": null })
    } else {
        keep_now(root, rel, &current, true, Reason::Restore)?
    };
    vault::ensure_parent(root, &full)?;
    vault::write_atomic(&full, &text).map_err(|f| f.message(rel, Some(root)))?;
    drop(held);
    settle(root);
    kept["hash"] = json!(vault::hash(&text));
    Ok(kept)
}

// ---- following a rename ----------------------------------------------------

/// `rename(from, to)` for the history: `.ose/history/<from>` becomes `.ose/history/<to>`, a
/// file's folder of versions or a folder's whole subtree, merged into what is already there.
/// Nothing to move is not an error.
pub fn move_history(root: &Path, from: &str, to: &str) -> Result<(), String> {
    migrate(root);
    let hidden = |p: &str| p.replace('\\', "/").split('/').any(vault::is_hidden);
    if hidden(from) || hidden(to) {
        return Ok(());
    }
    let src = dir_for(root, from)?;
    let dst = dir_for(root, to)?;
    if !src.exists() || src == dst {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| coded("io", format!("{}: {e}", parent.display())))?;
    }
    // A case-only rename is the same folder on Windows and a default macOS volume: through a
    // temporary name, never mistaken for a merge into itself.
    if vault::case_only(&src, &dst) {
        let via = src.with_file_name(format!(".{}.{}.move", from.len(), std::process::id()));
        fs::rename(&src, &via).map_err(|e| coded("io", format!("history {from}: {e}")))?;
        return fs::rename(&via, &dst).map_err(|e| {
            let _ = fs::rename(&via, &src);
            coded("io", format!("history {from} -> {to}: {e}"))
        });
    }
    if !dst.exists() {
        return fs::rename(&src, &dst).map_err(|e| coded("io", format!("history {from} -> {to}: {e}")));
    }
    merge(&src, &dst);
    let _ = fs::remove_dir(&src);
    Ok(())
}

/// Every entry of `src` into `dst`. A version whose name is taken gets `-<n>` after its id,
/// which keeps its time and its reason.
fn merge(src: &Path, dst: &Path) {
    let Ok(read) = fs::read_dir(src) else { return };
    for e in read.flatten() {
        let from = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let target = dst.join(&name);
        let is_dir = e.metadata().map(|m| m.is_dir()).unwrap_or(false);
        if !target.exists() {
            let _ = fs::rename(&from, &target);
            continue;
        }
        if is_dir {
            merge(&from, &target);
            let _ = fs::remove_dir(&from);
            continue;
        }
        let (id, rest) = name.split_once('.').unwrap_or((&name, ""));
        for n in 1..1000 {
            let free = dst.join(format!("{id}-{n}.{rest}"));
            if !free.exists() {
                let _ = fs::rename(&from, &free);
                break;
            }
        }
    }
}

// ---- dispatch --------------------------------------------------------------

const COMMANDS: &[&str] = &["versionKeep", "versionList", "versionRead", "versionRestore"];

/// `None` means "not mine", like every module handler.
pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if !COMMANDS.contains(&cmd) {
        return None;
    }
    let root = match crate::root_for(ctx.st, cmd, args) {
        Ok(r) => r,
        Err(e) => return Some(Err(e)),
    };
    Some(dispatch(&root, cmd, args))
}

fn dispatch(root: &Path, cmd: &str, args: &[Value]) -> Result<Value, String> {
    match cmd {
        // `versionKeep(path, text, opts)`, where `opts` is the old boolean `force` or
        // `{ force?, reason? }`.
        "versionKeep" => {
            let (force, reason) = match args.get(2) {
                Some(Value::Bool(b)) => (*b, Reason::Save),
                Some(Value::Object(o)) => {
                    let force = o.get("force").and_then(Value::as_bool).unwrap_or(false);
                    let reason = match o.get("reason").and_then(Value::as_str) {
                        None => Reason::Save,
                        Some(r) => Reason::parse(r).ok_or_else(|| coded("bad_arg", format!("not a version reason: {r}")))?,
                    };
                    (force, reason)
                }
                _ => (false, Reason::Save),
            };
            keep(root, &arg_str(args, 0)?, arg_str(args, 1)?.as_bytes(), force, reason)
        }
        "versionList" => list(root, &arg_str(args, 0)?),
        "versionRead" => Ok(Value::String(read(root, &arg_str(args, 0)?, &arg_str(args, 1)?)?)),
        "versionRestore" => restore(root, &arg_str(args, 0)?, &arg_str(args, 1)?),
        _ => Err(coded("unknown_command", cmd)),
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

    /// Put a version on disk at a chosen time, bypassing every rule.
    fn plant(root: &Path, rel: &str, at: i64, reason: Reason, session: bool, text: &str) -> String {
        let dir = dir_for(root, rel).unwrap();
        fs::create_dir_all(&dir).unwrap();
        let id = id_from_ms(at);
        fs::write(dir.join(file_name(&id, reason, session, &ext_of(rel))), text).unwrap();
        id
    }

    /// 2026-09-25 12:00:00 UTC, the clock the retention tests run on.
    const NOW: i64 = 1_790_337_600_000;

    #[test]
    fn an_id_is_a_utc_timestamp_and_reads_back() {
        assert_eq!(id_from_ms(0), "1970-01-01-000000");
        // 2025-09-10 20:15:00 UTC
        assert_eq!(id_from_ms(1_757_535_300_000), "2025-09-10-201500");
        assert_eq!(ms_from_id("2025-09-10-201500"), Some(1_757_535_300_000));
        assert_eq!(ms_from_id("2025-09-10-201500-2"), Some(1_757_535_300_000));
        assert_eq!(ms_from_id(&id_from_ms(NOW)), Some(NOW));
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
        assert!(check_id("2026-09-10-201500").is_ok());
        assert!(check_id("../../etc/passwd").is_err());
        assert!(check_id("").is_err());
    }

    #[test]
    fn a_name_carries_the_reason_the_session_and_the_extension() {
        assert_eq!(file_name("2026-01-01-000000", Reason::Save, false, "md"), "2026-01-01-000000.save.md");
        assert_eq!(file_name("2026-01-01-000000", Reason::Conflict, true, ""), "2026-01-01-000000.conflict-s");
        assert_eq!(
            parse_name("2026-01-01-000000.restore-s.json"),
            Some(("2026-01-01-000000".into(), Reason::Restore, true))
        );
        // The pre-1.1 name still reads.
        assert_eq!(parse_name("2026-01-01-000000.md"), Some(("2026-01-01-000000".into(), Reason::Save, false)));
        assert_eq!(parse_name("notes.md"), None);
        assert_eq!(parse_name(".2026-01-01-000000.save.md.123.0.tmp"), None);
        assert_eq!(parse_name("2026-01-01-000000.save.unsaved-20260101-000000.md"), None, "a set-aside is not a version");
        assert_eq!(ext_of("a/b/data.json"), "json");
        assert_eq!(ext_of("a/.env"), "");
        assert_eq!(ext_of("README"), "");
    }

    #[test]
    fn a_version_lands_under_the_file_name_and_keeps_its_extension() {
        let t = Tmp::new("keep");
        let root = &t.0;
        let r = keep(root, "notes/data.json", b"{}\n", false, Reason::Save).unwrap();
        assert_eq!(r["kept"], json!(true));
        let dir = root.join(".ose").join("history").join("notes").join("data.json");
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 1);
        assert!(names[0].ends_with(".json"), "the extension is kept: {names:?}");
        let listed = list(root, "notes/data.json").unwrap();
        assert_eq!(listed[0]["reason"], "save");
        assert_eq!(listed[0]["session"], json!(true), "the first keep of this process is the session's");
        let id = listed[0]["id"].as_str().unwrap().to_string();
        assert_eq!(read(root, "notes/data.json", &id).unwrap(), "{}\n");

        // The second keep of the same file is not the session's first.
        let r = keep_at(root, "notes/data.json", b"[]\n", true, Reason::Conflict, now_ms() + 5000).unwrap();
        assert_eq!(r["kept"], json!(true));
        let listed = list(root, "notes/data.json").unwrap();
        assert_eq!(listed[0]["reason"], "conflict");
        assert_eq!(listed[0]["session"], json!(false));
    }

    #[test]
    fn one_version_a_minute_unless_forced() {
        let t = Tmp::new("interval");
        let root = &t.0;
        assert_eq!(keep_at(root, "a.md", b"one", false, Reason::Save, NOW).unwrap()["kept"], json!(true));
        assert_eq!(keep_at(root, "a.md", b"two", false, Reason::Save, NOW + 30_000).unwrap()["kept"], json!(false));
        assert_eq!(count(root, "a.md"), 1);
        assert_eq!(keep_at(root, "a.md", b"two", true, Reason::Save, NOW + 30_000).unwrap()["kept"], json!(true));
        assert_eq!(count(root, "a.md"), 2);
        // A minute on, a plain save keeps again.
        assert_eq!(keep_at(root, "a.md", b"three", false, Reason::Save, NOW + 91_000).unwrap()["kept"], json!(true));
        // The same bytes are never kept twice, forced or not.
        assert_eq!(keep_at(root, "a.md", b"three", true, Reason::Save, NOW + 200_000).unwrap()["kept"], json!(false));
        // Empty bytes are nothing to keep.
        assert_eq!(keep_at(root, "a.md", b"", true, Reason::Save, NOW + 300_000).unwrap()["kept"], json!(false));
    }

    #[test]
    fn retention_thins_by_hour_then_by_day_then_drops() {
        let t = Tmp::new("tiers");
        let root = &t.0;
        let rel = "p.md";
        let min = 60_000;
        // Under an hour: all three stay.
        let recent: Vec<String> = [5, 20, 40].iter().map(|m| plant(root, rel, NOW - m * min, Reason::Save, false, &format!("r{m}"))).collect();
        // 3 h ago, two in the same clock hour (10:05 and 10:40 on a 12:00 clock): the newer stays.
        let h_old = plant(root, rel, NOW - 115 * min, Reason::Save, false, "h-old");
        let h_new = plant(root, rel, NOW - 80 * min, Reason::Save, false, "h-new");
        // 3 days ago, two on the same day: the newer stays.
        let d_old = plant(root, rel, NOW - 3 * DAY_MS - 5 * HOUR_MS, Reason::Save, false, "d-old");
        let d_new = plant(root, rel, NOW - 3 * DAY_MS - 2 * HOUR_MS, Reason::Save, false, "d-new");
        // 40 days ago: gone.
        let ancient = plant(root, rel, NOW - 40 * DAY_MS, Reason::Save, false, "ancient");
        // Protected: a session's first and a conflict, both in a thinned hour and day.
        let sess = plant(root, rel, NOW - 116 * min, Reason::Save, true, "session");
        let conflict = plant(root, rel, NOW - 3 * DAY_MS - 6 * HOUR_MS, Reason::Conflict, false, "conflict");
        // …but not past thirty days.
        let old_conflict = plant(root, rel, NOW - 31 * DAY_MS, Reason::Conflict, false, "old-conflict");

        prune_file(root, rel, NOW);
        let left: HashSet<String> = entries(root, rel).unwrap().into_iter().map(|e| e.id).collect();
        for id in recent.iter().chain([&h_new, &d_new, &sess, &conflict]) {
            assert!(left.contains(id), "{id} should stay: {left:?}");
        }
        for id in [&h_old, &d_old, &ancient, &old_conflict] {
            assert!(!left.contains(id), "{id} should go: {left:?}");
        }
    }

    #[test]
    fn a_file_always_keeps_its_newest_version() {
        let t = Tmp::new("newest");
        let root = &t.0;
        let only = plant(root, "q.md", NOW - 400 * DAY_MS, Reason::Save, false, "last");
        prune_file(root, "q.md", NOW);
        assert_eq!(entries(root, "q.md").unwrap()[0].id, only);
    }

    #[test]
    fn the_vault_cap_spares_the_newest_and_the_young() {
        let t = Tmp::new("vault-cap");
        let root = &t.0;
        let big = "x".repeat(5 * 1024 * 1024);
        // 30 files × 2 old versions × 5 MB = 300 MB, over the 200 MB cap.
        for i in 0..30 {
            let rel = format!("page-{i}.md");
            plant(root, &rel, NOW - 10 * DAY_MS, Reason::Save, false, &big);
            plant(root, &rel, NOW - 5 * DAY_MS, Reason::Save, false, &big);
        }
        // Young versions of one more file, over nothing.
        plant(root, "young.md", NOW - 2 * HOUR_MS, Reason::Save, false, &big);
        plant(root, "young.md", NOW - HOUR_MS / 2, Reason::Save, false, &big);
        prune_vault(root, NOW);
        let mut total = 0u64;
        for i in 0..30 {
            let list = entries(root, &format!("page-{i}.md")).unwrap();
            assert!(!list.is_empty(), "every file keeps its newest version");
            total += list.iter().map(|e| e.bytes).sum::<u64>();
        }
        assert_eq!(count(root, "young.md"), 2, "nothing under a day old is evicted");
        assert!(total <= MAX_TOTAL_BYTES, "under the cap: {total}");
    }

    #[test]
    fn the_old_folder_moves_and_its_ids_still_read() {
        let t = Tmp::new("migrate");
        let root = &t.0;
        let old = root.join(".ose").join("versions").join("c.md");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("2026-01-01-000000.md"), "# then\n").unwrap();
        let listed = list(root, "c.md").unwrap();
        assert_eq!(listed[0]["id"], "2026-01-01-000000");
        assert_eq!(listed[0]["reason"], "save");
        assert!(root.join(".ose").join("history").join("c.md").is_dir());
        assert!(!root.join(".ose").join("versions").exists());
        assert_eq!(read(root, "c.md", "2026-01-01-000000").unwrap(), "# then\n");
    }

    #[test]
    fn restore_keeps_the_current_bytes_first() {
        let t = Tmp::new("restore");
        let root = &t.0;
        fs::write(root.join("c.md"), "# now\n").unwrap();
        let then = plant(root, "c.md", NOW - DAY_MS, Reason::Save, false, "# then\n");
        let r = restore(root, "c.md", &then).unwrap();
        assert_eq!(r["kept"], json!(true), "the bytes being replaced are kept");
        assert_eq!(r["hash"], json!(vault::hash(b"# then\n")));
        assert_eq!(fs::read_to_string(root.join("c.md")).unwrap(), "# then\n");
        let listed = entries(root, "c.md").unwrap();
        assert_eq!(listed[0].reason, Reason::Restore);
        assert_eq!(read(root, "c.md", &listed[0].id).unwrap(), "# now\n");
        assert!(restore(root, "c.md", "2020-01-01-000000").unwrap_err().starts_with("[not_found]"));
    }

    /// Bytes that are not UTF-8 are still the file's bytes: they are kept before the restore
    /// rather than refused, and the version holds them exactly.
    #[test]
    fn restore_keeps_bytes_that_are_not_text() {
        let t = Tmp::new("restore-bytes");
        let root = &t.0;
        let raw: &[u8] = &[0xff, 0xfe, 0x00, 0x41];
        fs::write(root.join("d.md"), raw).unwrap();
        let then = plant(root, "d.md", NOW - DAY_MS, Reason::Save, false, "# then\n");
        restore(root, "d.md", &then).unwrap();
        let listed = entries(root, "d.md").unwrap();
        assert_eq!(fs::read(&listed[0].path).unwrap(), raw);

        // A file that is not there at all is nothing to keep, and the restore goes through.
        let e = plant(root, "e.md", NOW - DAY_MS, Reason::Save, false, "# then\n");
        let r = restore(root, "e.md", &e).unwrap();
        assert_eq!(r["kept"], json!(false));
        assert_eq!(fs::read_to_string(root.join("e.md")).unwrap(), "# then\n");
    }

    /// F3: a file this process cannot read holds bytes no version has, so the restore fails
    /// and writes nothing.
    #[cfg(windows)]
    #[test]
    fn restore_refuses_a_file_it_cannot_read() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = Tmp::new("restore-locked");
        let root = &t.0;
        fs::write(root.join("f.md"), "# mine\n").unwrap();
        let then = plant(root, "f.md", NOW - DAY_MS, Reason::Save, false, "# then\n");
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(root.join("f.md")).unwrap();
        assert!(restore(root, "f.md", &then).is_err());
        drop(lock);
        assert_eq!(fs::read_to_string(root.join("f.md")).unwrap(), "# mine\n");
        assert_eq!(count(root, "f.md"), 1, "and nothing was kept");
    }

    /// F14: a version is the file's own bytes, mark and all, so a restore puts the mark back.
    #[test]
    fn a_version_keeps_the_byte_order_mark() {
        let t = Tmp::new("bom");
        let root = &t.0;
        let with_bom = "\u{feff}# one\n";
        fs::write(root.join("f.md"), "# two\n").unwrap();
        let r = keep(root, "f.md", with_bom.as_bytes(), true, Reason::Save).unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        assert_eq!(read(root, "f.md", &id).unwrap(), with_bom);
        restore(root, "f.md", &id).unwrap();
        assert_eq!(fs::read(root.join("f.md")).unwrap(), b"\xEF\xBB\xBF# one\n");
    }

    #[test]
    fn a_version_never_escapes_the_history() {
        let t = Tmp::new("escape");
        let root = &t.0;
        assert!(dir_for(root, "../outside.md").is_err());
        assert!(read(root, "c.md", "../../../secret").is_err());
        assert!(dir_for(root, "").is_err());
    }

    #[test]
    fn the_history_moves_with_a_file_and_with_a_folder() {
        let t = Tmp::new("move");
        let root = &t.0;
        let a = plant(root, "notes/a.md", NOW - DAY_MS, Reason::Save, false, "a1");
        move_history(root, "notes/a.md", "notes/b.md").unwrap();
        assert_eq!(count(root, "notes/a.md"), 0);
        assert_eq!(read(root, "notes/b.md", &a).unwrap(), "a1");

        // A folder moves its whole subtree.
        plant(root, "notes/c.md", NOW - DAY_MS, Reason::Save, false, "c1");
        move_history(root, "notes", "archive/notes").unwrap();
        assert_eq!(count(root, "archive/notes/b.md"), 1);
        assert_eq!(count(root, "archive/notes/c.md"), 1);
        assert!(!root.join(".ose/history/notes").exists());

        // Onto a file that already has a history: merged, and a taken id moves aside.
        let x = plant(root, "x.md", NOW - DAY_MS, Reason::Save, false, "x-old");
        plant(root, "y.md", NOW - DAY_MS, Reason::Save, false, "y-same-second");
        plant(root, "y.md", NOW - 2 * DAY_MS, Reason::Save, false, "y-older");
        move_history(root, "y.md", "x.md").unwrap();
        let merged = entries(root, "x.md").unwrap();
        assert_eq!(merged.len(), 3, "{merged:?}");
        assert_eq!(read(root, "x.md", &x).unwrap(), "x-old");
        assert!(merged.iter().any(|e| e.id == format!("{x}-1")));

        // Case only: the same folder on Windows and macOS, never a merge into itself.
        plant(root, "Case.md", NOW - DAY_MS, Reason::Save, false, "c");
        move_history(root, "Case.md", "case.md").unwrap();
        assert_eq!(count(root, "case.md"), 1);

        // Nothing to move is not an error.
        move_history(root, "none.md", "other.md").unwrap();
    }

    /// Two keeps of one file in the same second, from two threads: two versions, two ids.
    #[test]
    fn keeps_in_the_same_second_never_share_an_id() {
        let t = Tmp::new("same-second");
        let root = t.0.clone();
        let handles: Vec<_> = (0..4)
            .map(|i| {
                let root = root.clone();
                std::thread::spawn(move || {
                    keep_at(&root, "a.md", format!("text {i}").as_bytes(), true, Reason::Reload, NOW).unwrap()
                })
            })
            .collect();
        let ids: HashSet<String> = handles
            .into_iter()
            .map(|h| h.join().unwrap()["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids.len(), 4);
        assert_eq!(count(&root, "a.md"), 4);
    }
}
