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

use crate::{arg_str, arg_str_or, opt_field_i64, Ctx};

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
];

const MAX_DEPTH: usize = 24;
const DEFAULT_SEARCH_LIMIT: usize = 200;
const SNIPPET: usize = 240;

pub fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || HIDDEN.iter().any(|h| h.eq_ignore_ascii_case(name))
}

// ---- root resolution -------------------------------------------------------

/// A vault is a folder with a `CLAUDE.md` at its root. The source repository has one too, so a
/// folder that also holds `src-tauri` is the app, not a vault (matters when running from
/// `src-tauri/target/release` during development).
fn looks_like_vault(dir: &Path) -> bool {
    dir.join("CLAUDE.md").is_file() && !dir.join("src-tauri").is_dir()
}

/// `--root` when it exists, else the executable's folder or the nearest ancestor that holds
/// `CLAUDE.md` (on macOS the walk climbs out of `os.app/Contents/MacOS`),
/// else `OSE_ROOT`. `None` means the caller must tell the user and exit.
pub fn resolve_root(explicit: Option<&str>) -> Option<PathBuf> {
    if let Some(r) = explicit.filter(|r| !r.is_empty()) {
        let full = normalize(Path::new(r));
        if full.is_dir() {
            return Some(full);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(normalize);
        while let Some(d) = dir {
            if looks_like_vault(&d) {
                return Some(d);
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }

    if let Some(env) = std::env::var_os("OSE_ROOT") {
        let full = normalize(Path::new(&env));
        if full.is_dir() {
            return Some(full);
        }
    }

    None
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
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    Ok(())
}

/// UTF-8 without a byte-order mark, bytes exactly as given.
pub fn write_text(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    ensure_parent(&full)?;
    fs::write(&full, text.as_bytes()).map_err(|e| format!("{rel}: {e}"))
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
    fs::write(&full, bytes).map_err(|e| format!("{rel}: {e}"))
}

pub fn mkdir(root: &Path, rel: &str) -> Result<(), String> {
    let full = resolve(root, rel)?;
    fs::create_dir_all(&full).map_err(|e| format!("{rel}: {e}"))
}

/// Never overwrites: the .NET host moved with `overwrite: false` and the UI relies on that
/// to keep a rename from swallowing an existing page.
pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let src = resolve(root, from)?;
    let dst = resolve(root, to)?;
    if !src.exists() {
        return Err(format!("nothing to rename: {from}"));
    }
    if dst.exists() && src != dst {
        return Err(format!("target already exists: {to}"));
    }
    ensure_parent(&dst)?;
    fs::rename(&src, &dst).map_err(|e| format!("{from} -> {to}: {e}"))
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
    trash::delete(&full).map_err(|e| format!("{rel}: {e}"))
}

// ---- search ----------------------------------------------------------------

/// Case-insensitive substring over every `*.md` outside the hidden names.
pub fn search(root: &Path, query: &str, limit: usize) -> Vec<Value> {
    let mut hits = Vec::new();
    if query.is_empty() {
        return hits;
    }
    let limit = if limit == 0 { DEFAULT_SEARCH_LIMIT } else { limit };
    let needle = query.to_lowercase();
    search_dir(root, root, &needle, limit, &mut hits, 0);
    hits
}

fn search_dir(
    root: &Path,
    dir: &Path,
    needle: &str,
    limit: usize,
    hits: &mut Vec<Value>,
    depth: usize,
) {
    if hits.len() >= limit || depth > MAX_DEPTH {
        return;
    }
    for (path, meta) in visible(dir) {
        if hits.len() >= limit {
            return;
        }
        if meta.is_dir() {
            search_dir(root, &path, needle, limit, hits, depth + 1);
            continue;
        }
        let is_md = path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_md {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let rel = relative(root, &path);
        for (i, line) in text.lines().enumerate() {
            if !line.to_lowercase().contains(needle) {
                continue;
            }
            let trimmed = line.trim();
            let snippet: String = trimmed.chars().take(SNIPPET).collect();
            hits.push(json!({ "path": rel, "line": i + 1, "text": snippet }));
            if hits.len() >= limit {
                return;
            }
        }
    }
}

// ---- dispatch --------------------------------------------------------------

const COMMANDS: &[&str] = &[
    "rootInfo",
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
    Some(dispatch(&ctx.st.root, cmd, args))
}

fn dispatch(root: &Path, cmd: &str, args: &[Value]) -> Result<Value, String> {
    let ok = Ok(Value::Null);
    match cmd {
        "rootInfo" => Ok(root_info(root)),
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
            trash(root, &arg_str(args, 0)?)?;
            ok
        }
        "search" => {
            let limit = opt_field_i64(args, 1, "limit", DEFAULT_SEARCH_LIMIT as i64);
            let limit = if limit <= 0 {
                DEFAULT_SEARCH_LIMIT
            } else {
                limit as usize
            };
            Ok(Value::Array(search(root, &arg_str(args, 0)?, limit)))
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

    #[test]
    fn natural_order() {
        assert_eq!(natural_compare("2. Foo", "10. Foo"), Ordering::Less);
        assert_eq!(natural_compare("0. Index", "1. Life"), Ordering::Less);
        assert_eq!(natural_compare("b", "A"), Ordering::Greater);
        assert_eq!(natural_compare("a", "a"), Ordering::Equal);
        assert_eq!(natural_compare("a", "ab"), Ordering::Less);
    }
}
