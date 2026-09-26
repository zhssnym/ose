//! The trash (docs/HOST.md "Trash", M18): `trash`, `trashWhere`, `trashList`, `trashRestore`.
//!
//! Nothing is ever deleted outright. A path goes to the system's bin (the Recycle Bin, the
//! macOS Trash, the freedesktop trash) or, when the user chose it, when the volume has no bin,
//! or when the system refuses, to `.trash` inside the vault. Either way the answer says where
//! it went and gives an id `trashRestore` takes back:
//!
//! - `vault:<entry>` for `.trash/<stamp>-<name>`. A sidecar `.trash/.info/<entry>.json` holds
//!   the original vault path and the time, so a restore puts it back where it was. An item
//!   trashed before the sidecars existed restores to its name at the vault root.
//! - `system:<seconds>:<vault path>` for the system bin on Windows and Linux: the moment just
//!   before the delete and the path it had, matched against `trash::os_limited::list()` when it
//!   is restored (the first item deleted from that path at or after that moment). A bin item's
//!   path is its original folder, under either spelling of the root, plus its real name, never
//!   the display name the Recycle Bin shows (`item_rel`). The macOS
//!   Trash cannot be read back by an app, so its id is `null` and the item is restored from the
//!   Finder, not from here.
//!
//! The id format is the host's business: the page carries the string and never parses it.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::{coded, vault};

/// The vault bin and its sidecars.
const BIN: &str = ".trash";
const INFO: &str = ".info";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `f` on a thread of its own. The shell's bin goes through COM, which wants an apartment of
/// its own: one already initialised differently on a tokio worker makes the shell refuse.
fn on_own_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    std::thread::spawn(f)
        .join()
        .map_err(|_| coded("io", "the trash thread panicked"))
}

// ---- where a path would go -------------------------------------------------

/// Does the volume holding `full` have a bin the system will put things in? Windows: a
/// removable or network drive has none, and neither has a volume `SHQueryRecycleBinW` cannot
/// answer for; there the shell would delete for good, so the vault bin is used instead.
#[cfg(windows)]
pub fn has_bin(full: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt as _;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetVolumePathNameW(file: *const u16, out: *mut u16, len: u32) -> i32;
        fn GetDriveTypeW(root: *const u16) -> u32;
    }
    #[repr(C)]
    struct ShQueryRbInfo {
        cb_size: u32,
        i64_size: i64,
        i64_num_items: i64,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHQueryRecycleBinW(root: *const u16, info: *mut ShQueryRbInfo) -> i32;
    }
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_REMOTE: u32 = 4;

    let wide: Vec<u16> = full.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut volume = vec![0u16; 1024];
    // Safe: the input is NUL-terminated, the output buffer's length is passed, and the info
    // struct is ours with its size set, as the API asks.
    unsafe {
        if GetVolumePathNameW(wide.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) == 0 {
            return false;
        }
        let kind = GetDriveTypeW(volume.as_ptr());
        if kind == DRIVE_REMOVABLE || kind == DRIVE_REMOTE {
            return false;
        }
        let mut info = ShQueryRbInfo {
            cb_size: std::mem::size_of::<ShQueryRbInfo>() as u32,
            i64_size: 0,
            i64_num_items: 0,
        };
        SHQueryRecycleBinW(volume.as_ptr(), &mut info) == 0
    }
}

/// macOS and Linux: the system's own call says no when there is no trash, and that refusal is
/// what sends the path to the vault bin.
#[cfg(not(windows))]
pub fn has_bin(_full: &Path) -> bool {
    true
}

/// The user's choice, `settings.trash` in the vault's state (`'vault'` or anything else).
fn chosen_mode(root: &Path) -> &'static str {
    match crate::state::get(root).get("settings").and_then(|s| s.get("trash")).and_then(Value::as_str) {
        Some("vault") => "vault",
        _ => "system",
    }
}

/// `trashWhere(path, {mode})` -> `{where}`: where `trash` would put it now, with `mode` when the
/// page names one and the vault's setting otherwise.
pub fn trash_where(root: &Path, rel: &str, mode: Option<&str>) -> Result<Value, String> {
    let full = vault::resolve(root, rel)?;
    let probe = if full.exists() { full } else { root.to_path_buf() };
    let mode = mode.map(|m| if m == "vault" { "vault" } else { "system" }).unwrap_or_else(|| chosen_mode(root));
    let place = if mode == "vault" || !has_bin(&probe) { "vault" } else { "system" };
    Ok(json!({ "where": place }))
}

// ---- trash -----------------------------------------------------------------

/// `trash(path, {mode})` -> `{id, where}`. `mode: 'vault'` goes straight to `.trash`; anything
/// else goes to the system bin when the volume has one and the system agrees, and to `.trash`
/// otherwise. Never a permanent delete.
pub fn trash(root: &Path, rel: &str, mode: &str) -> Result<Value, String> {
    let full = vault::resolve(root, rel)?;
    if full == root {
        return Err(coded("bad_arg", "refusing to trash the vault root"));
    }
    if fs::symlink_metadata(&full).is_err() {
        return Err(coded("not_found", format!("nothing to trash: {rel}")));
    }
    vault::require_vault(root)?;
    if mode == "vault" || !has_bin(&full) {
        return into_vault_bin(root, rel, &full, "");
    }
    let before = now_ms() / 1000;
    let target = full.clone();
    let system = on_own_thread(move || system_delete(&target))?;
    match system {
        Ok(()) => {
            let id = if cfg!(target_os = "macos") { Value::Null } else { json!(format!("system:{before}:{}", clean(rel))) };
            Ok(json!({ "id": id, "where": "system" }))
        }
        Err(first) => into_vault_bin(root, rel, &full, &first),
    }
}

#[cfg(target_os = "macos")]
fn system_delete(full: &Path) -> Result<(), String> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos as _};
    // NSFileManager's own call: no Finder, no AppleScript, and a refusal that says so.
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(full).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn system_delete(full: &Path) -> Result<(), String> {
    trash::delete(full).map_err(|e| e.to_string())
}

fn clean(rel: &str) -> String {
    rel.replace('\\', "/").trim_matches('/').to_string()
}

/// `.trash/<stamp>-<name>` with its sidecar: the settings choice "deleted files go to the vault"
/// (S37), and the fallback when the system's bin refuses or the volume has none. `first` is the
/// system's complaint when this is a fallback, and empty when the vault bin was asked for.
fn into_vault_bin(root: &Path, rel: &str, full: &Path, first: &str) -> Result<Value, String> {
    let why = |e: std::io::Error| {
        if first.is_empty() {
            coded("io", format!("{rel}: .trash: {e}"))
        } else {
            coded("io", format!("{rel}: {first}; and .trash: {e}"))
        }
    };
    let bin = root.join(BIN);
    fs::create_dir_all(bin.join(INFO)).map_err(why)?;
    let at = now_ms();
    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "item".into());
    let mut entry = format!("{at}-{name}");
    let mut n = 2;
    while fs::symlink_metadata(bin.join(&entry)).is_ok() {
        entry = format!("{at}-{n}-{name}");
        n += 1;
    }
    let kind = if fs::symlink_metadata(full).map(|m| m.is_dir()).unwrap_or(false) { "dir" } else { "file" };
    vault::rename_noreplace(full, &bin.join(&entry)).map_err(why)?;
    let sidecar = json!({ "v": 1, "original": clean(rel), "deletedAt": at, "kind": kind });
    // The item is safe in the bin already; a sidecar that cannot be written only costs the way
    // back to its folder (it restores to the vault root), so it is logged, not an error.
    if let Err(f) = vault::write_atomic_owned(&info_file(root, &entry), sidecar.to_string().as_bytes(), 500) {
        log::warn!("trash: sidecar of {entry}: {}", f.error);
    }
    Ok(json!({ "id": format!("vault:{entry}"), "where": "vault" }))
}

fn info_file(root: &Path, entry: &str) -> PathBuf {
    root.join(BIN).join(INFO).join(format!("{entry}.json"))
}

// ---- trashList -------------------------------------------------------------

/// The bytes under a folder, a few levels deep; a file's own length.
fn size_of(full: &Path, depth: usize) -> u64 {
    let Ok(m) = fs::symlink_metadata(full) else { return 0 };
    if !m.is_dir() {
        return m.len();
    }
    if depth > 24 {
        return 0;
    }
    fs::read_dir(full)
        .map(|rd| rd.flatten().map(|e| size_of(&e.path(), depth + 1)).sum())
        .unwrap_or(0)
}

/// `1727000000000-notes.md` -> (`notes.md`, 1727000000000); a name without a stamp as it is.
fn unstamped(entry: &str) -> (String, Option<i64>) {
    if let Some((stamp, rest)) = entry.split_once('-') {
        if !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit()) && !rest.is_empty() {
            return (rest.to_string(), stamp.parse().ok());
        }
    }
    (entry.to_string(), None)
}

/// A name that is an entry of the vault bin and nothing else.
fn valid_entry(root: &Path, entry: &str) -> bool {
    !entry.is_empty() && entry != INFO && entry != "." && entry != ".." && !entry.contains(['/', '\\']) && !crate::hide::excluded(root, entry)
}

/// The vault bin's items.
fn vault_items(root: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(read) = fs::read_dir(root.join(BIN)) else { return out };
    for e in read.flatten() {
        let entry = e.file_name().to_string_lossy().to_string();
        if !valid_entry(root, &entry) {
            continue;
        }
        let full = e.path();
        let Ok(meta) = fs::symlink_metadata(&full) else { continue };
        let info: Option<Value> = fs::read_to_string(info_file(root, &entry)).ok().and_then(|t| serde_json::from_str(&t).ok());
        let (bare, stamp) = unstamped(&entry);
        let recorded = info.as_ref().and_then(|i| i.get("original")).and_then(Value::as_str).map(str::to_string);
        let known = recorded.is_some();
        let original = recorded.unwrap_or(bare);
        let deleted = info
            .as_ref()
            .and_then(|i| i.get("deletedAt"))
            .and_then(Value::as_i64)
            .or(stamp)
            .unwrap_or_else(|| meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0));
        let name = original.rsplit('/').next().unwrap_or(&original).to_string();
        let mut item = json!({
            "id": format!("vault:{entry}"),
            "name": name,
            "original": original,
            "deletedAt": deleted,
            "kind": if meta.is_dir() { "dir" } else { "file" },
            "size": size_of(&full, 0),
            "where": "vault",
        });
        // No sidecar: where it was is not known, and a restore puts it at the vault root.
        if !known {
            item["known"] = json!(false);
        }
        out.push(item);
    }
    out
}

/// `path` relative to `root` when it is inside it, comparing case-insensitively where the
/// filesystem folds case. `""` for the root itself.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn inside(root: &Path, path: &Path) -> Option<String> {
    if let Ok(rest) = path.strip_prefix(root) {
        return Some(rest.to_string_lossy().replace('\\', "/"));
    }
    let r = root.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_string();
    let p = path.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_string();
    let folds = cfg!(any(windows, target_os = "macos"));
    let same = |a: &str, b: &str| if folds { a.to_lowercase() == b.to_lowercase() } else { a == b };
    if same(&p, &r) {
        return Some(String::new());
    }
    if p.len() > r.len() && p.is_char_boundary(r.len()) && p.as_bytes()[r.len()] == b'/' && same(&p[..r.len()], &r) {
        return Some(p[r.len() + 1..].to_string());
    }
    None
}

/// `\\?\D:\x` -> `D:\x`, `\\?\UNC\srv\x` -> `\\srv\x`: the spelling the shell records an
/// original folder in.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// The two spellings of the vault root a bin item's original folder can be in: as the vault was
/// opened, and canonical (the `trash` crate canonicalises the parent before it deletes, so a
/// vault opened through a junction or a subst drive is recorded under its real path).
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn root_forms(root: &Path) -> Vec<PathBuf> {
    let mut forms = vec![root.to_path_buf()];
    if let Ok(c) = fs::canonicalize(root) {
        let c = plain(c);
        if c != root {
            forms.push(c);
        }
    }
    forms
}

/// The name the item had, extension and all. On Windows `TrashItem.name` is the bin's display
/// name, which leaves the extension out when Explorer hides known extensions (the default); the
/// item's id is its `$R…` file in the bin, which keeps the extension, and the `$I…` file beside
/// it records the original path whole. Elsewhere the name is the name.
#[cfg(windows)]
fn real_name(item: &trash::TrashItem) -> String {
    let shown = item.name.to_string_lossy().to_string();
    let id = PathBuf::from(&item.id);
    let Some(stored) = id.file_name().map(|n| n.to_string_lossy().to_string()) else { return shown };
    let Some(tail) = stored.strip_prefix("$R").or_else(|| stored.strip_prefix("$r")) else { return shown };
    if let Some(name) = fs::read(id.with_file_name(format!("$I{tail}"))).ok().and_then(|b| info_name(&b)) {
        return name;
    }
    match Path::new(&stored).extension().map(|e| e.to_string_lossy().to_string()) {
        Some(ext) if !shown.to_lowercase().ends_with(&format!(".{}", ext.to_lowercase())) => format!("{shown}.{ext}"),
        _ => shown,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn real_name(item: &trash::TrashItem) -> String {
    item.name.to_string_lossy().to_string()
}

/// The file name in a Recycle Bin `$I` record: version 1 (Vista to 8.1) holds the original path
/// in 260 UTF-16 units from byte 24; version 2 (Windows 10 on) a length at byte 24 and the path
/// from byte 28.
#[cfg_attr(not(windows), allow(dead_code))]
fn info_name(b: &[u8]) -> Option<String> {
    let version = u64::from_le_bytes(b.get(0..8)?.try_into().ok()?);
    let units: Vec<u16> = match version {
        1 => b.get(24..24 + 520)?.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect(),
        2 => {
            let n = u32::from_le_bytes(b.get(24..28)?.try_into().ok()?) as usize;
            b.get(28..28 + n.checked_mul(2)?)?.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()
        }
        _ => return None,
    };
    let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    let path = String::from_utf16(&units[..end]).ok()?;
    let name = path.rsplit(['\\', '/']).next()?.to_string();
    (!name.is_empty()).then_some(name)
}

/// The vault path a bin item came from, when it came from this vault: its original folder
/// matched against either spelling of the root, and its real name.
#[cfg(any(windows, all(unix, not(target_os = "macos"))))]
fn item_rel(forms: &[PathBuf], item: &trash::TrashItem) -> Option<String> {
    let folder = forms.iter().find_map(|r| inside(r, &item.original_parent))?;
    let name = real_name(item);
    Some(if folder.is_empty() { name } else { format!("{}/{name}", folder.trim_matches('/')) })
}

/// Two vault paths that name the same file, as the filesystem compares them.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn same_rel(a: &str, b: &str) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

#[cfg(any(windows, all(unix, not(target_os = "macos"))))]
fn system_items(root: &Path) -> Result<Vec<Value>, String> {
    let forms = root_forms(root);
    on_own_thread(move || {
        let items = trash::os_limited::list().map_err(|e| coded("io", format!("the system bin: {e}")))?;
        let mut out = Vec::new();
        for item in items {
            let Some(rel) = item_rel(&forms, &item) else { continue };
            let (kind, size) = match trash::os_limited::metadata(&item).map(|m| m.size) {
                Ok(trash::TrashItemSize::Entries(_)) => ("dir", 0),
                Ok(trash::TrashItemSize::Bytes(b)) => ("file", b),
                Err(_) => ("file", 0),
            };
            let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            out.push(json!({
                "id": format!("system:{}:{rel}", item.time_deleted),
                "name": name,
                "original": rel,
                "deletedAt": item.time_deleted.saturating_mul(1000),
                "kind": kind,
                "size": size,
                "where": "system",
            }));
        }
        Ok(out)
    })?
}

#[cfg(target_os = "macos")]
fn system_items(_root: &Path) -> Result<Vec<Value>, String> {
    Ok(Vec::new())
}

/// `trashList()` -> `TrashItem[]`, newest first: the vault bin, plus the items of the system
/// bin whose original path is inside this vault (Windows and Linux; the macOS Trash cannot be
/// read by an app). A system bin that cannot be read leaves the vault bin's items standing.
pub fn trash_list(root: &Path) -> Result<Value, String> {
    let mut all = vault_items(root);
    match system_items(root) {
        Ok(mut items) => all.append(&mut items),
        Err(e) => log::warn!("trashList: {e}"),
    }
    all.sort_by_key(|v| std::cmp::Reverse(v["deletedAt"].as_i64().unwrap_or(0)));
    Ok(Value::Array(all))
}

// ---- trashRestore ----------------------------------------------------------

/// Where a restore would land, refused when something is there: nothing is ever overwritten.
fn free_target(root: &Path, original: &str) -> Result<PathBuf, String> {
    let dst = vault::resolve(root, original)?;
    if fs::symlink_metadata(&dst).is_ok() {
        return Err(coded("exists", format!("A file with that name is already there: {original}")));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| coded("io", format!("{}: {e}", parent.display())))?;
    }
    Ok(dst)
}

fn restore_vault(root: &Path, entry: &str) -> Result<String, String> {
    if !valid_entry(root, entry) {
        return Err(coded("bad_arg", format!("not a trash id: vault:{entry}")));
    }
    let src = root.join(BIN).join(entry);
    if fs::symlink_metadata(&src).is_err() {
        return Err(coded("not_found", format!("no longer in .trash: {entry}")));
    }
    let info = info_file(root, entry);
    let original = fs::read_to_string(&info)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("original").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| unstamped(entry).0);
    let dst = free_target(root, &original)?;
    vault::rename_noreplace(&src, &dst).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            coded("exists", format!("A file with that name is already there: {original}"))
        } else {
            coded("io", format!("{original}: {e}"))
        }
    })?;
    let _ = fs::remove_file(info);
    Ok(clean(&original))
}

/// `system:<seconds>:<vault path>` taken apart.
fn parse_system(id: &str) -> Option<(i64, String)> {
    let rest = id.strip_prefix("system:")?;
    let (secs, rel) = rest.split_once(':')?;
    Some((secs.parse().ok()?, rel.to_string()))
}

#[cfg(any(windows, all(unix, not(target_os = "macos"))))]
fn restore_system(root: &Path, ids: Vec<(String, i64, String)>) -> Vec<(String, Result<String, String>)> {
    let root = root.to_path_buf();
    let forms = root_forms(&root);
    let done = on_own_thread(move || {
        let listed = match trash::os_limited::list() {
            Ok(l) => l,
            Err(e) => {
                let msg = coded("io", format!("the system bin: {e}"));
                return ids.into_iter().map(|(id, _, _)| (id, Err(msg.clone()))).collect::<Vec<_>>();
            }
        };
        let mut out = Vec::new();
        for (id, secs, rel) in ids {
            let r = (|| -> Result<String, String> {
                let rel = clean(&rel);
                vault::resolve(&root, &rel)?;
                // Matched by the vault path the item came from (its original folder under either
                // spelling of the root, and its real name), never by the bin's display name.
                let mut item = listed
                    .iter()
                    .filter(|i| i.time_deleted >= secs - 2 && item_rel(&forms, i).is_some_and(|r| same_rel(&r, &rel)))
                    .min_by_key(|i| i.time_deleted)
                    .cloned()
                    .ok_or_else(|| coded("not_found", format!("no longer in the bin: {rel}")))?;
                free_target(&root, &rel)?;
                // The name the file had, not the one the bin displays (which may leave the
                // extension out).
                if let Some(name) = rel.rsplit('/').next() {
                    item.name = name.into();
                }
                trash::os_limited::restore_all([item]).map_err(|e| match e {
                    trash::Error::RestoreCollision { .. } => coded("exists", format!("A file with that name is already there: {rel}")),
                    other => coded("io", format!("{rel}: {other}")),
                })?;
                Ok(rel)
            })();
            out.push((id, r));
        }
        out
    });
    done.unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn restore_system(_root: &Path, ids: Vec<(String, i64, String)>) -> Vec<(String, Result<String, String>)> {
    ids.into_iter()
        .map(|(id, _, _)| (id, Err(coded("bad_arg", "the macOS Trash is restored from the Finder"))))
        .collect()
}

/// `trashRestore(ids)` -> `{restored: {id, path}[], failed: {id, error}[]}`. Each item goes back
/// to its original path, with any missing folders made again; one whose place is taken again is
/// refused with `[exists]` and left in the bin.
pub fn trash_restore(root: &Path, ids: &[String]) -> Result<Value, String> {
    vault::require_vault(root)?;
    let mut restored = Vec::new();
    let mut failed = Vec::new();
    let mut system = Vec::new();
    for id in ids {
        if let Some(entry) = id.strip_prefix("vault:") {
            match restore_vault(root, entry) {
                Ok(path) => restored.push(json!({ "id": id, "path": path })),
                Err(e) => failed.push(json!({ "id": id, "error": e })),
            }
        } else if let Some((secs, rel)) = parse_system(id) {
            system.push((id.clone(), secs, rel));
        } else {
            failed.push(json!({ "id": id, "error": coded("bad_arg", format!("not a trash id: {id}")) }));
        }
    }
    if !system.is_empty() {
        for (id, r) in restore_system(root, system) {
            match r {
                Ok(path) => restored.push(json!({ "id": id, "path": path })),
                Err(e) => failed.push(json!({ "id": id, "error": e })),
            }
        }
    }
    Ok(json!({ "restored": restored, "failed": failed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("ose-trash-{tag}-{stamp}-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A round trip through the vault bin: the item goes, is listed with where it came from,
    /// and comes back to that folder, recreated when it went too.
    #[test]
    fn a_vault_trash_round_trip_restores_to_the_original_folder() {
        let t = Tmp::new("round");
        let root = &t.0;
        fs::create_dir_all(root.join("notes/deep")).unwrap();
        fs::write(root.join("notes/deep/page.md"), "# page\n").unwrap();

        let r = trash(root, "notes/deep/page.md", "vault").unwrap();
        assert_eq!(r["where"], "vault");
        let id = r["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("vault:"), "{id}");
        assert!(!root.join("notes/deep/page.md").exists());

        let list = trash_list(root).unwrap();
        let item = list.as_array().unwrap().iter().find(|i| i["id"] == id.as_str()).cloned().unwrap();
        assert_eq!(item["original"], "notes/deep/page.md");
        assert_eq!(item["name"], "page.md");
        assert_eq!(item["kind"], "file");
        assert_eq!(item["size"], 7);

        // The folder it lived in is gone as well: the restore makes it again.
        fs::remove_dir_all(root.join("notes")).unwrap();
        let back = trash_restore(root, std::slice::from_ref(&id)).unwrap();
        assert_eq!(back["restored"][0]["path"], "notes/deep/page.md");
        assert_eq!(fs::read_to_string(root.join("notes/deep/page.md")).unwrap(), "# page\n");
        assert!(trash_list(root).unwrap().as_array().unwrap().iter().all(|i| i["id"] != id.as_str()));
    }

    /// A restore never overwrites: the original path taken again is `[exists]`, and the item
    /// stays in the bin.
    #[test]
    fn a_restore_onto_a_taken_path_is_refused() {
        let t = Tmp::new("taken");
        let root = &t.0;
        fs::write(root.join("a.md"), "old\n").unwrap();
        let id = trash(root, "a.md", "vault").unwrap()["id"].as_str().unwrap().to_string();
        fs::write(root.join("a.md"), "new\n").unwrap();
        let r = trash_restore(root, std::slice::from_ref(&id)).unwrap();
        assert_eq!(r["restored"].as_array().unwrap().len(), 0);
        let err = r["failed"][0]["error"].as_str().unwrap();
        assert!(err.starts_with("[exists]"), "{err}");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "new\n");
        assert_eq!(trash_list(root).unwrap().as_array().unwrap().iter().filter(|i| i["where"] == "vault").count(), 1);
    }

    /// An item trashed before the sidecars existed restores to its name at the vault root.
    #[test]
    fn an_old_item_without_a_sidecar_restores_to_the_root() {
        let t = Tmp::new("old");
        let root = &t.0;
        fs::create_dir_all(root.join(".trash")).unwrap();
        fs::write(root.join(".trash/1700000000000-old.md"), "x\n").unwrap();
        let list = trash_list(root).unwrap();
        let item = &list.as_array().unwrap()[0];
        assert_eq!(item["original"], "old.md");
        assert_eq!(item["known"], false);
        assert_eq!(item["deletedAt"], 1_700_000_000_000i64);
        let r = trash_restore(root, &[item["id"].as_str().unwrap().to_string()]).unwrap();
        assert_eq!(r["restored"][0]["path"], "old.md");
        assert!(root.join("old.md").is_file());
    }

    #[test]
    fn a_folder_goes_and_comes_back_whole() {
        let t = Tmp::new("folder");
        let root = &t.0;
        fs::create_dir_all(root.join("proj/src")).unwrap();
        fs::write(root.join("proj/src/a.txt"), "aa").unwrap();
        let id = trash(root, "proj", "vault").unwrap()["id"].as_str().unwrap().to_string();
        let item = trash_list(root).unwrap()[0].clone();
        assert_eq!(item["kind"], "dir");
        assert_eq!(item["size"], 2);
        trash_restore(root, &[id]).unwrap();
        assert_eq!(fs::read_to_string(root.join("proj/src/a.txt")).unwrap(), "aa");
    }

    #[test]
    fn ids_that_are_not_ours_are_refused() {
        let t = Tmp::new("ids");
        let r = trash_restore(&t.0, &["vault:../x".into(), "nope".into(), "vault:.info".into()]).unwrap();
        assert_eq!(r["failed"].as_array().unwrap().len(), 3);
        assert_eq!(parse_system("system:1700000000:a/b:c.md"), Some((1_700_000_000, "a/b:c.md".into())));
    }

    #[test]
    fn the_vault_root_is_never_trashed() {
        let t = Tmp::new("rootref");
        assert!(trash(&t.0, "", "vault").unwrap_err().starts_with("[bad_arg]"));
        assert!(trash(&t.0, "missing.md", "vault").unwrap_err().starts_with("[not_found]"));
    }

    /// The system bin, for real: a file goes to the Recycle Bin (or the freedesktop trash), is
    /// listed there under this vault, and comes back. Ignored by default, since it puts a file in
    /// the bin of whoever runs it; `cargo test -- --ignored system_bin` runs it.
    #[cfg(not(target_os = "macos"))]
    #[test]
    #[ignore]
    fn system_bin_round_trip() {
        let t = Tmp::new("system");
        let root = &t.0;
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/bin-test.md"), "round trip\n").unwrap();
        if !has_bin(root) {
            eprintln!("this volume has no bin; skipped");
            return;
        }
        let r = trash(root, "sub/bin-test.md", "system").unwrap();
        assert_eq!(r["where"], "system", "{r}");
        let id = r["id"].as_str().unwrap().to_string();
        assert!(!root.join("sub/bin-test.md").exists());
        let listed = trash_list(root).unwrap();
        assert!(listed.as_array().unwrap().iter().any(|i| i["original"] == "sub/bin-test.md" && i["where"] == "system"), "{listed}");
        fs::remove_dir_all(root.join("sub")).unwrap();
        let back = trash_restore(root, &[id]).unwrap();
        assert_eq!(back["restored"][0]["path"], "sub/bin-test.md", "{back}");
        assert_eq!(fs::read_to_string(root.join("sub/bin-test.md")).unwrap(), "round trip\n");
    }

    fn record_v2(path: &str) -> Vec<u8> {
        let units: Vec<u16> = path.encode_utf16().chain([0]).collect();
        let mut b = 2u64.to_le_bytes().to_vec();
        b.extend([0u8; 16]);
        b.extend((units.len() as u32).to_le_bytes());
        b.extend(units.iter().flat_map(|u| u.to_le_bytes()));
        b
    }

    /// The Recycle Bin's own record of where an item came from, both versions.
    #[test]
    fn the_name_in_a_recycle_bin_record() {
        assert_eq!(info_name(&record_v2(r"D:\os\notes\page.md")).as_deref(), Some("page.md"));
        let mut v1 = 1u64.to_le_bytes().to_vec();
        v1.extend([0u8; 16]);
        let mut units: Vec<u16> = r"D:\os\notes\page.md".encode_utf16().collect();
        units.resize(260, 0);
        v1.extend(units.iter().flat_map(|u| u.to_le_bytes()));
        assert_eq!(info_name(&v1).as_deref(), Some("page.md"));
        assert_eq!(info_name(&[1, 2, 3]), None);
        assert_eq!(info_name(&9u64.to_le_bytes()), None);
    }

    /// The bin shows `page` for `page.md` when Explorer hides known extensions: the real name
    /// comes from the `$I` record, or from the `$R` file's extension when there is none.
    #[cfg(windows)]
    #[test]
    fn a_bin_item_keeps_its_extension() {
        let t = Tmp::new("binname");
        let item = |id: &str, name: &str| trash::TrashItem {
            id: t.0.join(id).into_os_string(),
            name: name.into(),
            original_parent: PathBuf::from(r"D:\os\notes"),
            time_deleted: 0,
        };
        // No `$I` beside it: the extension of the `$R` file.
        assert_eq!(real_name(&item("$RAB12CD.md", "page")), "page.md");
        assert_eq!(real_name(&item("$RAB12CD.md", "page.md")), "page.md");
        assert_eq!(real_name(&item("$RAB12CD.gz", "archive.tar")), "archive.tar.gz");
        assert_eq!(real_name(&item("$RAB12CD", "folder")), "folder");
        // With one: the name it records, whatever the display says.
        fs::write(t.0.join("$IXY.MD"), record_v2(r"D:\os\notes\Page.MD")).unwrap();
        assert_eq!(real_name(&item("$RXY.MD", "Page")), "Page.MD");
        // Not a bin file at all: the name as given.
        assert_eq!(real_name(&item("other.md", "shown")), "shown");
    }

    /// An item's vault path: its folder under either spelling of the root, case folded where the
    /// filesystem folds it, and nothing for an item from outside the vault.
    #[cfg(windows)]
    #[test]
    fn a_bin_item_is_placed_in_the_vault() {
        let forms = [PathBuf::from(r"S:\"), PathBuf::from(r"D:\Real\Vault")];
        let item = |parent: &str| trash::TrashItem {
            id: r"C:\$Recycle.Bin\S-1\$RZZ.md".into(),
            name: "page".into(),
            original_parent: PathBuf::from(parent),
            time_deleted: 0,
        };
        assert_eq!(item_rel(&forms, &item(r"D:\real\vault\Notes")).as_deref(), Some("Notes/page.md"));
        assert_eq!(item_rel(&forms, &item(r"D:\Real\Vault")).as_deref(), Some("page.md"));
        assert_eq!(item_rel(&forms, &item(r"S:\sub")).as_deref(), Some("sub/page.md"));
        assert_eq!(item_rel(&forms, &item(r"D:\Real\Vaults")), None);
        assert_eq!(item_rel(&forms, &item(r"E:\elsewhere")), None);
        assert!(same_rel("Notes/Page.md", "notes/page.md"));
        assert_eq!(plain(PathBuf::from(r"\\?\D:\x")), PathBuf::from(r"D:\x"));
        assert_eq!(plain(PathBuf::from(r"\\?\UNC\srv\x")), PathBuf::from(r"\\srv\x"));
    }

    #[test]
    fn where_follows_the_setting() {
        let t = Tmp::new("where");
        let root = &t.0;
        fs::write(root.join("a.md"), "x").unwrap();
        fs::create_dir_all(root.join(".ose")).unwrap();
        fs::write(root.join(".ose/state.json"), r#"{"settings":{"trash":"vault"}}"#).unwrap();
        assert_eq!(trash_where(root, "a.md", None).unwrap()["where"], "vault");
    }
}
