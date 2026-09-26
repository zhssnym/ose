//! The filesystem, confined to the vault root: paths, listings, the tree, the search, the
//! atomic writer and the plain writes. What is listed follows the one hide rule (hide.rs); the
//! trash is trashbin.rs.

use std::cmp::Ordering;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};

use tauri::Manager as _;

use crate::Source;

const MAX_DEPTH: usize = 24;
/// Files, not lines (N34): the answer says "showing N of M files" when it cut the list.
pub const DEFAULT_SEARCH_LIMIT: usize = 100;
const SNIPPET: usize = 240;

// ---- root resolution -------------------------------------------------------

/// A folder the executable's walk may adopt on its own: one that already carries our state
/// folder `.ose/`, or a `CLAUDE.md` (the older marker, kept so every existing vault still
/// opens). The source repository has a `CLAUDE.md` too, so a folder that also holds
/// `src-tauri` is the app, not a vault (matters when running from `src-tauri/target/release`
/// during development). A chosen or remembered folder needs no marker at all.
pub fn looks_like_vault(dir: &Path) -> bool {
    (dir.join(".ose").is_dir() || dir.join("CLAUDE.md").is_file()) && !dir.join("src-tauri").is_dir()
}

/// Steps 1 to 3 of the resolution order (docs/HOST.md "The vault root"): `--root` when it is
/// a folder, else the nearest ancestor of the executable that `looks_like_vault` (on macOS the
/// walk climbs out of `Ose.app/Contents/MacOS`), else `OSE_ROOT`. Steps 4 and 5, the remembered
/// root and the picker, need the app handle and happen in `setup`. `None` here no longer
/// means exit: it means "ask".
pub fn resolve_root(explicit: Option<&str>) -> Option<(PathBuf, Source)> {
    if let Some(r) = explicit.filter(|r| !r.is_empty()) {
        let full = normalize(Path::new(r));
        if full.is_dir() {
            return Some((full, Source::Arg));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = root_above(&exe) {
            return Some((d, Source::Exe));
        }
    }

    if let Some(env) = std::env::var_os("OSE_ROOT") {
        let full = normalize(Path::new(&env));
        if full.is_dir() {
            return Some((full, Source::Env));
        }
    }

    None
}

/// The nearest ancestor of `exe` that looks like a vault, the executable's own folder first. A
/// filesystem root (`D:`, `/`) is never one: a stray `.ose` at the top of a drive would make every
/// executable on it open the whole disk.
fn root_above(exe: &Path) -> Option<PathBuf> {
    let mut dir = exe.parent().map(normalize);
    while let Some(d) = dir {
        if d.parent().is_some() && looks_like_vault(&d) {
            return Some(d);
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    None
}

/// The folder the picker opens in and the chooser names: the executable's folder, except that
/// an executable inside a macOS bundle names the folder holding the `.app`.
pub fn suggested_dir(exe: &Path) -> Option<PathBuf> {
    for a in exe.ancestors().skip(1) {
        let is_bundle = a
            .extension()
            .map(|e| e.eq_ignore_ascii_case("app"))
            .unwrap_or(false);
        if is_bundle {
            return a.parent().map(normalize);
        }
    }
    exe.parent().map(normalize)
}

pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|e| suggested_dir(&e))
}

// ---- the remembered root ---------------------------------------------------

/// One line, the vault's absolute path, in `<app config dir>/vault`. Per user, outside every
/// vault, so it survives the vault moving and the exe being dropped anywhere.
pub fn remembered_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("vault"))
}

/// The remembered path as written, if the file names one. Existence is the caller's check.
fn parse_remembered(text: &str) -> Option<PathBuf> {
    let line = text.lines().next()?.trim().trim_start_matches('\u{feff}').trim();
    if line.is_empty() {
        None
    } else {
        Some(normalize(Path::new(line)))
    }
}

/// Step 4: the remembered root, when its file exists and it still names a folder.
pub fn read_remembered(app: &tauri::AppHandle) -> Option<PathBuf> {
    let file = remembered_file(app)?;
    let text = fs::read_to_string(file).ok()?;
    parse_remembered(&text).filter(|p| p.is_dir())
}

pub fn remember(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    let file = remembered_file(app).ok_or("no app config folder on this platform")?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    fs::write(&file, format!("{}\n", root.to_string_lossy()))
        .map_err(|e| format!("{}: {e}", file.display()))
}

/// Deletes the remembered-root file. Nothing to delete is not an error.
pub fn forget(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(file) = remembered_file(app) else { return Ok(()) };
    match fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", file.display())),
    }
}

pub fn is_remembered(app: &tauri::AppHandle) -> bool {
    remembered_file(app).map(|f| f.is_file()).unwrap_or(false)
}

// ---- choosing a vault ------------------------------------------------------

/// Makes `dir` the vault of window `win`: validated, remembered, set, watched, and the window's
/// epoch moved on (docs/HOST.md "Epoch"), so a late write from a page of the previous vault is
/// refused instead of landing here. Answers the normalised root and the new epoch.
pub fn adopt(app: &tauri::AppHandle, host: &crate::Host, win: &crate::Win, dir: &Path, source: Source) -> Result<(PathBuf, u64), String> {
    let full = normalize(dir);
    if !full.is_dir() {
        return Err(crate::coded("not_found", format!("not a folder: {}", full.display())));
    }
    remember(app, &full).map_err(|e| crate::coded("io", e))?;
    let epoch = win.adopt_root(full.clone(), source);
    win.watch(app, full.clone());
    crate::log_line(
        host,
        &format!("{}: vault root {} (from {}, epoch {epoch})", win.label, full.display(), source.as_str()),
    );
    Ok((full, epoch))
}

/// Absolute and lexically clean, without `canonicalize`: on Windows that returns a `\\?\`
/// verbatim path, which leaks into every path we hand back to the UI.
pub fn normalize(p: &Path) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A name or a path the host sends out, in NFC on macOS (M49): APFS hands back the NFD a Finder
/// rename wrote, and a link typed on the keyboard is NFC, so the two would never compare equal.
/// Paths coming in are used as given, since APFS lookups ignore normalisation. Everywhere else
/// the string is returned untouched.
pub fn nfc(s: String) -> String {
    if cfg!(target_os = "macos") {
        to_nfc(s)
    } else {
        s
    }
}

/// `s` in Unicode Normalization Form C, on every platform (the pure half of `nfc`, tested
/// everywhere though only macOS uses it).
pub fn to_nfc(s: String) -> String {
    use unicode_normalization::{is_nfc_quick, IsNormalized, UnicodeNormalization as _};
    if is_nfc_quick(s.chars()) == IsNormalized::Yes {
        return s;
    }
    s.nfc().collect()
}

pub fn root_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string_lossy().to_string())
}

// ---- paths -----------------------------------------------------------------

/// Vault-relative, forward slashes (a backslash too on Windows, where it is a separator), no
/// leading slash, never escaping the root. Built segment by segment from the root, so escaping
/// is impossible rather than merely checked.
///
/// The path is taken literally (M49): nothing is trimmed, and nothing is redirected. A `..`
/// is refused rather than folded into its parent, and on Windows a segment the system would
/// silently turn into another name — one ending in a dot or a space, or a device name such as
/// `CON` or `nul.md` — is refused as `[bad_name]` instead of reaching a different file.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let cleaned = if cfg!(windows) { rel.replace('\\', "/") } else { rel.to_string() };
    let cleaned = cleaned.trim_start_matches('/');
    if cleaned.is_empty() {
        return Ok(root.to_path_buf());
    }

    let mut out = root.to_path_buf();
    for seg in cleaned.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                return Err(crate::coded("escapes_vault", format!("path escapes the vault: {rel}")));
            }
            s => {
                // A segment holding a drive letter or a NUL would rewrite the path instead of
                // extending it, so it is rejected outright.
                if s.contains('\0') || (cfg!(windows) && s.contains(':')) {
                    return Err(crate::coded("escapes_vault", format!("path must be vault-relative: {rel}")));
                }
                if cfg!(windows) && redirected_on_windows(s) {
                    return Err(crate::coded("bad_name", format!("Windows would read another name for: {rel}")));
                }
                out.push(s);
            }
        }
    }
    Ok(out)
}

/// A segment Windows does not take as written: a trailing dot or space is dropped by the
/// system, and a device stem (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, with
/// any extension) names a device instead of a file.
fn redirected_on_windows(seg: &str) -> bool {
    if seg.ends_with('.') || seg.ends_with(' ') {
        return true;
    }
    let stem = seg.split('.').next().unwrap_or(seg).trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// The inverse: an absolute path back to its vault-relative form, NFC on macOS (`nfc`).
pub fn relative(root: &Path, full: &Path) -> String {
    let rel = match full.strip_prefix(root) {
        Ok(rest) => rest.to_string_lossy().replace('\\', "/"),
        Err(_) => full.to_string_lossy().replace('\\', "/"),
    };
    nfc(rel)
}

fn ms(t: Option<SystemTime>) -> i64 {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_of(meta: &fs::Metadata) -> i64 {
    ms(meta.modified().ok())
}

// ---- nodes -----------------------------------------------------------------

/// One entry of a listing or of the tree (docs/HOST.md "Entry"). `kind` is what a link points
/// at when the entry is a link; `link` says it is one and what kind; `readable: false` marks a
/// folder the host could not open; `children` is filled by `tree` alone, never under a link.
#[derive(Serialize, Debug, specta::Type)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub ext: String,
    pub mtime: i64,
    pub size: u64,
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub link: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub readable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub children: Option<Vec<Entry>>,
}

/// The node for `full`, whose own metadata (never followed through a link) is `own`. A link is
/// described by its target when the target is there (`hide::link_kind`); a broken one by the
/// link itself.
fn node_of(root: &Path, root_canon: &Path, full: &Path, own: &fs::Metadata) -> Entry {
    let name = nfc(full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default());
    let (link, target) = if own.file_type().is_symlink() {
        let (kind, meta) = crate::hide::link_kind(root_canon, full);
        (Some(kind), meta)
    } else {
        (None, None)
    };
    let meta = target.as_ref().unwrap_or(own);
    let is_dir = meta.is_dir();
    Entry {
        ext: if is_dir {
            String::new()
        } else {
            full.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        },
        path: relative(root, full),
        hidden: crate::hide::hidden_name(&name) || crate::hide::os_hidden(own),
        name,
        kind: if is_dir { "dir" } else { "file" },
        mtime: mtime_of(meta),
        size: if is_dir { 0 } else { meta.len() },
        link,
        readable: None,
        children: None,
    }
}

fn sort(nodes: &mut [Entry]) {
    nodes.sort_by(|a, b| {
        if a.kind != b.kind {
            return if a.kind == "dir" {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        natural_compare(&a.name, &b.name)
    });
}

/// "2. Foo" before "10. Foo": runs of digits compare as numbers, everything else
/// case-insensitively. Same algorithm as the .NET host so both hosts sort identically.
pub fn natural_compare(a: &str, b: &str) -> Ordering {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (mut i, mut j) = (0usize, 0usize);

    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let (si, sj) = (i, j);
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let na = trim_zeros(&a[si..i]);
            let nb = trim_zeros(&b[sj..j]);
            if na.len() != nb.len() {
                return na.len().cmp(&nb.len());
            }
            match Ord::cmp(na, nb) {
                Ordering::Equal => {}
                other => return other,
            }
        } else {
            let ca = lower(a[i]);
            let cb = lower(b[j]);
            if ca != cb {
                return ca.cmp(&cb);
            }
            i += 1;
            j += 1;
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}

fn trim_zeros(s: &[char]) -> &[char] {
    let mut k = 0;
    while k < s.len() && s[k] == '0' {
        k += 1;
    }
    &s[k..]
}

fn lower(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

// ---- reads -----------------------------------------------------------------

pub fn root_info(root: &Path) -> Value {
    json!({ "root": root.to_string_lossy(), "name": root_name(root) })
}

/// A vault path the rule excludes is not there as far as a listing is concerned.
fn refuse_excluded(root: &Path, rel: &str) -> Result<(), String> {
    if crate::hide::excluded(root, rel) {
        return Err(crate::coded("not_found", format!("not listed: {rel}")));
    }
    Ok(())
}

/// `list(path, {hidden})`: the entries of one folder, folders first, then natural name order.
/// Excluded entries never appear; hidden ones only with `hidden`. A folder reached through a
/// link is listed only when the link's target is inside the vault (`[escapes_vault]`
/// otherwise). A child folder that cannot be opened says `readable: false`.
pub fn list(root: &Path, rel: &str, hidden: bool) -> Result<Vec<Entry>, String> {
    refuse_excluded(root, rel)?;
    let dir = resolve(root, rel)?;
    match fs::metadata(&dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(crate::coded("not_found", format!("not a folder: {rel}"))),
        Err(e) => return Err(crate::io_error(rel, &e)),
    }
    let root_canon = crate::hide::canonical_root(root);
    if let Ok(real) = fs::canonicalize(&dir) {
        if !real.starts_with(&root_canon) {
            return Err(crate::coded("escapes_vault", format!("the folder is a link out of the vault: {rel}")));
        }
    }
    let entries = fs::read_dir(&dir).map_err(|e| crate::io_error(rel, &e))?;
    let mut nodes = Vec::new();
    for entry in entries.flatten() {
        let full = entry.path();
        let child = relative(root, &full);
        let Ok(own) = entry.metadata() else { continue };
        match crate::hide::classify(root, &child, Some(&own)) {
            crate::hide::Visibility::Excluded => continue,
            crate::hide::Visibility::Hidden if !hidden => continue,
            _ => {}
        }
        let mut node = node_of(root, &root_canon, &full, &own);
        if node.kind == "dir" && node.link.is_none() && fs::read_dir(&full).is_err() {
            node.readable = Some(false);
        }
        nodes.push(node);
    }
    sort(&mut nodes);
    Ok(nodes)
}

type ByParent = std::collections::HashMap<PathBuf, Vec<(PathBuf, Entry)>>;

/// `tree({hidden})`: the whole vault as one node named after it, walked by the `ignore` crate
/// under the one rule (hide.rs `walker`), never into a link, at most `MAX_DEPTH` folders deep.
pub fn tree(root: &Path, hidden: bool) -> Result<Entry, String> {
    let meta = fs::metadata(root).map_err(|e| crate::coded("io", format!("cannot read the vault root: {e}")))?;
    let root_canon = crate::hide::canonical_root(root);
    // Every entry under the folder that holds it, and the folders that could not be read.
    let mut by_parent: ByParent = Default::default();
    let mut unreadable: std::collections::HashSet<PathBuf> = Default::default();
    for item in crate::hide::walker(root, root, hidden, MAX_DEPTH + 1) {
        match item {
            Ok(e) if e.depth() > 0 => {
                let full = e.path().to_path_buf();
                // The walker's own metadata of the entry, never followed through a link (on
                // Windows it comes with the directory listing, no extra call per file).
                let Ok(own) = e.metadata() else { continue };
                let node = node_of(root, &root_canon, &full, &own);
                let parent = full.parent().map(Path::to_path_buf).unwrap_or_default();
                by_parent.entry(parent).or_default().push((full, node));
            }
            Ok(_) => {}
            Err(e) => {
                if let Some(p) = crate::hide::error_path(&e) {
                    unreadable.insert(p);
                }
            }
        }
    }
    let children = assemble(root, &mut by_parent, &unreadable);
    Ok(Entry {
        name: root_name(root),
        path: String::new(),
        kind: "dir",
        ext: String::new(),
        mtime: mtime_of(&meta),
        size: 0,
        hidden: false,
        link: None,
        readable: None,
        children: Some(children),
    })
}

/// The nodes under `dir`, each folder (not a link) given its own, sorted at every level.
fn assemble(dir: &Path, by_parent: &mut ByParent, unreadable: &std::collections::HashSet<PathBuf>) -> Vec<Entry> {
    let mut out = Vec::new();
    for (full, mut node) in by_parent.remove(dir).unwrap_or_default() {
        if node.kind == "dir" && node.link.is_none() {
            if unreadable.contains(&full) {
                node.readable = Some(false);
            }
            node.children = Some(assemble(&full, by_parent, unreadable));
        }
        out.push(node);
    }
    sort(&mut out);
    out
}

/// How many bytes `stat(path, {sniff})` looks at.
const SNIFF_BYTES: usize = 8192;

fn read_head(full: &Path) -> Option<Vec<u8>> {
    use std::io::Read as _;
    let f = fs::File::open(full).ok()?;
    let mut buf = Vec::with_capacity(SNIFF_BYTES);
    f.take(SNIFF_BYTES as u64).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// `stat(path, {sniff})` -> `{exists, kind, mtime, size, hidden, link?, text?, encoding?}`. A link
/// is described by its target and says what kind of link it is. `text` only with `sniff`, for a
/// file: whether it reads as text in some encoding, and `encoding` which one
/// (encoding.rs `sniff`).
pub fn stat(root: &Path, rel: &str, sniff: bool) -> Result<Value, String> {
    let full = resolve(root, rel)?;
    let Ok(own) = fs::symlink_metadata(&full) else {
        return Ok(json!({ "exists": false, "kind": null, "mtime": 0, "size": 0, "hidden": false }));
    };
    let root_canon = crate::hide::canonical_root(root);
    let node = node_of(root, &root_canon, &full, &own);
    let mut out = json!({
        "exists": true,
        "kind": node.kind,
        "mtime": node.mtime,
        "size": node.size,
        "hidden": crate::hide::classify(root, rel, Some(&own)) != crate::hide::Visibility::Shown,
    });
    if let Some(link) = node.link {
        out["link"] = json!(link);
    }
    if sniff && node.kind == "file" {
        add_sniff(&mut out, &full);
    }
    Ok(out)
}

/// `text` and `encoding` of a file, from its first 8 KB.
fn add_sniff(out: &mut Value, full: &Path) {
    let head = read_head(full).unwrap_or_default();
    match crate::encoding::sniff(&head, head.len() >= SNIFF_BYTES) {
        Some(enc) => {
            out["text"] = json!(true);
            out["encoding"] = json!(enc);
        }
        None => out["text"] = json!(false),
    }
}

/// `stat` of a file outside the vault (`abs:`), which no hide rule covers.
pub fn stat_outside(full: &Path, sniff: bool) -> Value {
    let Ok(meta) = fs::metadata(full) else {
        return json!({ "exists": false, "kind": null, "mtime": 0, "size": 0, "hidden": false });
    };
    let is_dir = meta.is_dir();
    let mut out = json!({
        "exists": true,
        "kind": if is_dir { "dir" } else { "file" },
        "mtime": mtime_of(&meta),
        "size": if is_dir { 0 } else { meta.len() },
        "hidden": false,
    });
    if sniff && !is_dir {
        add_sniff(&mut out, full);
    }
    out
}

pub fn exists(root: &Path, rel: &str) -> Result<bool, String> {
    Ok(resolve(root, rel)?.exists())
}

/// UTF-8, exactly the characters the file holds: line endings untouched, and a byte-order mark
/// kept (F14). The mark is a byte of the file, not a character of the document, and the editor
/// is the one place that knows the difference: `doc.js parseDoc` strips it and `serializeDoc`
/// puts it back, so a file that had one still has one after a save. Stripping it here made that
/// code unreachable and lost the mark on the first edit.
pub fn read_text(root: &Path, rel: &str) -> Result<String, String> {
    let full = resolve(root, rel)?;
    let bytes = fs::read(&full).map_err(|e| crate::io_error(rel, &e))?;
    String::from_utf8(bytes).map_err(|_| crate::coded("not_utf8", format!("not valid UTF-8: {rel}")))
}

// ---- the hash --------------------------------------------------------------

/// FNV-1a, 64 bits, over the file's raw bytes, as 16 lowercase hex digits (docs/HOST.md
/// "Hash"). It is how the page says "the text I started from" without sending it back: the page
/// never computes one, it carries what `readFile` and `saveFile` answered and compares by
/// equality. Not a defence against anyone, only a fingerprint of a file's bytes.
pub fn hash(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

// ---- writes ----------------------------------------------------------------

/// The vault folder must still be there before anything is written into it. A root that was
/// renamed, moved or unplugged is `[no_vault]`, never recreated: `create_dir_all` under a lost
/// root would build an empty ghost vault at the old path, and the page written into it would be
/// the only thing there while the real vault is elsewhere.
pub(crate) fn require_vault(root: &Path) -> Result<(), String> {
    if root.is_dir() {
        Ok(())
    } else {
        Err(crate::coded("no_vault", format!("the vault folder is gone: {}", root.display())))
    }
}

/// The folders above `full`, created when missing, inside a vault folder that still exists.
pub(crate) fn ensure_parent(root: &Path, full: &Path) -> Result<(), String> {
    require_vault(root)?;
    if full.file_name().is_none() {
        return Err(crate::coded("bad_arg", "no file name to write"));
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| crate::coded("io", format!("{}: {e}", parent.display())))?;
    }
    Ok(())
}

/// How long a rename that the system refuses for a moment is tried again: about two seconds,
/// in steps of 10, 20, 40 … ms (C3). That is the time an antivirus scan, the search indexer or
/// a sync client takes to let go of a file it opened the moment it appeared.
pub(crate) const RENAME_BUDGET_MS: u64 = 2000;

/// Why `write_atomic` failed, and where the new bytes are when they survived it.
#[derive(Debug)]
pub struct WriteFailure {
    pub error: std::io::Error,
    /// The file holding the new bytes after a rename that never went through: a visible
    /// `<stem>.unsaved-<yyyymmdd-hhmmss>.<ext>` beside the target, or the temp file itself when
    /// even that rename was refused. `None` when the bytes never reached the disk.
    pub kept: Option<PathBuf>,
}

impl WriteFailure {
    /// `[write_failed] <what>: <os error>; your text is in <where>`. `root` turns the kept
    /// file's path into a vault path when it is inside the vault.
    pub fn message(&self, what: &str, root: Option<&Path>) -> String {
        match &self.kept {
            Some(p) => {
                let at = match root {
                    Some(r) if p.starts_with(r) => relative(r, p),
                    _ => p.display().to_string(),
                };
                crate::coded("write_failed", format!("{what}: {}; your text is in {at}", self.error))
            }
            None => crate::coded("write_failed", format!("{what}: {}", self.error)),
        }
    }
}

/// Write `bytes` to `full` so that the target is always either the old bytes or the new ones
/// (S25, C3), and the new ones are never thrown away:
///
/// 1. a temp file beside the target (`.<name>.<pid>.<n>.tmp`, the pid and a counter so two
///    writes to one path cannot share it), written and `sync_all`ed;
/// 2. `rename` onto the target. There is no delete first: `std::fs::rename` replaces an
///    existing file on Windows too (`MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`). The old
///    code deleted the note first "because Windows refuses", which was false, and when the
///    rename then failed both the old and the new text were gone;
/// 3. a rename refused with a sharing violation or access denied (Windows errors 32 and 5, what
///    a scanner or a sync client holding the fresh temp file causes) is tried again with
///    backoff for about two seconds. A target with the read-only attribute is refused for good
///    with the same error 5, so it fails at once (`the file is read-only`) and nothing is set
///    aside: the caller still holds the bytes;
/// 4. once the bytes are on disk they are never deleted. A rename that still fails moves the
///    temp file to a visible `<stem>.unsaved-<stamp>.<ext>` beside the target (or leaves it
///    where it is when even that is refused), and the failure says where. One set-aside per
///    target per run: the next failure replaces the copy this process made, so a save retried
///    for an hour leaves one file, not one a minute;
/// 5. on unix the folder is fsynced after the rename, so the new name survives a power cut.
///
/// A temp file whose own write failed (a full disk) is removed: it holds half the new bytes and
/// the target was never touched.
pub fn write_atomic(full: &Path, bytes: &[u8]) -> Result<(), WriteFailure> {
    write_atomic_with(full, bytes, RENAME_BUDGET_MS, Aside::Visible, &|_| Ok(()))
}

/// `write_atomic` for a file the app owns (a draft, a version, `.ose/state.json`): the bytes are
/// still in memory and the file is the app's bookkeeping, so a rename that never goes through
/// removes the temp file instead of setting a copy aside, after `budget_ms` of retries.
pub fn write_atomic_owned(full: &Path, bytes: &[u8], budget_ms: u64) -> Result<(), WriteFailure> {
    write_atomic_with(full, bytes, budget_ms, Aside::Discard, &|_| Ok(()))
}

/// What a rename that never goes through does with the temp file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Aside {
    /// set it aside where a person sees it (a vault file: those bytes may exist nowhere else)
    Visible,
    /// remove it (a file the app owns, whose bytes the caller still has)
    Discard,
}

/// `write_atomic` with the retry budget, what a failure does with the temp file, and a check
/// called on the temp file just before the first rename. The check answering `Err` stops the
/// write: the temp file is removed, the target is untouched, and the failure carries that
/// error with nothing kept. `saveFile` uses it to look at the target once more, so an outside
/// write made while the new bytes were being synced is never replaced (the tests also use it to
/// hold the temp file open the way a scanner does).
pub(crate) fn write_atomic_with(
    full: &Path,
    bytes: &[u8],
    budget_ms: u64,
    aside: Aside,
    before_rename: &dyn Fn(&Path) -> std::io::Result<()>,
) -> Result<(), WriteFailure> {
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, AtomicOrdering::Relaxed);
    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let tmp = full.with_file_name(format!(".{name}.{}.{n}.tmp", std::process::id()));
    let write = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(error) = write {
        let _ = fs::remove_file(&tmp);
        return Err(WriteFailure { error, kept: None });
    }

    if let Err(error) = before_rename(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(WriteFailure { error, kept: None });
    }

    let mut waited = 0u64;
    let mut step = 10u64;
    loop {
        match fs::rename(&tmp, full) {
            Ok(()) => {
                sync_dir(full);
                return Ok(());
            }
            Err(_) if read_only(full) => {
                let _ = fs::remove_file(&tmp);
                let error = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "the file is read-only");
                return Err(WriteFailure { error, kept: None });
            }
            Err(e) if transient(&e) && waited < budget_ms => {
                let pause = step.min(budget_ms - waited);
                std::thread::sleep(std::time::Duration::from_millis(pause));
                waited += pause;
                step = (step * 2).min(640);
            }
            Err(error) if aside == Aside::Discard => {
                let _ = fs::remove_file(&tmp);
                return Err(WriteFailure { error, kept: None });
            }
            Err(error) => {
                let kept = keep_unsaved(&tmp, full);
                return Err(WriteFailure { error, kept: Some(kept) });
            }
        }
    }
}

/// A target whose read-only attribute makes every rename over it fail, for good. Windows only:
/// elsewhere a rename over a file is the folder's business, not the file's mode.
fn read_only(full: &Path) -> bool {
    cfg!(windows) && fs::metadata(full).map(|m| m.permissions().readonly()).unwrap_or(false)
}

/// The two refusals that pass: a sharing violation (32), access denied (5), and the lock
/// violation (33) a byte-range lock gives, on Windows; a busy file elsewhere.
fn transient(e: &std::io::Error) -> bool {
    match e.raw_os_error() {
        Some(code) if cfg!(windows) => matches!(code, 5 | 32 | 33),
        Some(code) => code == 16, // EBUSY
        None => false,
    }
}

type AsideMap = std::sync::Mutex<std::collections::HashMap<PathBuf, PathBuf>>;

/// The set-aside this process made for each target, so the next failure of the same target
/// replaces it instead of adding one more.
fn asides() -> &'static AsideMap {
    static ASIDES: std::sync::OnceLock<AsideMap> = std::sync::OnceLock::new();
    ASIDES.get_or_init(Default::default)
}

/// The new bytes, out of the hidden temp file and into a name a person sees in the tree:
/// `<stem>.unsaved-<yyyymmdd-hhmmss>.<ext>` beside the target (`-2`, `-3` … when taken). The
/// copy this process already set aside for the same target is replaced: the later buffer
/// holds the earlier one's typing and more. A copy from another run is never touched. When the
/// rename is refused too, the temp file stays where it is. Answers where the bytes are.
fn keep_unsaved(tmp: &Path, full: &Path) -> PathBuf {
    let mut made = asides().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(earlier) = made.get(full).cloned() {
        if earlier.is_file() && fs::rename(tmp, &earlier).is_ok() {
            return earlier;
        }
    }
    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.clone(), String::new()),
    };
    let stamp = unsaved_stamp();
    for k in 1..100 {
        let tag = if k == 1 { String::new() } else { format!("-{k}") };
        let candidate = full.with_file_name(format!("{stem}.unsaved-{stamp}{tag}{ext}"));
        if candidate.exists() {
            continue;
        }
        return match fs::rename(tmp, &candidate) {
            Ok(()) => {
                made.insert(full.to_path_buf(), candidate.clone());
                candidate
            }
            Err(_) => tmp.to_path_buf(),
        };
    }
    tmp.to_path_buf()
}

/// `20260925-101500`, UTC: the time an unsaved copy was set aside.
fn unsaved_stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = crate::civil_from_days(days);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// The rename is durable only once the folder's own entry is on disk: fsync the folder on
/// unix. Windows has no such call for a folder, and NTFS journals the rename itself.
#[cfg(unix)]
fn sync_dir(full: &Path) {
    if let Some(parent) = full.parent() {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
}

#[cfg(not(unix))]
fn sync_dir(_full: &Path) {}

/// UTF-8, the bytes exactly as given: nothing is added and nothing is stripped, so a text that
/// starts with a byte-order mark is written back with it and one that does not never gains one.
pub fn write_text(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    ensure_parent(root, &full)?;
    write_atomic(&full, text.as_bytes()).map_err(|f| f.message(rel, Some(root)))
}

pub fn append_text(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    ensure_parent(root, &full)?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&full)
        .map_err(|e| crate::io_error(rel, &e))?;
    f.write_all(text.as_bytes()).map_err(|e| crate::io_error(rel, &e))
}

pub fn write_binary(root: &Path, rel: &str, b64: &str) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| crate::coded("bad_arg", format!("not base64: {e}")))?;
    let full = resolve(root, rel)?;
    ensure_parent(root, &full)?;
    write_atomic(&full, &bytes).map_err(|f| f.message(rel, Some(root)))
}

/// The file's bytes as base64 (`ose.files.readBinary`). The counterpart of `write_binary`,
/// and the only way a module reads something that is not text without going through the
/// `vault` origin, which is for the DOM rather than for code.
pub fn read_binary(root: &Path, rel: &str) -> Result<String, String> {
    let full = resolve(root, rel)?;
    let bytes = fs::read(&full).map_err(|e| crate::io_error(rel, &e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub fn mkdir(root: &Path, rel: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    require_vault(root)?;
    fs::create_dir_all(&full).map_err(|e| crate::io_error(rel, &e))
}

/// Never overwrites: the .NET host moved with `overwrite: false` and the UI relies on that
/// to keep a rename from swallowing an existing page. The move itself refuses to replace
/// (`rename_noreplace`), so a file that appears at the target between the look and the move
/// is not replaced either (M50).
///
/// `Notes.md` -> `notes.md` is a real rename, not a collision (N17). On a case-insensitive
/// filesystem the target "exists" because it is the same file, and `fs::rename` may or may not
/// change the name on disk, so a case-only change of one file goes through a temporary name:
/// two renames, neither of which can be mistaken for an overwrite. On a case-sensitive volume
/// the two names can be two files; `same_file` tells them apart, and a different file there is
/// `[exists]`, never replaced.
pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let src = resolve(root, from)?;
    let dst = resolve(root, to)?;
    if fs::symlink_metadata(&src).is_err() {
        return Err(crate::coded("not_found", format!("nothing to rename: {from}")));
    }
    if src == dst {
        return Ok(());
    }
    let taken = fs::symlink_metadata(&dst).is_ok();
    if case_only(&src, &dst) && taken {
        if !same_file::is_same_file(&src, &dst).unwrap_or(false) {
            return Err(crate::coded("exists", format!("target already exists: {to}")));
        }
        ensure_parent(root, &dst)?;
        let name = dst
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "item".into());
        let via = src.with_file_name(format!(".{name}.{}.case", std::process::id()));
        if fs::symlink_metadata(&via).is_ok() {
            return Err(crate::coded("io", format!("{from} -> {to}: {} is in the way", via.display())));
        }
        fs::rename(&src, &via).map_err(|e| crate::coded("io", format!("{from} -> {to}: {e}")))?;
        return match rename_noreplace(&via, &dst) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = fs::rename(&via, &src);
                Err(move_error(from, to, &e))
            }
        };
    }
    if taken {
        return Err(crate::coded("exists", format!("target already exists: {to}")));
    }
    ensure_parent(root, &dst)?;
    rename_noreplace(&src, &dst).map_err(|e| move_error(from, to, &e))
}

fn move_error(from: &str, to: &str, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::AlreadyExists {
        crate::coded("exists", format!("target already exists: {to}"))
    } else {
        crate::coded("io", format!("{from} -> {to}: {e}"))
    }
}

/// A rename that never replaces what is at `to`: `MoveFileExW` without
/// `MOVEFILE_REPLACE_EXISTING` on Windows, `renamex_np(RENAME_EXCL)` on macOS. Elsewhere a look
/// then a rename, which is what the other platforms had before. `AlreadyExists` when taken.
#[cfg(windows)]
pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(std::iter::once(0)).collect() };
    let (a, b) = (wide(from), wide(to));
    // Safe: both strings are NUL-terminated and outlive the call; flags 0 never replaces.
    let ok = unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0) };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt as _;
    extern "C" {
        fn renamex_np(from: *const std::ffi::c_char, to: *const std::ffi::c_char, flags: std::ffi::c_uint) -> std::ffi::c_int;
    }
    const RENAME_EXCL: std::ffi::c_uint = 0x0000_0004;
    let c = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput));
    let (a, b) = (c(from)?, c(to)?);
    // Safe: both are NUL-terminated C strings that outlive the call.
    if unsafe { renamex_np(a.as_ptr(), b.as_ptr(), RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(to).is_ok() {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    fs::rename(from, to)
}

/// Two vault paths that differ only in letter case — the same file on Windows and on a
/// default macOS volume, possibly two files on a case-sensitive one (`rename` asks
/// `same_file` which it is).
pub(crate) fn case_only(a: &Path, b: &Path) -> bool {
    let (a, b) = (a.to_string_lossy(), b.to_string_lossy());
    a != b && a.to_lowercase() == b.to_lowercase()
}

// ---- copying a file or a folder --------------------------------------------

/// `copyPath(from, to)` -> `{path, files, leftOut?}`: a file or a whole folder, byte for byte,
/// into a new `to`. Create-only: `[exists]` when anything is at `to`, and every file inside is
/// opened exclusively. Missing parents are made. A link is copied as a link, never followed: a
/// junction as a junction, a symlink as a symlink, and on Windows a folder symlink the system
/// will not let this process create (no Developer Mode, not elevated) as a junction to the same
/// folder. A file symlink that cannot be made is left out, logged, and named in `leftOut` (the
/// vault paths of the links under `from` that were not copied, present only when there are
/// any), so the page can say the copy is
/// not whole; copying such a link on its own is an error. A folder cannot be copied into itself,
/// compared the way the filesystem compares (case-insensitively on Windows and macOS, and
/// through links). When a folder copy fails half-way, the new folder is removed: it was created
/// by this call and holds nothing that is not still at `from`. `files` counts the files and
/// links written.
pub fn copy_path(root: &Path, from: &str, to: &str) -> Result<Value, String> {
    let src = resolve(root, from)?;
    let dst = resolve(root, to)?;
    require_vault(root)?;
    if dst == *root || dst.file_name().is_none() {
        return Err(crate::coded("bad_name", format!("not a name to copy to: {to}")));
    }
    let own = fs::symlink_metadata(&src).map_err(|e| crate::io_error(from, &e))?;
    if fs::symlink_metadata(&dst).is_ok() {
        return Err(crate::coded("exists", format!("already exists: {to}")));
    }
    if own.is_dir() && inside_or_same(&dst, &src) {
        return Err(crate::coded("bad_arg", format!("a folder cannot be copied into itself: {from} -> {to}")));
    }
    ensure_parent(root, &dst)?;
    let mut files = 0usize;
    let mut left_out: Vec<String> = Vec::new();
    if own.file_type().is_symlink() {
        copy_link(&src, &dst).map_err(|e| copy_error(to, &e))?;
        files = 1;
    } else if own.is_dir() {
        fs::create_dir(&dst).map_err(|e| copy_error(to, &e))?;
        let mut left = |link: &Path, e: &std::io::Error| {
            let rel = relative(root, link);
            log::warn!("copyPath: link {rel} left out: {e}");
            left_out.push(rel);
        };
        if let Err(e) = copy_tree(&src, &dst, &mut files, &mut left) {
            let _ = fs::remove_dir_all(&dst);
            return Err(copy_error(to, &e));
        }
    } else {
        copy_one(&src, &dst).map_err(|e| copy_error(to, &e))?;
        files = 1;
    }
    let mut out = json!({ "path": relative(root, &dst), "files": files });
    if !left_out.is_empty() {
        out["leftOut"] = json!(left_out);
    }
    Ok(out)
}

/// Is `dst` (which need not exist yet) `src` or somewhere under it? By the spelling, ignoring
/// case where the filesystem folds it (`Notes` -> `notes/Notes copy` is inside), and by the
/// canonical paths of `src` and of `dst`'s nearest existing ancestor, so a link or a junction on
/// the way cannot hide it.
pub(crate) fn inside_or_same(dst: &Path, src: &Path) -> bool {
    let folded = |p: &Path| -> PathBuf {
        let s = p.to_string_lossy().replace('\\', "/");
        PathBuf::from(if cfg!(any(windows, target_os = "macos")) { s.to_lowercase() } else { s })
    };
    if folded(dst).starts_with(folded(src)) {
        return true;
    }
    let Ok(src_canon) = fs::canonicalize(src) else { return false };
    let mut base = dst;
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    let canon = loop {
        if let Ok(c) = fs::canonicalize(base) {
            break c;
        }
        match (base.file_name(), base.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                base = parent;
            }
            _ => return false,
        }
    };
    let dst_canon = rest.iter().rev().fold(canon, |acc, n| acc.join(n));
    folded(&dst_canon).starts_with(folded(&src_canon))
}

fn copy_error(to: &str, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::AlreadyExists {
        crate::coded("exists", format!("already exists: {to}"))
    } else {
        crate::coded("io", format!("{to}: {e}"))
    }
}

/// One file's bytes into a new file, opened exclusively and synced.
fn copy_one(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut input = fs::File::open(src)?;
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(dst)?;
    let copied = std::io::copy(&mut input, &mut out).and_then(|_| out.sync_all());
    if copied.is_err() {
        drop(out);
        let _ = fs::remove_file(dst);
    }
    copied
}

/// Everything under `src` into the existing, empty `dst`. A link that cannot be recreated is
/// handed to `left_out` and the copy goes on.
fn copy_tree(
    src: &Path,
    dst: &Path,
    files: &mut usize,
    left_out: &mut dyn FnMut(&Path, &std::io::Error),
) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let (from, to) = (entry.path(), dst.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            match copy_link(&from, &to) {
                Ok(()) => *files += 1,
                Err(e) => left_out(&from, &e),
            }
        } else if kind.is_dir() {
            fs::create_dir(&to)?;
            copy_tree(&from, &to, files, left_out)?;
        } else {
            copy_one(&from, &to)?;
            *files += 1;
        }
    }
    Ok(())
}

/// A link as a link: the same target text, never what it points at.
fn copy_link(src: &Path, dst: &Path) -> std::io::Result<()> {
    let target = fs::read_link(src)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt as _;
        let dir_link = fs::symlink_metadata(src).map(|m| m.file_type().is_symlink_dir()).unwrap_or(false);
        if !dir_link {
            return std::os::windows::fs::symlink_file(&target, dst);
        }
        // A junction stays a junction; a folder symlink stays a symlink when the system allows
        // it, and becomes a junction to the same folder when it does not (a junction needs no
        // privilege, and resolves to the same place).
        let absolute = || if target.is_absolute() { target.clone() } else { src.parent().unwrap_or(src).join(&target) };
        if junction::is_junction(src) {
            return junction::create(&absolute(), dst);
        }
        match std::os::windows::fs::symlink_dir(&target, dst) {
            Err(e) if e.raw_os_error() == Some(junction::ERROR_PRIVILEGE_NOT_HELD) => junction::create(&absolute(), dst),
            other => other,
        }
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(&target, dst)
    }
}

/// NTFS junctions (mount points), which `std` reads through `read_link` but can neither tell
/// apart from folder symlinks nor make. A junction needs no privilege: it is how a folder link
/// is copied on a Windows machine without Developer Mode, as `mklink /J` would make it.
#[cfg(windows)]
pub(crate) mod junction {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::ffi::OsStrExt as _;
    use std::path::Path;

    pub const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_READ_ATTRIBUTES: u32 = 0x80;
    const FILE_SHARE_ALL: u32 = 7;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const FILE_ATTRIBUTE_TAG_INFO: i32 = 9;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    struct AttributeTagInfo {
        attributes: u32,
        tag: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(name: *const u16, access: u32, share: u32, sec: *mut c_void, disposition: u32, flags: u32, template: isize) -> isize;
        fn DeviceIoControl(
            h: isize,
            code: u32,
            inbuf: *const c_void,
            inlen: u32,
            outbuf: *mut c_void,
            outlen: u32,
            ret: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
        fn GetFileInformationByHandleEx(h: isize, class: i32, out: *mut c_void, len: u32) -> i32;
        fn CloseHandle(h: isize) -> i32;
    }

    /// The entry itself, never what it points at.
    fn open(p: &Path, access: u32) -> io::Result<isize> {
        let name: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // Safe: a NUL-terminated name, no security attributes, no template.
        let h = unsafe {
            CreateFileW(
                name.as_ptr(),
                access,
                FILE_SHARE_ALL,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                0,
            )
        };
        if h == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(h)
        }
    }

    /// Is `p` itself a junction?
    pub fn is_junction(p: &Path) -> bool {
        let Ok(h) = open(p, FILE_READ_ATTRIBUTES) else { return false };
        let mut info = AttributeTagInfo { attributes: 0, tag: 0 };
        // Safe: the handle is open, the out buffer is ours and its size is passed.
        let ok = unsafe {
            let ok = GetFileInformationByHandleEx(
                h,
                FILE_ATTRIBUTE_TAG_INFO,
                (&mut info as *mut AttributeTagInfo).cast(),
                std::mem::size_of::<AttributeTagInfo>() as u32,
            );
            CloseHandle(h);
            ok
        };
        ok != 0 && info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && info.tag == IO_REPARSE_TAG_MOUNT_POINT
    }

    /// (`\??\C:\x`, `C:\x`): the substitute name a mount point takes, and the name it prints.
    fn names(target: &Path) -> (String, String) {
        let t = target.to_string_lossy().replace('/', "\\");
        let plain = if let Some(unc) = t.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else if let Some(rest) = t.strip_prefix(r"\\?\").or_else(|| t.strip_prefix(r"\??\")) {
            rest.to_string()
        } else {
            t
        };
        let nt = match plain.strip_prefix(r"\\") {
            Some(unc) => format!(r"\??\UNC\{unc}"),
            None => format!(r"\??\{plain}"),
        };
        (nt, plain)
    }

    /// A new junction at `link` (which must not exist) to the folder `target` (absolute).
    pub fn create(target: &Path, link: &Path) -> io::Result<()> {
        let (nt, print) = names(&crate::vault::normalize(target));
        let nt: Vec<u16> = nt.encode_utf16().collect();
        let print: Vec<u16> = print.encode_utf16().collect();
        let (nt_bytes, print_bytes) = (nt.len() * 2, print.len() * 2);
        // The header's four offsets and lengths, then the substitute name, NUL, the print
        // name, NUL.
        let data_len = 8 + nt_bytes + 2 + print_bytes + 2;
        if data_len > 16 * 1024 - 8 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "junction target too long"));
        }
        let mut buf: Vec<u8> = Vec::with_capacity(8 + data_len);
        buf.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        buf.extend_from_slice(&(data_len as u16).to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&(nt_bytes as u16).to_le_bytes());
        buf.extend_from_slice(&((nt_bytes + 2) as u16).to_le_bytes());
        buf.extend_from_slice(&(print_bytes as u16).to_le_bytes());
        for u in nt.iter().chain(&[0]).chain(&print).chain(&[0]) {
            buf.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::create_dir(link)?;
        let made = open(link, GENERIC_WRITE).and_then(|h| {
            let mut ret = 0u32;
            // Safe: the handle is open, the input buffer is ours and its length is passed.
            unsafe {
                let ok = DeviceIoControl(
                    h,
                    FSCTL_SET_REPARSE_POINT,
                    buf.as_ptr().cast(),
                    buf.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut ret,
                    std::ptr::null_mut(),
                );
                let e = io::Error::last_os_error();
                CloseHandle(h);
                if ok == 0 {
                    Err(e)
                } else {
                    Ok(())
                }
            }
        });
        if made.is_err() {
            let _ = std::fs::remove_dir(link);
        }
        made
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_names_of_a_target() {
            assert_eq!(names(Path::new(r"D:\os\app")), (r"\??\D:\os\app".into(), r"D:\os\app".into()));
            assert_eq!(names(Path::new(r"\\?\D:\os")), (r"\??\D:\os".into(), r"D:\os".into()));
            assert_eq!(names(Path::new(r"\\?\UNC\srv\share\x")), (r"\??\UNC\srv\share\x".into(), r"\\srv\share\x".into()));
        }

        /// A junction made here is one the system reads back: a folder link to its target.
        #[test]
        fn a_junction_is_made_without_privilege() {
            let base = std::env::temp_dir().join(format!("ose-junction-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(base.join("target")).unwrap();
            std::fs::write(base.join("target/a.md"), "a").unwrap();
            create(&base.join("target"), &base.join("link")).unwrap();
            assert!(is_junction(&base.join("link")));
            assert!(!is_junction(&base.join("target")));
            assert_eq!(std::fs::read_to_string(base.join("link/a.md")).unwrap(), "a");
            assert!(create(&base.join("target"), &base.join("link")).is_err(), "never over something");
            std::fs::remove_dir(base.join("link")).unwrap();
            assert!(base.join("target/a.md").exists(), "removing the junction leaves the target");
            let _ = std::fs::remove_dir_all(&base);
        }
    }
}

// ---- search ----------------------------------------------------------------

/// Every extension the search reads. Markdown is the vault; the rest are the text files a
/// person keeps beside it and expects to find (N39). Anything else is a name match only.
const SEARCH_EXTS: &[&str] = &[
    "md", "txt", "csv", "jsonl", "py", "log", "tex", "json", "yaml", "toml",
];

/// At most this many lines are reported per file: the cap counts files, and a file that says
/// the word two hundred times must not push every other file out of the answer (N34).
const LINES_PER_FILE: usize = 20;

/// The typed query, taken apart (N32, N38): the words that must all appear somewhere in a
/// file, and the two filters that narrow which files are looked at at all.
#[derive(Default, Debug, PartialEq)]
pub struct Query {
    /// Lowercased. A `"quoted phrase"` is one term, spaces and all.
    pub terms: Vec<String>,
    /// `path:<prefix>` — the vault-relative path must start with one of these (lowercased).
    pub paths: Vec<String>,
    /// `file:<substring>` — the file's own name must contain one of these (lowercased).
    pub files: Vec<String>,
}

impl Query {
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.paths.is_empty() && self.files.is_empty()
    }
}

/// Split on whitespace, except inside double quotes; `path:` and `file:` prefixes (which may
/// themselves be quoted: `path:"My Folder"`) become filters rather than terms.
pub fn parse_query(q: &str) -> Query {
    let mut out = Query::default();
    let chars: Vec<char> = q.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        // The prefix is read before the quotes, so `path:"a b"` filters on `a b`.
        let mut kind = 0u8; // 0 term, 1 path, 2 file
        for (word, k) in [("path:", 1u8), ("file:", 2u8)] {
            let n = word.chars().count();
            if i + n <= chars.len()
                && chars[i..i + n]
                    .iter()
                    .collect::<String>()
                    .eq_ignore_ascii_case(word)
            {
                kind = k;
                i += n;
                break;
            }
        }
        let mut word = String::new();
        if i < chars.len() && chars[i] == '"' {
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                word.push(chars[i]);
                i += 1;
            }
            i += 1; // the closing quote, or the end of the string
        } else {
            while i < chars.len() && !chars[i].is_whitespace() {
                word.push(chars[i]);
                i += 1;
            }
        }
        let word = word.trim().to_lowercase();
        if word.is_empty() {
            continue;
        }
        match kind {
            1 => out.paths.push(word.replace('\\', "/")),
            2 => out.files.push(word),
            _ => out.terms.push(word),
        }
    }
    out
}

/// One file that matched, before the cap and the ordering are applied.
struct FileHit {
    path: String,
    kind: &'static str,
    name_hit: bool,
    total: usize,
    lines: Vec<Value>,
}

/// Generation counters, one per caller channel, so a newer query cancels the older one (S33)
/// without a search from somewhere else cancelling it by accident. The search overlay passes
/// `chan: "overlay"` and every keystroke abandons the walk the previous one started; the link
/// rewriter passes no channel and is never cancelled, because it must see the whole vault.
static SEARCH_GEN: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
    std::sync::OnceLock::new();

fn next_gen(chan: &str) -> u64 {
    let map = SEARCH_GEN.get_or_init(Default::default);
    let mut map = map.lock().unwrap_or_else(|p| p.into_inner());
    let n = map.entry(chan.to_string()).or_insert(0);
    *n += 1;
    *n
}

fn gen_is_current(chan: &str, gen: u64) -> bool {
    let map = SEARCH_GEN.get_or_init(Default::default);
    let map = map.lock().unwrap_or_else(|p| p.into_inner());
    map.get(chan).copied().unwrap_or(0) == gen
}

/// The vault search (N32 to N39). Every term must appear in the file (or in its path); the
/// lines reported are the ones holding any term. `limit` counts **files**; 0 means no cap,
/// which is what the rename pass asks for. `hidden` searches hidden items too; excluded ones
/// never. The walk is hide.rs's `walker`: never into a link, and a link's content is never
/// read (it may point out of the vault), only its name matched. The answer is
/// `{hits, files, total, capped, stale}` — `hits` flat and ordered, file by file.
pub fn search(root: &Path, query: &str, limit: usize, chan: Option<&str>, hidden: bool) -> Value {
    let q = parse_query(query);
    if q.is_empty() {
        return json!({ "hits": [], "files": 0, "total": 0, "capped": false, "stale": false });
    }
    let gen = chan.map(|c| (c.to_string(), next_gen(c)));
    let mut found: Vec<FileHit> = Vec::new();
    let stale = !search_walk(root, &q, gen.as_ref(), &mut found, hidden);

    // A name match first, then the file with the most hits, then the path so two equal files
    // never swap places between two identical searches.
    found.sort_by(|a, b| {
        b.name_hit
            .cmp(&a.name_hit)
            .then(b.total.cmp(&a.total))
            .then(natural_compare(&a.path, &b.path))
    });
    let total = found.len();
    let cap = if limit == 0 { usize::MAX } else { limit };
    let capped = total > cap;
    found.truncate(cap);

    let mut hits = Vec::new();
    for f in &found {
        if f.name_hit {
            hits.push(json!({ "path": f.path, "line": 0, "col": 0, "text": f.path, "kind": f.kind }));
        }
        hits.extend(f.lines.iter().cloned());
    }
    json!({
        "hits": hits,
        "files": found.len(),
        "total": total,
        "capped": capped,
        "stale": stale,
    })
}

/// False when a newer search on the same channel has started and this one gave up.
fn search_walk(root: &Path, q: &Query, gen: Option<&(String, u64)>, found: &mut Vec<FileHit>, hidden: bool) -> bool {
    for (seen, item) in crate::hide::walker(root, root, hidden, MAX_DEPTH + 1).enumerate() {
        if seen % 64 == 0 {
            if let Some((chan, n)) = gen {
                if !gen_is_current(chan, *n) {
                    return false;
                }
            }
        }
        let Ok(entry) = item else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let path = entry.path();
        let rel = relative(root, path);
        // The vault bin is never searched, hidden items or not (hide.rs `in_bin`): a trashed
        // page is neither a result, a backlink nor a link to rewrite on a rename.
        if crate::hide::in_bin(&rel) {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let name_hit = !q.terms.is_empty() && q.terms.iter().all(|t| name.contains(t));
        let kind = entry.file_type();
        if kind.is_some_and(|k| k.is_dir()) {
            // A folder is a name and nothing else: it matches when every term is in its name
            // and the filters allow it (N35).
            if name_hit && allowed(q, &rel, &name) {
                found.push(FileHit { path: rel, kind: "dir", name_hit: true, total: 0, lines: Vec::new() });
            }
            continue;
        }
        if !allowed(q, &rel, &name) {
            continue;
        }
        let searchable = !kind.is_some_and(|k| k.is_symlink())
            && path
                .extension()
                .map(|e| {
                    let e = e.to_string_lossy().to_lowercase();
                    SEARCH_EXTS.iter().any(|x| *x == e)
                })
                .unwrap_or(false);
        if !searchable {
            if name_hit {
                found.push(FileHit { path: rel, kind: "file", name_hit: true, total: 0, lines: Vec::new() });
            }
            continue;
        }
        let Ok(bytes) = fs::read(path) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let lower = text.to_lowercase();
        let path_lower = rel.to_lowercase();
        // AND across the file: a term found in the path counts, so `philosophy kant` finds a
        // page about Kant inside a philosophy folder.
        if !q.terms.iter().all(|t| lower.contains(t) || path_lower.contains(t)) {
            if name_hit {
                found.push(FileHit { path: rel, kind: "file", name_hit: true, total: 0, lines: Vec::new() });
            }
            continue;
        }
        let mut lines = Vec::new();
        let mut total = 0usize;
        for (i, line) in text.lines().enumerate() {
            let low = line.to_lowercase();
            let Some(at) = q.terms.iter().filter_map(|t| low.find(t.as_str())).min() else { continue };
            total += 1;
            if lines.len() >= LINES_PER_FILE {
                continue;
            }
            // `col` is 1-based, counted in characters of the trimmed line, which is the text
            // the row shows and the column the editor lands the caret on (N36). `at` comes
            // from `find`, so it is always a character boundary.
            let before = &low[..at];
            let lead = before.chars().take_while(|c| c.is_whitespace()).count();
            let col = before.chars().count().saturating_sub(lead) + 1;
            let snippet: String = line.trim().chars().take(SNIPPET).collect();
            lines.push(json!({ "path": rel, "line": i + 1, "col": col, "text": snippet, "kind": "file" }));
        }
        if !lines.is_empty() || name_hit {
            found.push(FileHit { path: rel, kind: "file", name_hit, total, lines });
        }
    }
    true
}

/// The `path:` and `file:` filters (N38). No filter of a kind means every file passes it.
fn allowed(q: &Query, rel: &str, name: &str) -> bool {
    let rel = rel.to_lowercase();
    (q.paths.is_empty() || q.paths.iter().any(|p| rel.starts_with(p.trim_end_matches('/'))))
        && (q.files.is_empty() || q.files.iter().any(|f| name.contains(f)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_stays_inside() {
        let root = Path::new("/vault");
        assert_eq!(resolve(root, "").unwrap(), root);
        assert_eq!(resolve(root, "/a/b").unwrap(), root.join("a").join("b"));
        assert_eq!(resolve(root, "a/./b").unwrap(), root.join("a").join("b"));
        assert_eq!(resolve(root, "a//b").unwrap(), root.join("a").join("b"));
        assert!(resolve(root, "../etc").is_err());
        assert!(resolve(root, "a/../../etc").is_err());
        if cfg!(windows) {
            assert_eq!(resolve(root, "a\\b").unwrap(), root.join("a").join("b"));
            assert!(resolve(root, "C:/Windows").is_err());
        }
    }

    /// M49: a path is taken as written. Nothing is trimmed, a `..` is refused rather than folded
    /// into another file, and on Windows a name the system would read as another one is refused.
    #[test]
    fn resolve_never_trims_or_redirects() {
        let root = Path::new("/vault");
        assert_eq!(resolve(root, " notes.md").unwrap(), root.join(" notes.md"));
        let e = resolve(root, "a/x/../b").unwrap_err();
        assert!(e.starts_with("[escapes_vault]"), "{e}");
        if cfg!(windows) {
            for bad in ["notes.md ", "notes.", "CON", "nul.md", "com1.txt", "Lpt9", "a/aux/b.md"] {
                let e = resolve(root, bad).unwrap_err();
                assert!(e.starts_with("[bad_name]"), "{bad}: {e}");
            }
            for fine in ["console.md", "com10.md", "nullable.md", ".env", "a.b.c"] {
                assert!(resolve(root, fine).is_ok(), "{fine}");
            }
        } else {
            // A backslash is an ordinary character of a name off Windows.
            assert_eq!(resolve(root, "a\\b").unwrap(), root.join("a\\b"));
        }
    }

    /// H16: nothing is hidden by name. `app` and `node_modules` are listed, `.git` and `.ose`
    /// never are, a dotfile only when hidden items are asked for, and the listing says which
    /// entries are hidden.
    #[test]
    fn a_listing_follows_the_one_rule() {
        let t = Tmp::new("rule");
        let root = &t.0;
        for d in ["app", "node_modules", "_Archive", ".git", ".ose", ".obsidian"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(root.join("page.md"), "# p\n").unwrap();
        fs::write(root.join(".env"), "A=1\n").unwrap();
        fs::write(root.join(".page.md.99.3.tmp"), "half").unwrap();
        fs::write(root.join("ose.exe"), "").unwrap();
        fs::create_dir_all(root.join("tools")).unwrap();
        fs::write(root.join("tools/ose.exe"), "").unwrap();

        let names = |hidden: bool| -> Vec<String> { list(root, "", hidden).unwrap().into_iter().map(|n| n.name).collect() };
        assert_eq!(names(false), ["_Archive", "app", "node_modules", "tools", "page.md"]);
        assert_eq!(names(true), [".obsidian", "_Archive", "app", "node_modules", "tools", ".env", "page.md"]);
        let all = list(root, "", true).unwrap();
        assert!(all.iter().find(|n| n.name == ".env").unwrap().hidden);
        assert!(!all.iter().find(|n| n.name == "app").unwrap().hidden);
        // The exe is excluded at the root only.
        assert_eq!(list(root, "tools", false).unwrap()[0].name, "ose.exe");
        // An excluded folder is not there as far as listing goes.
        assert!(list(root, ".ose", true).unwrap_err().starts_with("[not_found]"));
        assert!(list(root, "missing", false).unwrap_err().starts_with("[not_found]"));

        // The tree and the search apply the same rule.
        let tree = tree(root, false).unwrap();
        let top: Vec<String> = tree.children.unwrap().into_iter().map(|n| n.name).collect();
        assert_eq!(top, ["_Archive", "app", "node_modules", "tools", "page.md"]);
        let with_hidden = super::tree(root, true).unwrap();
        assert!(with_hidden.children.unwrap().iter().any(|n| n.name == ".env"));
        let r = search(root, "ose", 100, None, true);
        let paths: Vec<&str> = r["hits"].as_array().unwrap().iter().map(|h| h["path"].as_str().unwrap()).collect();
        assert_eq!(paths, ["tools/ose.exe"], "the root exe is never found, the copy in tools is");
    }

    /// `stat` says hidden, and with `sniff` whether the file reads as text (H17).
    #[test]
    fn stat_sniffs_text_by_content() {
        let t = Tmp::new("sniff");
        let root = &t.0;
        fs::write(root.join("notes"), "no extension, plain text\n").unwrap();
        fs::write(root.join("bom.txt"), "\u{feff}with a mark\n").unwrap();
        fs::write(root.join("blob.bin"), [0x89u8, b'P', b'N', b'G', 0, 0, 1]).unwrap();
        fs::write(root.join("latin1.txt"), [b'c', b'a', b'f', 0xe9]).unwrap();
        fs::write(root.join(".hidden.md"), "x").unwrap();
        // A multi-byte character cut by the 8 KB edge is still text.
        let mut long = "a".repeat(SNIFF_BYTES - 1).into_bytes();
        long.extend("é and more".as_bytes());
        fs::write(root.join("long.md"), &long).unwrap();

        let text = |p: &str| stat(root, p, true).unwrap()["text"].clone();
        assert_eq!(text("notes"), true);
        assert_eq!(text("bom.txt"), true);
        assert_eq!(text("blob.bin"), false);
        // Not UTF-8, but windows-1252 that decodes and encodes back to the same bytes (M52).
        assert_eq!(text("latin1.txt"), true);
        assert_eq!(stat(root, "latin1.txt", true).unwrap()["encoding"], "windows-1252");
        assert_eq!(stat(root, "notes", true).unwrap()["encoding"], "UTF-8");
        assert_eq!(text("long.md"), true);
        assert!(stat(root, "notes", false).unwrap().get("text").is_none(), "only with sniff");
        assert_eq!(stat(root, ".hidden.md", false).unwrap()["hidden"], true);
        assert_eq!(stat(root, "gone.md", true).unwrap()["exists"], false);
    }

    /// A folder link, a junction on Windows when symlinks need a privilege this process lacks.
    fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(target, link).is_ok() {
                return true;
            }
            match junction::create(target, link) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("junction {}: {e}", link.display());
                    false
                }
            }
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    /// A folder link to its own parent is a loop: listed with its badge, never walked, and the
    /// tree still finishes. A link out of the vault says so, and cannot be listed.
    #[test]
    fn a_symlink_loop_is_listed_and_never_walked() {
        let t = Tmp::new("loop");
        let outside = Tmp::new("outside");
        let root = &t.0;
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/page.md"), "x").unwrap();
        fs::write(outside.0.join("secret.md"), "no").unwrap();
        if !link_dir(&root.join("a"), &root.join("a").join("loop")) || !link_dir(&outside.0, &root.join("out")) {
            eprintln!("no folder links on this machine; skipped");
            return;
        }
        let a = list(root, "a", false).unwrap();
        let lp = a.iter().find(|n| n.name == "loop").unwrap();
        assert_eq!(lp.link, Some("loop"));
        assert_eq!(lp.kind, "dir");
        let top = list(root, "", false).unwrap();
        assert_eq!(top.iter().find(|n| n.name == "out").unwrap().link, Some("outside"));
        assert!(list(root, "out", false).unwrap_err().starts_with("[escapes_vault]"));

        let tree = tree(root, false).unwrap();
        let a = tree.children.as_ref().unwrap().iter().find(|n| n.name == "a").unwrap();
        let lp = a.children.as_ref().unwrap().iter().find(|n| n.name == "loop").unwrap();
        assert!(lp.children.is_none(), "a link is never walked");
        let r = search(root, "no", 100, None, false);
        assert!(r["hits"].as_array().unwrap().iter().all(|h| h["path"] != "out/secret.md"));
    }

    /// `copyPath`: a whole folder, byte for byte, and never over anything.
    #[test]
    fn copy_path_copies_a_folder_and_never_overwrites() {
        let t = Tmp::new("copy");
        let root = &t.0;
        fs::create_dir_all(root.join("proj/src/deep")).unwrap();
        fs::write(root.join("proj/readme.md"), "# r\r\n").unwrap();
        fs::write(root.join("proj/src/deep/a.bin"), [0u8, 1, 2, 255]).unwrap();
        fs::create_dir_all(root.join("proj/empty")).unwrap();

        let r = copy_path(root, "proj", "backup/proj 2").unwrap();
        assert_eq!(r["path"], "backup/proj 2");
        assert_eq!(r["files"], 2);
        assert_eq!(fs::read(root.join("backup/proj 2/readme.md")).unwrap(), b"# r\r\n");
        assert_eq!(fs::read(root.join("backup/proj 2/src/deep/a.bin")).unwrap(), [0u8, 1, 2, 255]);
        assert!(root.join("backup/proj 2/empty").is_dir());

        // Create-only: a folder or a file already there is refused, and left as it was.
        let e = copy_path(root, "proj", "backup/proj 2").unwrap_err();
        assert!(e.starts_with("[exists]"), "{e}");
        let e = copy_path(root, "proj/readme.md", "backup/proj 2/readme.md").unwrap_err();
        assert!(e.starts_with("[exists]"), "{e}");
        // One file, and nothing to copy.
        assert_eq!(copy_path(root, "proj/readme.md", "readme copy.md").unwrap()["files"], 1);
        assert!(copy_path(root, "nope", "x").unwrap_err().starts_with("[not_found]"));
        // Never into itself, whatever the letter case says on a volume that folds it.
        assert!(copy_path(root, "proj", "proj/inside").unwrap_err().starts_with("[bad_arg]"));
        if cfg!(any(windows, target_os = "macos")) {
            assert!(copy_path(root, "Proj", "proj/Proj copy").unwrap_err().starts_with("[bad_arg]"));
            assert!(!root.join("proj/Proj copy").exists());
        }
        // A file may be copied beside itself under a longer name.
        assert_eq!(copy_path(root, "readme copy.md", "readme copy.md 2").unwrap()["files"], 1);
        assert!(copy_path(root, "proj", "proj2").unwrap().get("leftOut").is_none());
    }

    /// A folder link inside a copied folder comes back as a link to the same folder: a junction
    /// as a junction, and on Windows without the symlink right a folder symlink as a junction.
    /// Nothing is left out, and a link copied on its own works too.
    #[test]
    fn copy_path_keeps_folder_links() {
        let t = Tmp::new("copylinks");
        let root = &t.0;
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(root.join("app/index.md"), "# app\n").unwrap();
        fs::create_dir_all(root.join("proj")).unwrap();
        if !link_dir(&root.join("app"), &root.join("proj/link-to-app")) {
            eprintln!("no folder links on this machine; skipped");
            return;
        }
        let r = copy_path(root, "proj", "proj 2").unwrap();
        assert_eq!(r["files"], 1, "{r}");
        assert!(r.get("leftOut").is_none(), "{r}");
        let copied = root.join("proj 2/link-to-app");
        assert!(fs::symlink_metadata(&copied).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(copied.join("index.md")).unwrap(), "# app\n");
        #[cfg(windows)]
        assert_eq!(junction::is_junction(&copied), junction::is_junction(&root.join("proj/link-to-app")));

        let r = copy_path(root, "proj/link-to-app", "link 2").unwrap();
        assert_eq!(r["files"], 1);
        assert!(fs::symlink_metadata(root.join("link 2")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(root.join("link 2/index.md")).unwrap(), "# app\n");
        // Copying the target into the link to it is copying a folder into itself.
        assert!(copy_path(root, "app", "proj/link-to-app/app 2").unwrap_err().starts_with("[bad_arg]"));
    }

    /// M50: a rename never replaces what is at the target, even when the look said it was free.
    #[test]
    fn a_rename_never_replaces() {
        let t = Tmp::new("noreplace");
        let root = &t.0;
        fs::write(root.join("a.md"), "a").unwrap();
        fs::write(root.join("b.md"), "b").unwrap();
        let e = rename_noreplace(&root.join("a.md"), &root.join("b.md")).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "b");
        rename(root, "a.md", "sub/c.md").unwrap();
        assert_eq!(fs::read_to_string(root.join("sub/c.md")).unwrap(), "a");
        assert!(rename(root, "sub/c.md", "b.md").unwrap_err().starts_with("[exists]"));
    }

    /// A fresh folder under the system temp dir, removed when dropped.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("ose-test-{tag}-{stamp}-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_vault_is_marked_by_ose_or_claude_md_but_never_the_repo() {
        let t = Tmp::new("marker");
        let d = &t.0;
        assert!(!looks_like_vault(d), "a plain folder is not adopted by the walk");
        fs::create_dir_all(d.join(".ose")).unwrap();
        assert!(looks_like_vault(d), ".ose/ marks a vault");
        fs::remove_dir_all(d.join(".ose")).unwrap();
        fs::write(d.join("CLAUDE.md"), "# vault\n").unwrap();
        assert!(looks_like_vault(d), "CLAUDE.md still marks a vault");
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        assert!(!looks_like_vault(d), "the source repo is not a vault");
    }

    #[test]
    fn the_walk_climbs_out_of_a_bundle_to_the_nearest_marker() {
        let t = Tmp::new("walk");
        let vault = &t.0;
        fs::create_dir_all(vault.join(".ose")).unwrap();
        let exe = vault.join("Ose.app").join("Contents").join("MacOS").join("ose");
        assert_eq!(root_above(&exe), Some(normalize(vault)));
    }

    #[test]
    fn the_suggested_folder_leaves_a_mac_bundle() {
        let exe = Path::new("/Applications/Ose.app/Contents/MacOS/ose");
        assert_eq!(suggested_dir(exe).unwrap(), normalize(Path::new("/Applications")));
        let exe = Path::new(if cfg!(windows) { r"D:\os\ose.exe" } else { "/home/h/os/ose" });
        assert_eq!(suggested_dir(exe).unwrap(), normalize(exe.parent().unwrap()));
    }

    #[test]
    fn the_remembered_file_is_one_line() {
        assert!(parse_remembered("").is_none());
        assert!(parse_remembered("  \n").is_none());
        let p = if cfg!(windows) { r"D:\os" } else { "/home/h/os" };
        assert_eq!(parse_remembered(&format!("{p}\n")).unwrap(), normalize(Path::new(p)));
        assert_eq!(
            parse_remembered(&format!("\u{feff}{p}\r\nsecond line")).unwrap(),
            normalize(Path::new(p))
        );
    }

    #[test]
    fn a_query_splits_on_spaces_and_quotes_and_prefixes() {
        let q = parse_query("kant  ethics");
        assert_eq!(q.terms, vec!["kant", "ethics"]);
        let q = parse_query("\"critique of reason\" kant");
        assert_eq!(q.terms, vec!["critique of reason", "kant"]);
        let q = parse_query("path:2-learning/ file:index kant");
        assert_eq!(q.terms, vec!["kant"]);
        assert_eq!(q.paths, vec!["2-learning/"]);
        assert_eq!(q.files, vec!["index"]);
        let q = parse_query("PATH:\"My Folder\" Word");
        assert_eq!(q.paths, vec!["my folder"]);
        assert_eq!(q.terms, vec!["word"]);
        assert!(parse_query("   ").is_empty());
        // An unterminated quote takes the rest of the line rather than losing it.
        assert_eq!(parse_query("\"two words").terms, vec!["two words"]);
    }

    /// The whole of the batch-12 search contract on one small vault.
    #[test]
    fn search_ands_terms_matches_names_and_counts_files() {
        let t = Tmp::new("search");
        let root = &t.0;
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/alpha.md"), "# Alpha\nkant and ethics here\nkant again\n").unwrap();
        fs::write(root.join("notes/beta.md"), "kant only\n").unwrap();
        fs::write(root.join("notes/gamma.txt"), "ethics and kant in a text file\n").unwrap();
        fs::write(root.join("kant.md"), "nothing relevant\n").unwrap();

        let r = search(root, "kant ethics", 100, None, false);
        let hits = r["hits"].as_array().unwrap();
        let paths: Vec<&str> = hits.iter().map(|h| h["path"].as_str().unwrap()).collect();
        // beta.md has no `ethics` anywhere: the terms are ANDed within a file (N33).
        assert!(!paths.contains(&"notes/beta.md"));
        // .txt is searched (N39).
        assert!(paths.contains(&"notes/gamma.txt"));
        // kant.md matches on its name alone, with line 0 (N35).
        let name_hit = hits.iter().find(|h| h["path"] == "kant.md");
        assert!(name_hit.is_none(), "kant.md does not hold `ethics`, so it is not a hit");

        // A one-term search does match the name, and the name hit comes first (N34 ordering).
        let r = search(root, "kant", 100, None, false);
        let hits = r["hits"].as_array().unwrap();
        assert_eq!(hits[0]["path"], "kant.md");
        assert_eq!(hits[0]["line"], 0);
        assert_eq!(r["total"], 4);
        assert_eq!(r["capped"], false);

        // The cap counts files, and the answer says how many there were (N34).
        let r = search(root, "kant", 2, None, false);
        assert_eq!(r["files"], 2);
        assert_eq!(r["total"], 4);
        assert_eq!(r["capped"], true);

        // limit 0 is no cap at all: what the rename pass asks for (N20).
        let r = search(root, "kant", 0, None, false);
        assert_eq!(r["files"], 4);
        assert_eq!(r["capped"], false);

        // `col` is 1-based in the trimmed line (N36).
        let r = search(root, "again", 100, None, false);
        let h = &r["hits"].as_array().unwrap()[0];
        assert_eq!(h["line"], 3);
        assert_eq!(h["col"], 6);
        assert_eq!(h["text"], "kant again");
    }

    #[test]
    fn search_filters_by_path_and_file() {
        let t = Tmp::new("filters");
        let root = &t.0;
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/one.md"), "word\n").unwrap();
        fs::write(root.join("b/two.md"), "word\n").unwrap();

        let r = search(root, "path:a word", 100, None, false);
        let hits = r["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["path"], "a/one.md");

        let r = search(root, "file:two word", 100, None, false);
        let hits = r["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["path"], "b/two.md");

        // A folder whose name matches is a hit of its own, with line 0 (N35).
        let r = search(root, "a", 100, None, false);
        let hits = r["hits"].as_array().unwrap();
        assert!(hits.iter().any(|h| h["path"] == "a" && h["kind"] == "dir"));
    }

    #[test]
    fn a_write_never_leaves_the_target_half_written() {
        let t = Tmp::new("atomic");
        let root = &t.0;
        write_text(root, "notes/page.md", "# one\n").unwrap();
        assert_eq!(read_text(root, "notes/page.md").unwrap(), "# one\n");
        write_text(root, "notes/page.md", "# two\n").unwrap();
        assert_eq!(read_text(root, "notes/page.md").unwrap(), "# two\n");
        // No scratch file is left behind, under any name.
        let leftovers: Vec<String> = fs::read_dir(root.join("notes"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "page.md")
            .collect();
        assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
        write_binary(root, "notes/x.bin", "aGVsbG8=").unwrap();
        assert_eq!(fs::read(root.join("notes/x.bin")).unwrap(), b"hello");
    }

    /// C3: a scanner or a sync client holding the fresh temp file open (share-read only, the
    /// way they do) makes the rename fail. The old file must survive untouched, and the new
    /// bytes must be somewhere the failure names — never deleted.
    #[cfg(windows)]
    #[test]
    fn a_held_temp_file_loses_nothing() {
        use std::os::windows::fs::OpenOptionsExt;
        use std::sync::Mutex;
        const FILE_SHARE_READ: u32 = 1;
        let t = Tmp::new("held");
        let root = &t.0;
        let full = root.join("page.md");
        fs::write(&full, "old text\n").unwrap();

        let held: Mutex<Option<fs::File>> = Mutex::new(None);
        let r = write_atomic_with(&full, b"new text\n", 100, Aside::Visible, &|tmp| {
            let f = fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(tmp).unwrap();
            *held.lock().unwrap() = Some(f);
            Ok(())
        });
        let failure = r.expect_err("a rename over a held temp file cannot succeed");
        assert_eq!(fs::read_to_string(&full).unwrap(), "old text\n", "the old file survives");
        let kept = failure.kept.clone().expect("the new bytes are kept");
        let message = failure.message("page.md", Some(root));
        assert!(message.starts_with("[write_failed] page.md: "), "{message}");
        assert!(message.contains("your text is in "), "{message}");
        held.lock().unwrap().take();
        assert_eq!(fs::read_to_string(&kept).unwrap(), "new text\n", "the new bytes are recoverable");
    }

    /// The same scanner letting go within the retry budget: the save goes through.
    #[cfg(windows)]
    #[test]
    fn a_briefly_held_temp_file_is_waited_for() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = Tmp::new("brief");
        let full = t.0.join("page.md");
        fs::write(&full, "old\n").unwrap();
        write_atomic_with(&full, b"new\n", 2000, Aside::Visible, &|tmp| {
            let f = fs::OpenOptions::new().read(true).share_mode(1).open(tmp).unwrap();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                drop(f);
            });
            Ok(())
        })
        .unwrap();
        assert_eq!(fs::read_to_string(&full).unwrap(), "new\n");
        let names: Vec<String> = fs::read_dir(&t.0)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["page.md".to_string()], "no temp file left behind");
    }

    /// The target itself locked (an editor holding it open without share-delete): the new bytes
    /// land in a visible `<stem>.unsaved-<stamp>.<ext>` beside it, and the old file is intact.
    #[cfg(windows)]
    #[test]
    fn a_locked_target_sets_the_new_bytes_aside_where_they_can_be_seen() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = Tmp::new("locked");
        let root = &t.0;
        let full = root.join("page.md");
        fs::write(&full, "old\n").unwrap();
        let lock = fs::OpenOptions::new().read(true).share_mode(1).open(&full).unwrap();
        let failure = write_atomic_with(&full, b"new\n", 50, Aside::Visible, &|_| Ok(())).unwrap_err();
        drop(lock);
        assert_eq!(fs::read_to_string(&full).unwrap(), "old\n");
        let kept = failure.kept.clone().unwrap();
        let name = kept.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("page.unsaved-") && name.ends_with(".md"), "{name}");
        assert_eq!(fs::read_to_string(&kept).unwrap(), "new\n");
        let message = failure.message("page.md", Some(root));
        assert!(message.ends_with(&format!("your text is in {name}")), "{message}");

        // The same target failing again replaces this run's copy instead of adding one.
        let lock = fs::OpenOptions::new().read(true).share_mode(1).open(&full).unwrap();
        let again = write_atomic_with(&full, b"newer\n", 50, Aside::Visible, &|_| Ok(())).unwrap_err();
        drop(lock);
        assert_eq!(again.kept.as_deref(), Some(kept.as_path()), "one set-aside per target");
        assert_eq!(fs::read_to_string(&kept).unwrap(), "newer\n");
        let count = fs::read_dir(root).unwrap().flatten().count();
        assert_eq!(count, 2, "the page and one set-aside, nothing else");
    }

    /// A read-only target refuses every rename for good: the write fails at once, sets nothing
    /// aside and leaves no temp file.
    #[cfg(windows)]
    #[test]
    #[allow(clippy::permissions_set_readonly_false)]
    fn a_read_only_target_fails_at_once_and_sets_nothing_aside() {
        let t = Tmp::new("readonly");
        let full = t.0.join("page.md");
        fs::write(&full, "old\n").unwrap();
        let mut perms = fs::metadata(&full).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&full, perms.clone()).unwrap();
        let started = std::time::Instant::now();
        let failure = write_atomic(&full, b"new\n").unwrap_err();
        assert!(started.elapsed() < std::time::Duration::from_millis(1000), "no retry budget spent");
        assert!(failure.kept.is_none());
        assert_eq!(failure.message("page.md", Some(&t.0)), "[write_failed] page.md: the file is read-only");
        let count = fs::read_dir(&t.0).unwrap().flatten().count();
        assert_eq!(count, 1, "no set-aside and no temp file");
        perms.set_readonly(false);
        fs::set_permissions(&full, perms).unwrap();
        assert_eq!(fs::read_to_string(&full).unwrap(), "old\n");
    }

    /// The check before the rename can stop the write: the target is untouched, the temp file
    /// is gone, and an app-owned write that fails leaves nothing behind either.
    #[test]
    fn a_refusing_check_or_an_owned_failure_leaves_nothing_behind() {
        let t = Tmp::new("check");
        let full = t.0.join("page.md");
        fs::write(&full, "old\n").unwrap();
        let failure =
            write_atomic_with(&full, b"new\n", 50, Aside::Visible, &|_| Err(std::io::Error::other("changed"))).unwrap_err();
        assert!(failure.kept.is_none());
        assert_eq!(fs::read_to_string(&full).unwrap(), "old\n");
        assert_eq!(fs::read_dir(&t.0).unwrap().flatten().count(), 1);

        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let lock = fs::OpenOptions::new().read(true).share_mode(1).open(&full).unwrap();
            let failure = write_atomic_owned(&full, b"new\n", 50).unwrap_err();
            drop(lock);
            assert!(failure.kept.is_none(), "an app-owned file sets nothing aside");
            assert_eq!(fs::read_dir(&t.0).unwrap().flatten().count(), 1, "and leaves no temp file");
        }
    }

    /// H10: a rename through the app moves the file's history with it.
    #[test]
    fn a_rename_moves_the_history() {
        let t = Tmp::new("rename-history");
        let root = &t.0;
        write_text(root, "a.md", "# a\n").unwrap();
        crate::versions::keep(root, "a.md", b"# before\n", true, crate::versions::Reason::Save).unwrap();
        // What the `rename` command does: the file, then its history.
        rename(root, "a.md", "b.md").unwrap();
        crate::versions::move_history(root, "a.md", "b.md").unwrap();
        assert_eq!(crate::versions::list(root, "a.md").unwrap(), json!([]));
        assert_eq!(crate::versions::list(root, "b.md").unwrap().as_array().unwrap().len(), 1);
    }

    /// F14: the mark is a byte of the file. `read_text` hands it to the editor, `write_text`
    /// writes back what it is given, and neither invents one — so `doc.js` can strip it on
    /// open and restore it on save, and a file without one never grows one.
    #[test]
    fn a_byte_order_mark_survives_a_round_trip() {
        let t = Tmp::new("bom");
        let root = &t.0;
        fs::write(root.join("bom.md"), "\u{feff}# one\n".as_bytes()).unwrap();
        let text = read_text(root, "bom.md").unwrap();
        assert_eq!(text, "\u{feff}# one\n", "the mark reaches the editor");

        // What the editor sends back is what lands on disk, byte for byte.
        write_text(root, "bom.md", "\u{feff}# two\n").unwrap();
        assert_eq!(fs::read(root.join("bom.md")).unwrap(), b"\xEF\xBB\xBF# two\n");
        assert_eq!(read_text(root, "bom.md").unwrap(), "\u{feff}# two\n");

        // And a file that never had one is not given one.
        write_text(root, "plain.md", "# three\n").unwrap();
        assert_eq!(fs::read(root.join("plain.md")).unwrap(), b"# three\n");
        assert_eq!(read_text(root, "plain.md").unwrap(), "# three\n");
    }

    #[test]
    fn a_case_only_rename_goes_through(
    ) {
        let t = Tmp::new("case");
        let root = &t.0;
        write_text(root, "Notes.md", "# n\n").unwrap();
        rename(root, "Notes.md", "notes.md").unwrap();
        // The bytes survived and the name on disk is the new one, whatever the filesystem's
        // idea of case is.
        assert_eq!(read_text(root, "notes.md").unwrap(), "# n\n");
        let names: Vec<String> = fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["notes.md".to_string()]);
        // A real collision is still refused.
        write_text(root, "other.md", "x\n").unwrap();
        assert!(rename(root, "other.md", "notes.md").is_err());
    }

    #[test]
    fn natural_order() {
        assert_eq!(natural_compare("2. Foo", "10. Foo"), Ordering::Less);
        assert_eq!(natural_compare("0. Index", "1. Life"), Ordering::Less);
        assert_eq!(natural_compare("b", "A"), Ordering::Greater);
        assert_eq!(natural_compare("a", "a"), Ordering::Equal);
        assert_eq!(natural_compare("a", "ab"), Ordering::Less);
    }

    /// M49: the decomposed name a Finder rename writes becomes the composed one a keyboard types.
    #[test]
    fn nfd_becomes_nfc() {
        let nfd = "Cafe\u{301} de\u{301}ja\u{300}.md".to_string();
        let nfc = "Café déjà.md";
        assert_ne!(nfd, nfc);
        assert_eq!(to_nfc(nfd.clone()), nfc);
        assert_eq!(to_nfc(nfc.to_string()), nfc, "already composed: untouched");
        if cfg!(target_os = "macos") {
            assert_eq!(nfc_of(&nfd), nfc);
        } else {
            assert_eq!(nfc_of(&nfd), nfd, "only macOS normalises what it sends out");
        }
    }

    fn nfc_of(s: &str) -> String {
        nfc(s.to_string())
    }

    /// On macOS a listing sends NFC names and paths whatever the disk holds.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_listing_is_nfc_on_macos() {
        let t = Tmp::new("nfc");
        let root = &t.0;
        fs::write(root.join("Cafe\u{301}.md"), "x").unwrap();
        let names: Vec<String> = list(root, "", false).unwrap().into_iter().map(|n| n.path).collect();
        assert_eq!(names, vec!["Café.md".to_string()]);
        // A path coming in is used as given: APFS finds the file under either form.
        assert!(exists(root, "Café.md").unwrap() && exists(root, "Cafe\u{301}.md").unwrap());
    }
}
