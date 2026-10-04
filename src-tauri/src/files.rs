//! The save path (docs/HOST.md "Files"): the commands a page writes a file with when it must know
//! what it is writing over.
//!
//! - `readFile(path)` answers the text with its hash, the fingerprint the page carries, and the
//!   encoding the text was decoded from (encoding.rs): a file that is not UTF-8 is saved back in
//!   its own encoding.
//! - `saveFile(path, text, {expectedHash})` compares that hash with the disk and writes in one
//!   call, under one lock per path, so nothing can slip between the look and the write (M2). A
//!   mismatch writes nothing and answers the disk; the bytes a save replaces are kept as a
//!   version.
//! - `createNew`, `createNewBinary`, `copyFile` and `importOutside` never overwrite (M4): the file
//!   is opened exclusively, and a write that fails leaves no file behind.
//! - `appendLine` and `replaceLine` change one line and keep every other byte, line endings and
//!   a byte-order mark included (M30, M31).
//!
//! A save and a read name their file by `Target`: a vault file (with its root, for the versions
//! and the vault checks) or a file outside every vault that the window registered (outside.rs),
//! which keeps no versions.
//!
//! Every error is `[code] message`. Every save outcome goes to the log.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use serde_json::{json, Value};

use crate::versions::{self, Reason};
use crate::{coded, encoding, vault, Host, Level};

// ---- one lock per path -----------------------------------------------------

/// A process-wide lock per file. Two saves of one path, or a save and a line edit, run one after
/// the other; saves of different files do not wait on each other.
pub(crate) fn lock_for(full: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut key = full.to_string_lossy().replace('\\', "/");
    // The same file under another case is the same file on Windows and a default macOS volume.
    if cfg!(any(windows, target_os = "macos")) {
        key = key.to_lowercase();
    }
    let mut map = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    // Nobody else holds a lock that only the map still has: dropping those keeps the map as
    // small as the set of files being written right now.
    map.retain(|_, l| Arc::strong_count(l) > 1);
    Arc::clone(map.entry(key).or_default())
}

// ---- helpers ---------------------------------------------------------------

fn mtime(full: &Path) -> i64 {
    fs::metadata(full)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The vault path as the page should see it again: forward slashes, no leading slash.
fn clean(rel: &str) -> String {
    rel.replace('\\', "/").trim().trim_start_matches('/').to_string()
}

/// The bytes on disk, `None` when there is no file. Anything else the disk says is an error:
/// a file this process cannot read holds bytes nobody has seen, and must not be written over.
fn read_existing(full: &Path, rel: &str) -> Result<Option<Vec<u8>>, String> {
    match fs::read(full) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(crate::io_error(rel, &e)),
    }
}

/// A name the filesystem would refuse or silently change: `bad_name` before anything is created.
/// The core checks names more strictly (`ose.names.check`); this is the host's floor.
fn check_name(rel: &str) -> Result<(), String> {
    let cleaned = clean(rel);
    let name = cleaned.rsplit('/').next().unwrap_or("");
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with('.')
        || name.ends_with(' ')
        || cleaned
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'));
    if bad {
        return Err(coded("bad_name", format!("not a file name: {rel}")));
    }
    Ok(())
}

/// Creates `full` exclusively and writes `bytes` into it, synced. Never overwrites: an existing
/// file (in any letter case the filesystem folds) is `[exists]`. A write that fails after the
/// create removes the half-written file, which is ours and holds nothing the caller lacks.
fn create_exclusive(root: &Path, full: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    vault::ensure_parent(root, full)?;
    let mut f = match fs::OpenOptions::new().write(true).create_new(true).open(full) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(coded("exists", format!("already exists: {rel}")));
        }
        Err(e) => return Err(crate::io_error(rel, &e)),
    };
    let written = f.write_all(bytes).and_then(|_| f.sync_all());
    if let Err(e) = written {
        drop(f);
        let _ = fs::remove_file(full);
        return Err(coded("write_failed", format!("{rel}: {e}")));
    }
    Ok(())
}

// ---- readFile ------------------------------------------------------------

/// `readFile(path, {encoding})` -> `{text, hash, mtime, size, encoding, bom, lossy}`. The text is
/// every character of the file, a byte-order mark and CRLF included; the hash is over its bytes
/// (docs/HOST.md "Hash"). The encoding is detected unless `forced` names one (encoding.rs).
pub fn read_file(root: &Path, rel: &str) -> Result<Value, String> {
    read_file_at(&vault::resolve(root, rel)?, rel, None)
}

/// `read_file` of a resolved path; `rel` names it in errors.
pub fn read_file_at(full: &Path, rel: &str, forced: Option<&str>) -> Result<Value, String> {
    let bytes = fs::read(full).map_err(|e| crate::io_error(rel, &e))?;
    let hash = vault::hash(&bytes);
    let size = bytes.len();
    let d = encoding::decode(&bytes, forced).map_err(|e| format!("{e}: {rel}"))?;
    Ok(json!({
        "text": d.text, "hash": hash, "mtime": mtime(full), "size": size,
        "encoding": d.encoding, "bom": d.bom, "lossy": d.lossy,
    }))
}

// ---- saveFile ------------------------------------------------------------

/// What a save keeps of the bytes it replaces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keep {
    /// a tiered version, reason `save`, not forced (the default)
    Save,
    /// a forced version, reason `conflict`: "Keep mine" over a file changed on disk
    Conflict,
    /// nothing
    None,
}

/// One save: where, what, over what, and in which encoding.
pub struct SaveReq<'a> {
    /// The vault, for a vault file (its checks and its versions); `None` for an outside file,
    /// which keeps no versions.
    pub root: Option<&'a Path>,
    pub full: std::path::PathBuf,
    /// How the file is named in errors and in the log.
    pub rel: &'a str,
    pub text: &'a str,
    /// `None` for "the file must not exist", `Some(hash)` for "the disk must still hold these
    /// bytes".
    pub expected: Option<&'a str>,
    pub keep: Keep,
    /// The encoding to write in, UTF-8 when absent (encoding.rs).
    pub encoding: Option<&'a str>,
    /// The caller asked for the file to become UTF-8 (`page.save-utf8`). Without it a UTF-8
    /// save over bytes that are not valid UTF-8 is `[lossy]`: converting a file is always an
    /// explicit command, never what a caller that forgot `encoding` gets.
    pub convert: bool,
}

/// `saveFile(path, text, {expectedHash, version})` in UTF-8. Answers
/// `{status:'saved', hash, mtime, unchanged?}` or `{status:'conflict', disk}`; only a failure to
/// write is an error. `note` hears about a version that could not be kept, which never blocks
/// the save.
pub fn save_file(
    root: &Path,
    rel: &str,
    text: &str,
    expected: Option<&str>,
    keep: Keep,
    note: &dyn Fn(&str),
) -> Result<Value, String> {
    let req = SaveReq { root: Some(root), full: vault::resolve(root, rel)?, rel, text, expected, keep, encoding: None, convert: false };
    save(&req, note)
}

/// Any save (`SaveReq`).
pub fn save(req: &SaveReq, note: &dyn Fn(&str)) -> Result<Value, String> {
    save_with(req, note, &|| {})
}

/// `save` with a hook run after the new bytes are synced and before the last look at the
/// target: the tests write the file there, the way an outside writer would.
fn save_with(req: &SaveReq, note: &dyn Fn(&str), meanwhile: &dyn Fn()) -> Result<Value, String> {
    let (full, rel) = (&req.full, req.rel);
    match req.root {
        Some(root) => {
            if full == root {
                return Err(coded("bad_arg", "no file name to write"));
            }
            // A vault folder that was renamed, moved or unplugged is not a page that was
            // deleted: the page must not be offered "Save again here", and nothing may recreate
            // the old root.
            vault::require_vault(root)?;
        }
        None => {
            // An outside file's folder is not ours to create.
            if !full.parent().is_some_and(Path::is_dir) {
                return Err(coded("not_found", format!("the folder of {rel} is gone")));
            }
        }
    }
    let enc = match req.encoding {
        None => encoding_rs::UTF_8,
        Some(label) => encoding::encoding_for(label)?,
    };
    // A character the encoding cannot hold is refused before anything is looked at or written.
    let bytes = encoding::encode(req.text, enc)?;
    let lock = lock_for(full);
    let held = lock.lock().unwrap_or_else(|p| p.into_inner());

    let disk = read_existing(full, rel)?;

    // The disk already holds the buffer: nothing to write, whoever wrote it.
    if disk.as_deref() == Some(bytes.as_slice()) {
        return Ok(json!({
            "status": "saved", "hash": vault::hash(&bytes), "mtime": mtime(full), "unchanged": true,
        }));
    }

    let disk_hash = disk.as_deref().map(vault::hash);
    let matches = match (req.expected, &disk_hash) {
        (None, None) => true,
        (Some(want), Some(have)) => want == have,
        _ => false,
    };
    if !matches {
        return Ok(conflict(disk.as_deref(), enc));
    }
    // A file whose bytes do not survive a decode and an encode in this encoding would lose
    // them on a save in it: refused. Converting it to UTF-8 is always the explicit way: a UTF-8
    // save over bytes that are not UTF-8 needs `convert`, so a caller that forgot `encoding`
    // cannot turn a windows-1252 or UTF-16 file into UTF-8, or double-encode it.
    if let Some(old) = &disk {
        if enc != encoding_rs::UTF_8 {
            let (text, errors) = enc.decode_without_bom_handling(old);
            if errors || encoding::encode(&text, enc).map(|b| &b != old).unwrap_or(true) {
                return Err(coded("lossy", format!("{rel} does not read back exactly in {}; save it as UTF-8", enc.name())));
            }
        } else if !req.convert && std::str::from_utf8(old).is_err() {
            return Err(coded("lossy", format!("{rel} is not UTF-8 on disk; save it in its own encoding, or convert it with Save as UTF-8")));
        }
    }

    // The new bytes go to a temp file and are synced, which takes a moment; the lock only
    // orders writers inside this process. Right before the rename the target is read once more:
    // an outside writer (Claude Code on the vault, a sync client) that wrote it meanwhile wins,
    // and the page is shown the conflict instead of its bytes being replaced unseen.
    if let Some(root) = req.root {
        vault::ensure_parent(root, full)?;
    }
    let moved: RefCell<Option<Option<Vec<u8>>>> = RefCell::new(None);
    let still = |_tmp: &Path| -> std::io::Result<()> {
        meanwhile();
        let now = match fs::read(full) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        // Still what was compared, or already the new bytes (whoever wrote them): go on.
        if now == disk || now.as_deref() == Some(bytes.as_slice()) {
            return Ok(());
        }
        *moved.borrow_mut() = Some(now);
        Err(std::io::Error::other("changed on disk while saving"))
    };
    if let Err(f) = vault::write_atomic_with(full, &bytes, vault::RENAME_BUDGET_MS, vault::Aside::Visible, &still) {
        if let Some(now) = moved.take() {
            return Ok(conflict(now.as_deref(), enc));
        }
        return Err(f.message(rel, req.root));
    }
    let saved = json!({ "status": "saved", "hash": vault::hash(&bytes), "mtime": mtime(full) });

    // The replaced bytes become a version after the write, from memory: keeping it first put a
    // synced write and a walk of the history inside the compare-to-write window. A version that
    // cannot be kept is logged and never fails a save that already happened. An outside file
    // keeps none.
    if let (Some(root), Some(old)) = (req.root, &disk) {
        let kept = match req.keep {
            Keep::Save => Some(versions::keep_now(root, rel, old, false, Reason::Save)),
            Keep::Conflict => Some(versions::keep_now(root, rel, old, true, Reason::Conflict)),
            Keep::None => None,
        };
        if let Some(Err(e)) = kept {
            note(&format!("version of {rel} not kept: {e}"));
        }
    }
    drop(held);
    if let Some(root) = req.root {
        versions::settle(root);
    }
    Ok(saved)
}

/// `{status:'conflict', disk}`: what the disk holds instead of what the page expected, decoded in
/// the encoding of the save (`null` when it does not decode).
fn conflict(disk: Option<&[u8]>, enc: &'static encoding_rs::Encoding) -> Value {
    let text = disk.and_then(|b| {
        let (t, errors) = enc.decode_without_bom_handling(b);
        (!errors).then(|| t.into_owned())
    });
    json!({
        "status": "conflict",
        "disk": { "exists": disk.is_some(), "text": text, "hash": disk.map(vault::hash) },
    })
}

// ---- createNew, copyFile ---------------------------------------------------

/// `createNew(path, text)` -> `{path, hash}`. Creates the missing folders, never overwrites.
pub fn create_new(root: &Path, rel: &str, text: &str) -> Result<Value, String> {
    check_name(rel)?;
    let full = vault::resolve(root, rel)?;
    vault::require_vault(root)?;
    let lock = lock_for(&full);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    create_exclusive(root, &full, rel, text.as_bytes())?;
    Ok(json!({ "path": clean(rel), "hash": vault::hash(text.as_bytes()) }))
}

/// `createNewBinary(path, base64)` -> `{path, hash}`: bytes, any type, into a new file, created
/// and written in one call. The data is decoded before anything is created, and a write that
/// fails removes the file it made, so a failure never leaves an empty file behind.
pub fn create_new_binary(root: &Path, rel: &str, b64: &str) -> Result<Value, String> {
    check_name(rel)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| coded("bad_arg", format!("not base64: {e}")))?;
    let full = vault::resolve(root, rel)?;
    vault::require_vault(root)?;
    let lock = lock_for(&full);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    create_exclusive(root, &full, rel, &bytes)?;
    Ok(json!({ "path": clean(rel), "hash": vault::hash(&bytes) }))
}

/// `importOutside(from, to)` -> `{path, hash}`: the bytes of the outside file `from` (resolved and
/// registered by the caller) into a new vault file `to`, create-only.
pub fn import_outside(root: &Path, from: &Path, to: &str) -> Result<Value, String> {
    check_name(to)?;
    let dst = vault::resolve(root, to)?;
    vault::require_vault(root)?;
    if from.is_dir() {
        return Err(coded("bad_arg", format!("not a file: {}", from.display())));
    }
    let bytes = fs::read(from).map_err(|e| crate::io_error(&from.display().to_string(), &e))?;
    let lock = lock_for(&dst);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    create_exclusive(root, &dst, to, &bytes)?;
    Ok(json!({ "path": clean(to), "hash": vault::hash(&bytes) }))
}

/// `copyFile(from, to)` -> `{path, hash}`: the bytes of `from`, any type, into a new `to`.
pub fn copy_file(root: &Path, from: &str, to: &str) -> Result<Value, String> {
    check_name(to)?;
    let src = vault::resolve(root, from)?;
    let dst = vault::resolve(root, to)?;
    vault::require_vault(root)?;
    if src.is_dir() {
        return Err(coded("bad_arg", format!("not a file: {from}")));
    }
    let bytes = fs::read(&src).map_err(|e| crate::io_error(from, &e))?;
    let lock = lock_for(&dst);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    create_exclusive(root, &dst, to, &bytes)?;
    Ok(json!({ "path": clean(to), "hash": vault::hash(&bytes) }))
}

// ---- appendLine ------------------------------------------------------------

/// The line ending a file already uses: CRLF when its last line ending is one, else LF.
fn eol_of(bytes: &[u8]) -> &'static str {
    match bytes.iter().rposition(|b| *b == b'\n') {
        Some(i) if i > 0 && bytes[i - 1] == b'\r' => "\r\n",
        _ => "\n",
    }
}

/// What `appendLine` writes after `bytes`: a separator when the last line is unfinished, the
/// line, and the file's own line ending.
fn appended(bytes: &[u8], line: &str) -> String {
    let eol = eol_of(bytes);
    let sep = if !bytes.is_empty() && !bytes.ends_with(b"\n") { eol } else { "" };
    format!("{sep}{line}{eol}")
}

/// `appendLine(path, line)` -> `{hash}`. One line at the end, with the file's own line ending;
/// the file and its folders are created when missing. Keeps no version: nothing is replaced.
pub fn append_line(root: &Path, rel: &str, line: &str) -> Result<Value, String> {
    if line.contains(['\n', '\r']) {
        return Err(coded("bad_arg", "a line cannot hold a line break"));
    }
    let full = vault::resolve(root, rel)?;
    if full == root {
        return Err(coded("bad_arg", "no file name to write"));
    }
    vault::require_vault(root)?;
    let lock = lock_for(&full);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let before = read_existing(&full, rel)?.unwrap_or_default();
    // The line is UTF-8: appended to a UTF-16 file it would break the byte pairs of the rest,
    // and to a windows-1252 one it would mix two encodings. Refused, as `replaceLine` does.
    if std::str::from_utf8(&before).is_err() {
        return Err(coded("not_utf8", format!("not valid UTF-8: {rel}")));
    }
    let add = appended(&before, line);
    vault::ensure_parent(root, &full)?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&full)
        .map_err(|e| crate::io_error(rel, &e))?;
    f.write_all(add.as_bytes())
        .and_then(|_| f.sync_all())
        .map_err(|e| coded("write_failed", format!("{rel}: {e}")))?;
    let mut after = before;
    after.extend_from_slice(add.as_bytes());
    Ok(json!({ "hash": vault::hash(&after) }))
}

// ---- replaceLine -----------------------------------------------------------

/// The lines of `text` as `(content_start, content_end)` byte ranges. Split on `\n`; a `\r`
/// right before a `\n` belongs to the separator. The empty piece after a final `\n` is not a
/// line.
fn line_spans(text: &str) -> Vec<(usize, usize)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in b.iter().enumerate() {
        if *c == b'\n' {
            let end = if i > start && b[i - 1] == b'\r' { i - 1 } else { i };
            out.push((start, end));
            start = i + 1;
        }
    }
    if start < b.len() {
        out.push((start, b.len()));
    }
    out
}

/// Line `index` of `text` as a byte range, without the byte-order mark on line 0: the mark is a
/// byte of the file, not a character of the line (the views' task parser strips it too).
fn line_at(text: &str, index: i64) -> Option<(usize, usize)> {
    let (start, end) = *usize::try_from(index).ok().and_then(|i| line_spans(text).get(i).copied()).as_ref()?;
    let bom = if index == 0 && text[start..end].starts_with('\u{feff}') { '\u{feff}'.len_utf8() } else { 0 };
    Some((start + bom, end))
}

/// `replaceLine(path, index, expected, next)`: line `index` (0-based) becomes `next` only when
/// it still reads `expected`; its separator, a byte-order mark before line 0, and every other
/// byte stay. Answers
/// `{status:'replaced', hash}` or `{status:'conflict', actual}` (`null` when out of range). The
/// replaced bytes are kept as a tiered version.
pub fn replace_line(
    root: &Path,
    rel: &str,
    index: i64,
    expected: &str,
    next: &str,
    note: &dyn Fn(&str),
) -> Result<Value, String> {
    if next.contains(['\n', '\r']) {
        return Err(coded("bad_arg", "a line cannot hold a line break"));
    }
    let full = vault::resolve(root, rel)?;
    vault::require_vault(root)?;
    let lock = lock_for(&full);
    let held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let bytes = fs::read(&full).map_err(|e| crate::io_error(rel, &e))?;
    let text = String::from_utf8(bytes).map_err(|_| coded("not_utf8", format!("not valid UTF-8: {rel}")))?;
    let Some((start, end)) = line_at(&text, index) else {
        return Ok(json!({ "status": "conflict", "actual": null }));
    };
    let actual = &text[start..end];
    if actual != expected {
        return Ok(json!({ "status": "conflict", "actual": actual }));
    }
    if expected == next {
        return Ok(json!({ "status": "replaced", "hash": vault::hash(text.as_bytes()) }));
    }
    let mut out = String::with_capacity(text.len() + next.len());
    out.push_str(&text[..start]);
    out.push_str(next);
    out.push_str(&text[end..]);
    // As in `save_file`: the file is read once more right before the rename, so an outside
    // write made meanwhile is answered as a conflict rather than replaced, and the version is
    // kept after the write.
    let moved: RefCell<Option<Option<String>>> = RefCell::new(None);
    let still = |_tmp: &Path| -> std::io::Result<()> {
        let now = match fs::read(&full) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                *moved.borrow_mut() = Some(None);
                return Err(e);
            }
            Err(e) => return Err(e),
        };
        if now == text.as_bytes() || now == out.as_bytes() {
            return Ok(());
        }
        let line = String::from_utf8(now)
            .ok()
            .and_then(|t| line_at(&t, index).map(|(s, e)| t[s..e].to_string()));
        *moved.borrow_mut() = Some(line);
        Err(std::io::Error::other("changed on disk while saving"))
    };
    if let Err(f) = vault::write_atomic_with(&full, out.as_bytes(), vault::RENAME_BUDGET_MS, vault::Aside::Visible, &still) {
        if let Some(actual) = moved.take() {
            return Ok(json!({ "status": "conflict", "actual": actual }));
        }
        return Err(f.message(rel, Some(root)));
    }
    if let Err(e) = versions::keep_now(root, rel, text.as_bytes(), false, Reason::Save) {
        note(&format!("version of {rel} not kept: {e}"));
    }
    drop(held);
    versions::settle(root);
    Ok(json!({ "status": "replaced", "hash": vault::hash(out.as_bytes()) }))
}

// ---- the log -------------------------------------------------------------

/// Every save outcome goes to the log (M54), so "my text is gone" can be answered from it.
pub fn log_save(host: &Host, rel: &str, r: &Result<Value, String>) {
    match r {
        Ok(v) if v["status"] == "saved" => {
            let how = if v["unchanged"] == true { " (unchanged)" } else { "" };
            crate::log_at(host, Level::Info, &format!("save ok {rel}{how}"));
        }
        Ok(_) => crate::log_at(host, Level::Warn, &format!("save conflict {rel}")),
        Err(e) => crate::log_at(host, Level::Error, &format!("save failed {rel}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::SystemTime;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("ose-files-{tag}-{stamp}-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn quiet(_: &str) {}

    #[test]
    fn the_hash_is_fnv1a_64() {
        assert_eq!(vault::hash(b""), "cbf29ce484222325");
        assert_eq!(vault::hash(b"a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn read_file_answers_the_bytes_and_their_hash() {
        let t = Tmp::new("read");
        fs::write(t.0.join("a.md"), "\u{feff}# a\r\n").unwrap();
        let r = read_file(&t.0, "a.md").unwrap();
        assert_eq!(r["text"], "\u{feff}# a\r\n");
        assert_eq!(r["hash"], vault::hash("\u{feff}# a\r\n".as_bytes()));
        assert_eq!(r["size"], 8);
        assert!(read_file(&t.0, "none.md").unwrap_err().starts_with("[not_found]"));
        assert_eq!(r["encoding"], "UTF-8");
        assert_eq!(r["bom"], true);
        assert_eq!(r["lossy"], false);
        // Not UTF-8: detected, decoded, and said so.
        fs::write(t.0.join("b.md"), b"caf\xe9 cr\xe8me\n").unwrap();
        let r = read_file(&t.0, "b.md").unwrap();
        assert_eq!(r["encoding"], "windows-1252");
        assert_eq!(r["text"], "café crème\n");
        assert_eq!(r["lossy"], false);
        // A forced encoding that does not fit is the one read error.
        let e = read_file_at(&t.0.join("b.md"), "b.md", Some("utf-8")).unwrap_err();
        assert!(e.starts_with("[not_utf8]"), "{e}");
    }

    #[test]
    fn save_creates_only_when_asked_to() {
        let t = Tmp::new("create");
        let root = &t.0;
        // expectedHash null: the file must not exist, and then it is created with its folders.
        let r = save_file(root, "new/a.md", "# a\n", None, Keep::Save, &quiet).unwrap();
        assert_eq!(r["status"], "saved");
        assert_eq!(r["hash"], vault::hash(b"# a\n"));
        assert_eq!(fs::read_to_string(root.join("new/a.md")).unwrap(), "# a\n");
        // A second create over it is a conflict that names what is there.
        let r = save_file(root, "new/a.md", "# other\n", None, Keep::Save, &quiet).unwrap();
        assert_eq!(r["status"], "conflict");
        assert_eq!(r["disk"]["exists"], true);
        assert_eq!(r["disk"]["text"], "# a\n");
        assert_eq!(fs::read_to_string(root.join("new/a.md")).unwrap(), "# a\n");
    }

    #[test]
    fn save_refuses_a_file_changed_on_disk_and_keeps_the_replaced_bytes() {
        let t = Tmp::new("conflict");
        let root = &t.0;
        fs::write(root.join("p.md"), "one\n").unwrap();
        let h1 = vault::hash(b"one\n");
        let r = save_file(root, "p.md", "two\n", Some(&h1), Keep::Save, &quiet).unwrap();
        assert_eq!(r["status"], "saved");
        let h2 = r["hash"].as_str().unwrap().to_string();
        // The bytes it replaced are a version.
        let listed = versions::list(root, "p.md").unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        let id = listed[0]["id"].as_str().unwrap();
        assert_eq!(versions::read(root, "p.md", id).unwrap(), "one\n");

        // Someone else writes; a save with the old hash writes nothing.
        fs::write(root.join("p.md"), "theirs\n").unwrap();
        let r = save_file(root, "p.md", "mine\n", Some(&h2), Keep::Save, &quiet).unwrap();
        assert_eq!(r["status"], "conflict");
        assert_eq!(r["disk"]["text"], "theirs\n");
        assert_eq!(r["disk"]["hash"], vault::hash(b"theirs\n"));
        assert_eq!(fs::read_to_string(root.join("p.md")).unwrap(), "theirs\n");

        // "Keep mine": the disk's hash, a forced conflict version.
        let theirs = r["disk"]["hash"].as_str().unwrap().to_string();
        let r = save_file(root, "p.md", "mine\n", Some(&theirs), Keep::Conflict, &quiet).unwrap();
        assert_eq!(r["status"], "saved");
        let listed = versions::list(root, "p.md").unwrap();
        assert_eq!(listed[0]["reason"], "conflict");

        // The file deleted under the page: a save expecting it is a conflict with exists:false.
        fs::remove_file(root.join("p.md")).unwrap();
        let r = save_file(root, "p.md", "again\n", Some(&theirs), Keep::Save, &quiet).unwrap();
        assert_eq!(r["status"], "conflict");
        assert_eq!(r["disk"], json!({ "exists": false, "text": null, "hash": null }));
    }

    #[test]
    fn save_of_what_is_already_there_writes_nothing() {
        let t = Tmp::new("unchanged");
        let root = &t.0;
        fs::write(root.join("u.md"), "same\n").unwrap();
        let r = save_file(root, "u.md", "same\n", Some("0000000000000000"), Keep::Save, &quiet).unwrap();
        assert_eq!(r["status"], "saved");
        assert_eq!(r["unchanged"], true);
        assert_eq!(versions::list(root, "u.md").unwrap(), json!([]));
    }

    #[test]
    fn save_with_version_none_keeps_nothing() {
        let t = Tmp::new("none");
        let root = &t.0;
        fs::write(root.join("n.md"), "a\n").unwrap();
        save_file(root, "n.md", "b\n", Some(&vault::hash(b"a\n")), Keep::None, &quiet).unwrap();
        assert_eq!(versions::list(root, "n.md").unwrap(), json!([]));
    }

    #[test]
    fn create_new_never_overwrites() {
        let t = Tmp::new("create-new");
        let root = &t.0;
        let r = create_new(root, "deep/er/x.md", "# x\n").unwrap();
        assert_eq!(r["path"], "deep/er/x.md");
        assert_eq!(r["hash"], vault::hash(b"# x\n"));
        let e = create_new(root, "deep/er/x.md", "other").unwrap_err();
        assert!(e.starts_with("[exists]"), "{e}");
        assert_eq!(fs::read_to_string(root.join("deep/er/x.md")).unwrap(), "# x\n");
        // Another letter case is the same file where the filesystem folds case.
        if cfg!(any(windows, target_os = "macos")) {
            assert!(create_new(root, "deep/er/X.md", "other").unwrap_err().starts_with("[exists]"));
        }
        assert!(create_new(root, "bad?.md", "").unwrap_err().starts_with("[bad_name]"));
        assert!(create_new(root, "trailing.", "").unwrap_err().starts_with("[bad_name]"));
        assert!(create_new(root, "../out.md", "").unwrap_err().starts_with("[escapes_vault]"));
    }

    #[test]
    fn copy_is_bytes_under_the_create_only_rule() {
        let t = Tmp::new("copy");
        let root = &t.0;
        fs::write(root.join("a.bin"), [0u8, 1, 2, 255]).unwrap();
        let r = copy_file(root, "a.bin", "b.bin").unwrap();
        assert_eq!(r["path"], "b.bin");
        assert_eq!(fs::read(root.join("b.bin")).unwrap(), vec![0u8, 1, 2, 255]);
        assert!(copy_file(root, "a.bin", "b.bin").unwrap_err().starts_with("[exists]"));
        assert!(copy_file(root, "none", "c.bin").unwrap_err().starts_with("[not_found]"));
    }

    #[test]
    fn append_line_uses_the_file_s_own_separator() {
        let t = Tmp::new("append");
        let root = &t.0;
        // Missing: created with its folder, LF.
        append_line(root, "log/a.md", "one").unwrap();
        assert_eq!(fs::read_to_string(root.join("log/a.md")).unwrap(), "one\n");
        // Empty file.
        fs::write(root.join("e.md"), "").unwrap();
        append_line(root, "e.md", "x").unwrap();
        assert_eq!(fs::read_to_string(root.join("e.md")).unwrap(), "x\n");
        // No final newline: the separator first.
        fs::write(root.join("n.md"), "a\nb").unwrap();
        let r = append_line(root, "n.md", "c").unwrap();
        assert_eq!(fs::read_to_string(root.join("n.md")).unwrap(), "a\nb\nc\n");
        assert_eq!(r["hash"], vault::hash(b"a\nb\nc\n"));
        // CRLF, finished and unfinished.
        fs::write(root.join("w.md"), "a\r\nb\r\n").unwrap();
        append_line(root, "w.md", "c").unwrap();
        assert_eq!(fs::read(root.join("w.md")).unwrap(), b"a\r\nb\r\nc\r\n");
        fs::write(root.join("v.md"), "a\r\nb").unwrap();
        append_line(root, "v.md", "c").unwrap();
        assert_eq!(fs::read(root.join("v.md")).unwrap(), b"a\r\nb\r\nc\r\n");
        // A line holding a break is refused.
        assert!(append_line(root, "v.md", "x\ny").unwrap_err().starts_with("[bad_arg]"));
        assert!(append_line(root, "v.md", "x\r").unwrap_err().starts_with("[bad_arg]"));
        assert_eq!(versions::list(root, "n.md").unwrap(), json!([]), "no version for an append");
        // A file that is not UTF-8 (UTF-16LE, windows-1252) is refused and left as it was.
        let utf16: Vec<u8> = "\u{feff}a\r\nb\r\n".encode_utf16().flat_map(u16::to_le_bytes).collect();
        fs::write(root.join("u.md"), &utf16).unwrap();
        assert!(append_line(root, "u.md", "c").unwrap_err().starts_with("[not_utf8]"));
        assert_eq!(fs::read(root.join("u.md")).unwrap(), utf16);
        fs::write(root.join("l.md"), b"caf\xe9\n").unwrap();
        assert!(append_line(root, "l.md", "c").unwrap_err().starts_with("[not_utf8]"));
        assert_eq!(fs::read(root.join("l.md")).unwrap(), b"caf\xe9\n".to_vec());
    }

    #[test]
    fn replace_line_keeps_every_other_byte() {
        let t = Tmp::new("replace");
        let root = &t.0;
        fs::write(root.join("c.md"), "- [ ] one\r\n- [ ] two\r\nlast").unwrap();
        let r = replace_line(root, "c.md", 1, "- [ ] two", "- [x] two", &quiet).unwrap();
        assert_eq!(r["status"], "replaced");
        assert_eq!(fs::read(root.join("c.md")).unwrap(), b"- [ ] one\r\n- [x] two\r\nlast");
        assert_eq!(r["hash"], vault::hash(b"- [ ] one\r\n- [x] two\r\nlast"));
        // The last line, with no separator.
        replace_line(root, "c.md", 2, "last", "end", &quiet).unwrap();
        assert_eq!(fs::read(root.join("c.md")).unwrap(), b"- [ ] one\r\n- [x] two\r\nend");
        // The replaced bytes are a version.
        assert_eq!(versions::list(root, "c.md").unwrap().as_array().unwrap().len(), 1);

        // A line that changed: conflict with what it holds, nothing written.
        let r = replace_line(root, "c.md", 0, "- [ ] zero", "x", &quiet).unwrap();
        assert_eq!(r, json!({ "status": "conflict", "actual": "- [ ] one" }));
        // Out of range, and the empty piece after a final newline is not a line.
        let r = replace_line(root, "c.md", 3, "", "x", &quiet).unwrap();
        assert_eq!(r, json!({ "status": "conflict", "actual": null }));
        fs::write(root.join("d.md"), "a\n").unwrap();
        assert_eq!(replace_line(root, "d.md", 1, "", "x", &quiet).unwrap()["actual"], Value::Null);
        assert_eq!(replace_line(root, "d.md", -1, "", "x", &quiet).unwrap()["actual"], Value::Null);
        assert!(replace_line(root, "d.md", 0, "a", "x\ny", &quiet).unwrap_err().starts_with("[bad_arg]"));
        assert!(replace_line(root, "none.md", 0, "a", "b", &quiet).unwrap_err().starts_with("[not_found]"));
        assert_eq!(fs::read(root.join("d.md")).unwrap(), b"a\n");
    }

    /// A vault folder that was renamed, moved or unplugged: every write is `[no_vault]`, and
    /// nothing recreates the old root (a ghost vault holding one page).
    #[test]
    fn a_lost_vault_folder_is_never_recreated() {
        let t = Tmp::new("lost");
        let root = t.0.join("vault");
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), "# a\n").unwrap();
        let hash = vault::hash(b"# a\n");
        fs::rename(&root, t.0.join("moved")).unwrap();

        let no_vault = |r: Result<Value, String>| r.unwrap_err().starts_with("[no_vault]");
        assert!(no_vault(save_file(&root, "notes/a.md", "# b\n", Some(&hash), Keep::Save, &quiet)));
        assert!(no_vault(save_file(&root, "notes/a.md", "# b\n", None, Keep::Save, &quiet)));
        assert!(no_vault(create_new(&root, "notes/b.md", "# b\n")));
        assert!(no_vault(copy_file(&root, "notes/a.md", "notes/c.md")));
        assert!(no_vault(append_line(&root, "log.md", "x")));
        assert!(no_vault(replace_line(&root, "notes/a.md", 0, "# a", "# b", &quiet)));
        assert!(vault::write_text(&root, "notes/a.md", "# b\n").unwrap_err().starts_with("[no_vault]"));
        assert!(vault::mkdir(&root, "notes").unwrap_err().starts_with("[no_vault]"));
        assert!(versions::keep(&root, "notes/a.md", b"x", true, Reason::Save).unwrap_err().starts_with("[no_vault]"));
        assert!(!root.exists(), "the old vault path stays gone");
    }

    /// An outside writer that writes the page while the save's bytes are being synced wins:
    /// the save answers the conflict with what it wrote, and its bytes are in no file.
    #[test]
    fn an_outside_write_during_the_save_is_a_conflict_not_a_loss() {
        let t = Tmp::new("race");
        let root = &t.0;
        fs::write(root.join("a.md"), "# one\n").unwrap();
        let hash = vault::hash(b"# one\n");
        let outside = || fs::write(root.join("a.md"), "# outside\n").unwrap();
        let first = SaveReq { root: Some(root.as_path()), full: root.join("a.md"), rel: "a.md", text: "# mine\n", expected: Some(&hash), keep: Keep::Save, encoding: None, convert: false };
        let r = save_with(&first, &quiet, &outside).unwrap();
        assert_eq!(r["status"], "conflict");
        assert_eq!(r["disk"]["text"], "# outside\n");
        assert_eq!(r["disk"]["hash"], vault::hash(b"# outside\n"));
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "# outside\n");
        let names: Vec<String> = fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != ".ose")
            .collect();
        assert_eq!(names, vec!["a.md".to_string()], "no temp file left behind");
        assert_eq!(versions::list(root, "a.md").unwrap(), json!([]), "nothing replaced, nothing kept");

        // Without the outside write the save goes through and the old bytes are a version.
        let theirs = vault::hash(b"# outside\n");
        let second = SaveReq { expected: Some(&theirs), ..first };
        let r = save_with(&second, &quiet, &|| {}).unwrap();
        assert_eq!(r["status"], "saved");
        let list = versions::list(root, "a.md").unwrap();
        let id = list[0]["id"].as_str().unwrap().to_string();
        assert_eq!(versions::read(root, "a.md", &id).unwrap(), "# outside\n");
    }

    /// The byte-order mark is a byte of the file, not a character of line 0: `replaceLine`
    /// compares the line without it and keeps it in the output (wave 2's open item).
    #[test]
    fn replace_line_ignores_and_keeps_the_mark() {
        let t = Tmp::new("replace-bom");
        let root = &t.0;
        fs::write(root.join("todo.md"), "\u{feff}- [ ] first\r\n- [ ] second\r\n").unwrap();
        let r = replace_line(root, "todo.md", 0, "- [ ] first", "- [x] first", &quiet).unwrap();
        assert_eq!(r["status"], "replaced");
        assert_eq!(fs::read(root.join("todo.md")).unwrap(), "\u{feff}- [x] first\r\n- [ ] second\r\n".as_bytes());
        // The conflict answer reads the line the way the caller compares it, without the mark.
        let r = replace_line(root, "todo.md", 0, "- [ ] first", "x", &quiet).unwrap();
        assert_eq!(r, json!({ "status": "conflict", "actual": "- [x] first" }));
        // A mark is only ever the first character of the file.
        assert_eq!(replace_line(root, "todo.md", 1, "- [ ] second", "- [x] second", &quiet).unwrap()["status"], "replaced");
        assert_eq!(fs::read(root.join("todo.md")).unwrap(), "\u{feff}- [x] first\r\n- [x] second\r\n".as_bytes());
    }

    /// `createNewBinary` decodes before it creates and never overwrites: a failure leaves no
    /// file, and an existing file keeps its bytes.
    #[test]
    fn create_new_binary_leaves_nothing_on_failure() {
        let t = Tmp::new("binary");
        let root = &t.0;
        let bytes = [0u8, 159, 146, 150, 255];
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let r = create_new_binary(root, "in/a.bin", &data).unwrap();
        assert_eq!(r["path"], "in/a.bin");
        assert_eq!(fs::read(root.join("in/a.bin")).unwrap(), bytes.to_vec());
        assert_eq!(r["hash"], vault::hash(&bytes));
        // Not base64: refused, and nothing is created.
        assert!(create_new_binary(root, "in/b.bin", "***").unwrap_err().starts_with("[bad_arg]"));
        assert!(!root.join("in/b.bin").exists());
        // Taken: refused, the old bytes stay.
        assert!(create_new_binary(root, "in/a.bin", "AAAA").unwrap_err().starts_with("[exists]"));
        assert_eq!(fs::read(root.join("in/a.bin")).unwrap(), bytes.to_vec());
        assert!(create_new_binary(root, "in/bad?.bin", "AAAA").unwrap_err().starts_with("[bad_name]"));
    }

    fn req<'a>(root: &'a Path, rel: &'a str, text: &'a str, expected: Option<&'a str>, encoding: Option<&'a str>) -> SaveReq<'a> {
        SaveReq { root: Some(root), full: root.join(rel), rel, text, expected, keep: Keep::Save, encoding, convert: false }
    }

    /// M52: a file is saved back in its own encoding, byte for byte where it was not edited.
    #[test]
    fn a_save_writes_the_file_s_own_encoding() {
        let t = Tmp::new("encodings");
        let root = t.0.as_path();

        // windows-1252: read, one edit, saved: only the edited bytes change.
        let bytes = b"Caf\xe9 cr\xe8me\r\nna\xefve \x80 5\r\n".to_vec();
        fs::write(root.join("w.txt"), &bytes).unwrap();
        let r = read_file(root, "w.txt").unwrap();
        assert_eq!(r["encoding"], "windows-1252");
        let text = r["text"].as_str().unwrap().replace("crème", "brûlée");
        let hash = r["hash"].as_str().unwrap().to_string();
        let out = save(&req(root, "w.txt", &text, Some(&hash), Some("windows-1252")), &quiet).unwrap();
        assert_eq!(out["status"], "saved");
        assert_eq!(fs::read(root.join("w.txt")).unwrap(), b"Caf\xe9 br\xfbl\xe9e\r\nna\xefve \x80 5\r\n".to_vec());
        assert_eq!(out["hash"], vault::hash(&fs::read(root.join("w.txt")).unwrap()));

        // UTF-16LE with its mark: the mark stays, the text is encoded by hand.
        let text16 = "\u{feff}# Notes\r\nœuvre\r\n";
        let bytes16: Vec<u8> = text16.encode_utf16().flat_map(u16::to_le_bytes).collect();
        fs::write(root.join("u.md"), &bytes16).unwrap();
        let r = read_file(root, "u.md").unwrap();
        assert_eq!((r["encoding"].as_str(), r["bom"].as_bool()), (Some("UTF-16LE"), Some(true)));
        let hash = r["hash"].as_str().unwrap().to_string();
        let edited = text16.replace("œuvre", "oeuvre");
        save(&req(root, "u.md", &edited, Some(&hash), Some("UTF-16LE")), &quiet).unwrap();
        let back: Vec<u8> = edited.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(fs::read(root.join("u.md")).unwrap(), back);

        // A character the encoding cannot hold: refused, nothing written.
        let now = vault::hash(&fs::read(root.join("w.txt")).unwrap());
        let e = save(&req(root, "w.txt", "日本", Some(&now), Some("windows-1252")), &quiet).unwrap_err();
        assert!(e.starts_with("[unencodable]"), "{e}");
        assert_eq!(vault::hash(&fs::read(root.join("w.txt")).unwrap()), now);

        // A file that does not read back exactly in the encoding asked for is not written in it.
        let lossy = [0xFFu8, 0xFE, b'a', 0, 0x00, 0xD8, b'b', 0];
        fs::write(root.join("l.txt"), lossy).unwrap();
        let lossy_hash = vault::hash(&lossy);
        let e = save(&req(root, "l.txt", "\u{feff}ab", Some(&lossy_hash), Some("UTF-16LE")), &quiet).unwrap_err();
        assert!(e.starts_with("[lossy]"), "{e}");
        assert_eq!(fs::read(root.join("l.txt")).unwrap(), lossy.to_vec());
        // A UTF-8 save that was not asked to convert it is refused as well: nothing written.
        let e = save(&req(root, "l.txt", "ab", Some(&lossy_hash), None), &quiet).unwrap_err();
        assert!(e.starts_with("[lossy]"), "{e}");
        assert_eq!(fs::read(root.join("l.txt")).unwrap(), lossy.to_vec());
        // Saving it as UTF-8, asked for, is the explicit way out.
        let out = save(&SaveReq { convert: true, ..req(root, "l.txt", "ab", Some(&lossy_hash), None) }, &quiet).unwrap();
        assert_eq!(out["status"], "saved");
        assert_eq!(fs::read(root.join("l.txt")).unwrap(), b"ab".to_vec());
    }

    /// X10: a UTF-8 save over a windows-1252 file, with the right hash but no `convert`, is
    /// `[lossy]` and leaves every byte; with `convert` it writes. A new file needs nothing.
    #[test]
    fn a_utf8_save_over_another_encoding_needs_convert() {
        let t = Tmp::new("convert");
        let root = t.0.as_path();
        let bytes = b"Caf\xe9 cr\xe8me\r\n".to_vec();
        fs::write(root.join("w.md"), &bytes).unwrap();
        let hash = vault::hash(&bytes);
        let e = save(&req(root, "w.md", "Caf\u{e9} cr\u{e8}me\r\n", Some(&hash), None), &quiet).unwrap_err();
        assert!(e.starts_with("[lossy]"), "{e}");
        assert_eq!(fs::read(root.join("w.md")).unwrap(), bytes);
        let e = save_file(root, "w.md", "x\n", Some(&hash), Keep::Save, &quiet).unwrap_err();
        assert!(e.starts_with("[lossy]"), "{e}");
        assert_eq!(fs::read(root.join("w.md")).unwrap(), bytes);
        let conv = SaveReq { convert: true, ..req(root, "w.md", "Caf\u{e9} cr\u{e8}me\r\n", Some(&hash), None) };
        let out = save(&conv, &quiet).unwrap();
        assert_eq!(out["status"], "saved");
        assert_eq!(fs::read(root.join("w.md")).unwrap(), "Caf\u{e9} cr\u{e8}me\r\n".as_bytes().to_vec());
        // A new file, and a UTF-8 file, need no flag.
        save(&req(root, "n.md", "\u{e9}\n", None, None), &quiet).unwrap();
        save(&req(root, "n.md", "\u{e8}\n", Some(&vault::hash("\u{e9}\n".as_bytes())), None), &quiet).unwrap();
        assert_eq!(fs::read_to_string(root.join("n.md")).unwrap(), "\u{e8}\n");
    }

    /// A file outside every vault is saved with the same compare-and-write, and keeps no version.
    #[test]
    fn an_outside_save_keeps_no_version() {
        let t = Tmp::new("outside-save");
        let dir = t.0.join("loose");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("todo.md"), "one\n").unwrap();
        let r = read_file_at(&dir.join("todo.md"), "abs:todo", None).unwrap();
        let hash = r["hash"].as_str().unwrap().to_string();
        let outside = |text: &'static str, expected: Option<&str>, full: std::path::PathBuf| {
            let req = SaveReq { root: None, full, rel: "abs:todo", text, expected, keep: Keep::Save, encoding: None, convert: false };
            save(&req, &quiet)
        };
        let out = outside("two\n", Some(&hash), dir.join("todo.md")).unwrap();
        assert_eq!(out["status"], "saved");
        assert_eq!(fs::read_to_string(dir.join("todo.md")).unwrap(), "two\n");
        assert!(!dir.join(".ose").exists(), "no history folder beside an outside file");
        // Changed on disk meanwhile: a conflict, nothing written.
        let out = outside("three\n", Some(&hash), dir.join("todo.md")).unwrap();
        assert_eq!(out["status"], "conflict");
        assert_eq!(fs::read_to_string(dir.join("todo.md")).unwrap(), "two\n");
        // A folder that is gone is not recreated.
        let e = outside("x", None, t.0.join("gone").join("x.md")).unwrap_err();
        assert!(e.starts_with("[not_found]"), "{e}");
        assert!(!t.0.join("gone").exists());
    }
}
