//! The filesystem, confined to the vault root. A direct port of the .NET host's `Vault.cs`:
//! same hidden names, same natural sort, same node shape, same error strings.

use std::cmp::Ordering;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};

use tauri::Manager as _;

use crate::{arg_str, arg_str_or, opt_field_i64, Ctx, Source};

/// Never listed, never searched, never walked. Any name starting with a dot is hidden too,
/// which covers `.ose` (the state folder) and every dotfile.
const HIDDEN: &[&str] = &[
    ".git",
    ".obsidian",
    ".claude",
    ".vscode",
    ".trash",
    "node_modules",
    "App",
    ".tmp.driveupload",
    ".makemd",
    ".space",
    "os.exe",
    "os.pdb",
    ".ose",
    // what an update leaves beside the executable for a moment (update.rs), and the bundle
    // itself when os.app sits at the vault root on macOS
    "os.exe.new",
    "os.exe.old",
    "os.app",
    "os.app.old",
    "os-update.zip",
    "os-update-tmp",
];

const MAX_DEPTH: usize = 24;
/// Files, not lines (N34): the answer says "showing N of M files" when it cut the list.
const DEFAULT_SEARCH_LIMIT: usize = 100;
const SNIPPET: usize = 240;

pub fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || HIDDEN.iter().any(|h| h.eq_ignore_ascii_case(name))
}

// ---- root resolution -------------------------------------------------------

/// A folder the executable's walk may adopt on its own: one that already carries our state
/// folder `.ose/`, or a `CLAUDE.md` (the older marker, kept so every existing vault still
/// opens). The source repository has a `CLAUDE.md` too, so a folder that also holds
/// `src-tauri` is the app, not a vault (matters when running from `src-tauri/target/release`
/// during development). A chosen or remembered folder needs no marker at all.
pub fn looks_like_vault(dir: &Path) -> bool {
    (dir.join(".ose").is_dir() || dir.join("CLAUDE.md").is_file()) && !dir.join("src-tauri").is_dir()
}

/// Steps 1 to 3 of the resolution order (CONTRACT.md "Vault resolution"): `--root` when it is
/// a folder, else the nearest ancestor of the executable that `looks_like_vault` (on macOS the
/// walk climbs out of `os.app/Contents/MacOS`), else `OSE_ROOT`. Steps 4 and 5, the remembered
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

/// The nearest ancestor of `exe` that looks like a vault, the executable's own folder first.
fn root_above(exe: &Path) -> Option<PathBuf> {
    let mut dir = exe.parent().map(normalize);
    while let Some(d) = dir {
        if looks_like_vault(&d) {
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

fn is_remembered(app: &tauri::AppHandle) -> bool {
    remembered_file(app).map(|f| f.is_file()).unwrap_or(false)
}

// ---- choosing a vault ------------------------------------------------------

/// Makes `dir` the open vault: validated, remembered, set in the state, watched. Everything
/// after the picker itself, so the picker stays the only platform-specific line.
pub fn adopt(ctx: &Ctx, dir: &Path, source: Source) -> Result<Value, String> {
    let full = normalize(dir);
    if !full.is_dir() {
        return Err(format!("not a folder: {}", full.display()));
    }
    remember(ctx.app, &full)?;
    ctx.st.set_root(full.clone(), source);
    ctx.st.watch(ctx.app, full.clone());
    crate::log_line(
        ctx.st,
        &format!("vault root: {} (from {})", full.display(), source.as_str()),
    );
    Ok(root_info(&full))
}

/// `pickVault`: the native folder picker (supplied by the binary, see `crate::FolderPicker`),
/// opened in the executable's folder. `null` on cancel, `{root, name}` once the choice is
/// adopted. The picker calls back from a thread of its own; awaiting a channel keeps the async
/// runtime free and never blocks the main thread.
pub async fn pick_vault(ctx: &Ctx<'_>) -> Result<Value, String> {
    let picker = ctx
        .st
        .picker
        .ok_or_else(|| "this build has no folder picker".to_string())?;
    let start = exe_dir().filter(|d| d.is_dir());

    let (tx, mut rx) = tauri::async_runtime::channel::<Option<PathBuf>>(1);
    picker(
        ctx.app,
        start,
        Box::new(move |picked| {
            let _ = tx.try_send(picked);
        }),
    );

    match rx.recv().await.flatten() {
        None => Ok(Value::Null),
        Some(path) => adopt(ctx, &path, Source::Picked),
    }
}

/// `vaultInfo`: the open root, whether a remembered-root file exists on this machine, and the
/// source the root came from. Root, name and source are null while no vault is open.
pub fn vault_info(ctx: &Ctx) -> Value {
    match ctx.st.root_info() {
        Some(r) => json!({
            "root": r.path.to_string_lossy(),
            "name": root_name(&r.path),
            "remembered": is_remembered(ctx.app),
            "source": r.source.as_str(),
        }),
        None => json!({
            "root": null,
            "name": null,
            "remembered": is_remembered(ctx.app),
            "source": null,
        }),
    }
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

pub fn root_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string_lossy().to_string())
}

// ---- paths -----------------------------------------------------------------

/// Vault-relative, forward slashes, no leading slash, never escaping the root.
/// Built segment by segment from the root, so escaping is impossible rather than merely checked.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let cleaned = rel.replace('\\', "/");
    let cleaned = cleaned.trim().trim_start_matches('/');
    if cleaned.is_empty() {
        return Ok(root.to_path_buf());
    }

    let mut out = root.to_path_buf();
    let mut depth = 0usize;
    for seg in cleaned.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                if depth == 0 {
                    return Err(format!("path escapes the vault: {rel}"));
                }
                out.pop();
                depth -= 1;
            }
            s => {
                // A segment holding a drive letter or a NUL would rewrite the path instead of
                // extending it, so it is rejected outright.
                if s.contains(':') {
                    return Err(format!("path must be vault-relative: {rel}"));
                }
                if s.contains('\0') {
                    return Err(format!("path escapes the vault: {rel}"));
                }
                out.push(s);
                depth += 1;
            }
        }
    }
    Ok(out)
}

/// The inverse: an absolute path back to its vault-relative form.
pub fn relative(root: &Path, full: &Path) -> String {
    match full.strip_prefix(root) {
        Ok(rest) => rest.to_string_lossy().replace('\\', "/"),
        Err(_) => full.to_string_lossy().replace('\\', "/"),
    }
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

#[derive(Serialize)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub ext: String,
    pub mtime: i64,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Node>>,
}

fn node_of(root: &Path, full: &Path, meta: &fs::Metadata) -> Node {
    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let is_dir = meta.is_dir();
    Node {
        ext: if is_dir {
            String::new()
        } else {
            full.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        },
        path: relative(root, full),
        name,
        kind: if is_dir { "dir" } else { "file" },
        mtime: mtime_of(meta),
        size: if is_dir { 0 } else { meta.len() },
        children: None,
    }
}

/// Entries of one folder minus the hidden names and the symlinks. An unreadable folder is
/// empty, not an error: one locked subfolder must not break the whole tree.
fn visible(dir: &Path) -> Vec<(PathBuf, fs::Metadata)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden(&name) {
            continue;
        }
        match entry.file_type() {
            Ok(t) if t.is_symlink() => continue,
            Ok(_) => {}
            Err(_) => continue,
        }
        let Ok(meta) = entry.metadata() else { continue };
        out.push((entry.path(), meta));
    }
    out
}

fn sort(nodes: &mut [Node]) {
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

pub fn list(root: &Path, rel: &str) -> Result<Vec<Node>, String> {
    let dir = resolve(root, rel)?;
    if !dir.is_dir() {
        return Err(format!("not a folder: {rel}"));
    }
    let mut nodes: Vec<Node> = visible(&dir)
        .iter()
        .map(|(p, m)| node_of(root, p, m))
        .collect();
    sort(&mut nodes);
    Ok(nodes)
}

pub fn tree(root: &Path) -> Result<Node, String> {
    let meta = fs::metadata(root).map_err(|e| format!("cannot read the vault root: {e}"))?;
    Ok(Node {
        name: root_name(root),
        path: String::new(),
        kind: "dir",
        ext: String::new(),
        mtime: mtime_of(&meta),
        size: 0,
        children: Some(walk(root, root, 0)),
    })
}

fn walk(root: &Path, dir: &Path, depth: usize) -> Vec<Node> {
    let mut nodes = Vec::new();
    if depth > MAX_DEPTH {
        return nodes;
    }
    for (path, meta) in visible(dir) {
        let mut node = node_of(root, &path, &meta);
        if node.kind == "dir" {
            node.children = Some(walk(root, &path, depth + 1));
        }
        nodes.push(node);
    }
    sort(&mut nodes);
    nodes
}

pub fn stat(root: &Path, rel: &str) -> Result<Value, String> {
    let full = resolve(root, rel)?;
    match fs::metadata(&full) {
        Ok(m) if m.is_dir() => Ok(json!({
            "exists": true, "kind": "dir", "mtime": mtime_of(&m), "size": 0,
        })),
        Ok(m) => Ok(json!({
            "exists": true, "kind": "file", "mtime": mtime_of(&m), "size": m.len(),
        })),
        Err(_) => Ok(json!({ "exists": false, "kind": null, "mtime": 0, "size": 0 })),
    }
}

pub fn exists(root: &Path, rel: &str) -> Result<bool, String> {
    Ok(resolve(root, rel)?.exists())
}

/// UTF-8, byte-order mark stripped like .NET's `File.ReadAllText`, line endings untouched.
pub fn read_text(root: &Path, rel: &str) -> Result<String, String> {
    let full = resolve(root, rel)?;
    let bytes = fs::read(&full).map_err(|e| format!("{rel}: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("not valid UTF-8: {rel}"))?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

// ---- writes ----------------------------------------------------------------

fn ensure_parent(full: &Path) -> Result<(), String> {
    if full.file_name().is_none() {
        return Err("no file name to write".to_string());
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    Ok(())
}

/// Write `bytes` to `full` without ever leaving the target half-written (S25): a temp file
/// beside it, then a rename over it, the way `state.rs write_locked` does. A rename within one
/// folder is atomic on NTFS, APFS and ext4, so a crash mid-write loses the new text, never the
/// old file. The temp name carries the process id and a counter so two writes to one path (two
/// windows, a save racing a link rewrite) cannot use the same scratch file; a failed write
/// takes its temp file with it.
fn write_atomic(full: &Path, bytes: &[u8]) -> std::io::Result<()> {
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
    if let Err(e) = write {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    // Windows refuses a rename onto an existing file, so the target goes first. Losing the
    // race here means losing the old file, which is why the new bytes are already on disk.
    #[cfg(windows)]
    if full.exists() {
        let _ = fs::remove_file(full);
    }
    if let Err(e) = fs::rename(&tmp, full) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// UTF-8 without a byte-order mark, bytes exactly as given.
pub fn write_text(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    ensure_parent(&full)?;
    write_atomic(&full, text.as_bytes()).map_err(|e| format!("{rel}: {e}"))
}

pub fn append_text(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    ensure_parent(&full)?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&full)
        .map_err(|e| format!("{rel}: {e}"))?;
    f.write_all(text.as_bytes()).map_err(|e| format!("{rel}: {e}"))
}

pub fn write_binary(root: &Path, rel: &str, b64: &str) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("not base64: {e}"))?;
    let full = resolve(root, rel)?;
    ensure_parent(&full)?;
    write_atomic(&full, &bytes).map_err(|e| format!("{rel}: {e}"))
}

pub fn mkdir(root: &Path, rel: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    fs::create_dir_all(&full).map_err(|e| format!("{rel}: {e}"))
}

/// Never overwrites: the .NET host moved with `overwrite: false` and the UI relies on that
/// to keep a rename from swallowing an existing page.
///
/// `Notes.md` -> `notes.md` is a real rename, not a collision (N17). On a case-insensitive
/// filesystem `dst.exists()` is true because it is the same file, and `fs::rename` may or may
/// not change the name on disk, so a case-only change goes through a temporary name: two
/// renames, neither of which can be mistaken for an overwrite.
pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let src = resolve(root, from)?;
    let dst = resolve(root, to)?;
    if !src.exists() {
        return Err(format!("nothing to rename: {from}"));
    }
    if src == dst {
        return Ok(());
    }
    if case_only(&src, &dst) {
        ensure_parent(&dst)?;
        let name = dst
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "item".into());
        let via = src.with_file_name(format!(".{name}.{}.case", std::process::id()));
        let _ = fs::remove_file(&via);
        fs::rename(&src, &via).map_err(|e| format!("{from} -> {to}: {e}"))?;
        return match fs::rename(&via, &dst) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = fs::rename(&via, &src);
                Err(format!("{from} -> {to}: {e}"))
            }
        };
    }
    if dst.exists() {
        return Err(format!("target already exists: {to}"));
    }
    ensure_parent(&dst)?;
    fs::rename(&src, &dst).map_err(|e| format!("{from} -> {to}: {e}"))
}

/// Two vault paths that differ only in letter case — the same file on Windows and on a
/// default macOS volume, a different one on Linux (where the plain rename does the right
/// thing anyway, and the two-step is merely a longer way to the same result).
fn case_only(a: &Path, b: &Path) -> bool {
    let (a, b) = (a.to_string_lossy(), b.to_string_lossy());
    a != b && a.to_lowercase() == b.to_lowercase()
}

/// The recycle bin, never a permanent delete.
pub fn trash(root: &Path, rel: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    if full == root {
        return Err("refusing to trash the vault root".to_string());
    }
    if !full.exists() {
        return Err(format!("nothing to trash: {rel}"));
    }
    // The Recycle Bin call goes through COM and wants a thread of its own (an apartment already
    // initialised differently makes the shell abort the operation). If the shell still refuses,
    // fall back to a hidden `.trash` folder inside the vault: never a permanent delete.
    let target = full.clone();
    let shell = std::thread::spawn(move || trash::delete(&target).map_err(|e| e.to_string()))
        .join()
        .unwrap_or_else(|_| Err("trash thread panicked".to_string()));
    match shell {
        Ok(()) => Ok(()),
        Err(first) => into_vault_bin(root, rel, &full, &first),
    }
}

/// `.trash/<stamp>-<name>` inside the vault: the settings choice "deleted files go to the
/// vault" (S37), and the fallback when the platform's bin refuses. Still never a permanent
/// delete, and the folder is hidden from the tree, the search and the watcher.
pub fn trash_into_vault(root: &Path, rel: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    if full == root {
        return Err("refusing to trash the vault root".to_string());
    }
    if !full.exists() {
        return Err(format!("nothing to trash: {rel}"));
    }
    into_vault_bin(root, rel, &full, "")
}

fn into_vault_bin(root: &Path, rel: &str, full: &Path, first: &str) -> Result<(), String> {
    // `first` is the platform bin's complaint when this is a fallback, and empty when the vault
    // bin is what the user asked for; the error says which of the two failed either way.
    let why = |e: std::io::Error| {
        if first.is_empty() {
            format!("{rel}: .trash: {e}")
        } else {
            format!("{rel}: {first}; and .trash: {e}")
        }
    };
    let bin = root.join(".trash");
    std::fs::create_dir_all(&bin).map_err(why)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "item".into());
    std::fs::rename(full, bin.join(format!("{stamp}-{name}"))).map_err(why)
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
/// which is what the rename pass asks for. The answer is
/// `{hits, files, total, capped, stale}` — `hits` flat and ordered, file by file.
pub fn search(root: &Path, query: &str, limit: usize, chan: Option<&str>) -> Value {
    let q = parse_query(query);
    if q.is_empty() {
        return json!({ "hits": [], "files": 0, "total": 0, "capped": false, "stale": false });
    }
    let gen = chan.map(|c| (c.to_string(), next_gen(c)));
    let mut found: Vec<FileHit> = Vec::new();
    let stale = !search_dir(root, root, &q, gen.as_ref(), &mut found, 0);

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

/// False when a newer search has started and this one gave up.
fn search_dir(
    root: &Path,
    dir: &Path,
    q: &Query,
    gen: Option<&(String, u64)>,
    found: &mut Vec<FileHit>,
    depth: usize,
) -> bool {
    if depth > MAX_DEPTH {
        return true;
    }
    if let Some((chan, n)) = gen {
        if !gen_is_current(chan, *n) {
            return false;
        }
    }
    for (path, meta) in visible(dir) {
        let rel = relative(root, &path);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if meta.is_dir() {
            // A folder is a name and nothing else: it matches when every term is in its name
            // and the filters allow it (N35).
            if allowed(q, &rel, &name) && !q.terms.is_empty() && q.terms.iter().all(|t| name.contains(t)) {
                found.push(FileHit { path: rel.clone(), kind: "dir", name_hit: true, total: 0, lines: Vec::new() });
            }
            if !search_dir(root, &path, q, gen, found, depth + 1) {
                return false;
            }
            continue;
        }
        if !allowed(q, &rel, &name) {
            continue;
        }
        let name_hit = !q.terms.is_empty() && q.terms.iter().all(|t| name.contains(t));
        let searchable = path
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
        let Ok(bytes) = fs::read(&path) else { continue };
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

// ---- dispatch --------------------------------------------------------------

const COMMANDS: &[&str] = &[
    "rootInfo",
    "vaultInfo",
    "forgetVault",
    "tree",
    "list",
    "stat",
    "exists",
    "readText",
    "writeText",
    "appendText",
    "writeBinary",
    "mkdir",
    "rename",
    "trash",
    "search",
];

pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if !COMMANDS.contains(&cmd) {
        return None;
    }
    // The three that answer without a vault; everything else reads the root at call time.
    match cmd {
        "rootInfo" => {
            return Some(Ok(match ctx.st.root() {
                Some(root) => root_info(&root),
                None => json!({ "root": null, "name": null }),
            }))
        }
        "vaultInfo" => return Some(Ok(vault_info(ctx))),
        "forgetVault" => return Some(forget(ctx.app).map(|_| Value::Null)),
        _ => {}
    }
    let root = match ctx.st.require_root() {
        Ok(r) => r,
        Err(e) => return Some(Err(e)),
    };
    Some(dispatch(&root, cmd, args))
}

fn dispatch(root: &Path, cmd: &str, args: &[Value]) -> Result<Value, String> {
    let ok = Ok(Value::Null);
    match cmd {
        "tree" => to_value(tree(root)?),
        "list" => to_value(list(root, &arg_str_or(args, 0, ""))?),
        "stat" => stat(root, &arg_str(args, 0)?),
        "exists" => Ok(Value::Bool(exists(root, &arg_str(args, 0)?)?)),
        "readText" => Ok(Value::String(read_text(root, &arg_str(args, 0)?)?)),
        "writeText" => {
            write_text(root, &arg_str(args, 0)?, &arg_str_or(args, 1, ""))?;
            ok
        }
        "appendText" => {
            append_text(root, &arg_str(args, 0)?, &arg_str_or(args, 1, ""))?;
            ok
        }
        "writeBinary" => {
            write_binary(root, &arg_str(args, 0)?, &arg_str(args, 1)?)?;
            ok
        }
        "mkdir" => {
            mkdir(root, &arg_str(args, 0)?)?;
            ok
        }
        "rename" => {
            rename(root, &arg_str(args, 0)?, &arg_str(args, 1)?)?;
            ok
        }
        "trash" => {
            // {mode: "system"|"vault"} from settings (S37); anything else means the bin.
            if crate::opt_field_str(args, 1, "mode").as_deref() == Some("vault") {
                trash_into_vault(root, &arg_str(args, 0)?)?;
            } else {
                trash(root, &arg_str(args, 0)?)?;
            }
            ok
        }
        "search" => {
            // `limit: 0` is "no cap", which the rename pass asks for so it finds every inbound
            // link (N20); a negative number is nonsense and takes the default.
            let limit = opt_field_i64(args, 1, "limit", DEFAULT_SEARCH_LIMIT as i64);
            let limit = if limit < 0 {
                DEFAULT_SEARCH_LIMIT
            } else {
                limit as usize
            };
            let chan = args
                .get(1)
                .and_then(|v| v.get("chan"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Ok(search(root, &arg_str(args, 0)?, limit, chan.as_deref()))
        }
        _ => Err(format!("unknown command: {cmd}")),
    }
}

fn to_value<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_stays_inside() {
        let root = Path::new("/vault");
        assert_eq!(resolve(root, "").unwrap(), root);
        assert_eq!(resolve(root, "/a/b").unwrap(), root.join("a").join("b"));
        assert_eq!(resolve(root, "a\\b").unwrap(), root.join("a").join("b"));
        assert_eq!(resolve(root, "a/./b").unwrap(), root.join("a").join("b"));
        assert_eq!(resolve(root, "a/x/../b").unwrap(), root.join("a").join("b"));
        assert!(resolve(root, "../etc").is_err());
        assert!(resolve(root, "a/../../etc").is_err());
        assert!(resolve(root, "C:/Windows").is_err());
    }

    #[test]
    fn hidden_names() {
        assert!(is_hidden(".git"));
        assert!(is_hidden(".ose"));
        assert!(is_hidden("App"));
        assert!(is_hidden(".anything"));
        assert!(!is_hidden("_Archive"));
        assert!(!is_hidden("Personal"));
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
        let exe = vault.join("os.app").join("Contents").join("MacOS").join("os");
        assert_eq!(root_above(&exe), Some(normalize(vault)));
    }

    #[test]
    fn the_suggested_folder_leaves_a_mac_bundle() {
        let exe = Path::new("/Applications/os.app/Contents/MacOS/os");
        assert_eq!(suggested_dir(exe).unwrap(), normalize(Path::new("/Applications")));
        let exe = Path::new(if cfg!(windows) { r"D:\os\os.exe" } else { "/home/h/os/os" });
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

        let r = search(root, "kant ethics", 100, None);
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
        let r = search(root, "kant", 100, None);
        let hits = r["hits"].as_array().unwrap();
        assert_eq!(hits[0]["path"], "kant.md");
        assert_eq!(hits[0]["line"], 0);
        assert_eq!(r["total"], 4);
        assert_eq!(r["capped"], false);

        // The cap counts files, and the answer says how many there were (N34).
        let r = search(root, "kant", 2, None);
        assert_eq!(r["files"], 2);
        assert_eq!(r["total"], 4);
        assert_eq!(r["capped"], true);

        // limit 0 is no cap at all: what the rename pass asks for (N20).
        let r = search(root, "kant", 0, None);
        assert_eq!(r["files"], 4);
        assert_eq!(r["capped"], false);

        // `col` is 1-based in the trimmed line (N36).
        let r = search(root, "again", 100, None);
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

        let r = search(root, "path:a word", 100, None);
        let hits = r["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["path"], "a/one.md");

        let r = search(root, "file:two word", 100, None);
        let hits = r["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["path"], "b/two.md");

        // A folder whose name matches is a hit of its own, with line 0 (N35).
        let r = search(root, "a", 100, None);
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
}
