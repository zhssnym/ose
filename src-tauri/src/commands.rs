//! Every command the page can ask of the host (docs/HOST.md "Commands"), one `#[tauri::command]`
//! each, with serde structs in and out and `HostError` for every refusal. The TypeScript the
//! kernel imports (`src/kernel/bridge/bindings.ts`) is generated from these signatures
//! (bindings.rs); the JS name of each command is the camelCase of its Rust name.
//!
//! The conventions:
//!
//! - Every command finds its window's state (`Win`) from the window that invoked it: each window
//!   has its own vault and its own epoch.
//! - A mutating command's options carry `epoch?`; a mismatch with this window's epoch is
//!   `stale_vault`, so the last save of a page from a vault that was just left can never land in
//!   the one that replaced it.
//! - A path is a vault path. The commands marked **A** in docs/HOST.md also take `abs:` for an
//!   outside file this window registered (`outsideOpen`); on any other command `abs:` is
//!   `escapes_vault`, and an unregistered one is `not_registered`.
//! - The commands that walk or copy a whole tree (`tree`, `search`, `copyPath`, the trash) run on
//!   a blocking worker, never on the async runtime's own threads.
//! - Every failure goes to the log as `cmd <name> failed: <code> <message>`; `--log` also traces
//!   each command's name.
//!
//! Tauri's `#[command]` on a `pub` fn exports a helper macro named after it to the crate root,
//! which is why the commands live in this module rather than in lib.rs.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{Manager as _, State, WebviewWindow};

use crate::drafts::Scope;
use crate::files::{Keep, SaveReq};
use crate::windows::{self, OpenRequest};
use crate::{
    drafts, files, local, log_at, log_line, outside, platform, print, state, trace_line, trashbin, vault, vaults,
    versions, Host, HostError, HostResult, Level, Source, Win,
};

// ---- plumbing ----------------------------------------------------------------

/// The state of the window that invoked a command.
fn win_of(window: &WebviewWindow, host: &Host) -> Arc<Win> {
    host.win(window.label())
}

/// A failure into the log, with its code, and back to the caller unchanged.
fn done<T>(host: &Host, name: &str, r: HostResult<T>) -> HostResult<T> {
    if let Err(e) = &r {
        log_at(host, Level::Warn, &format!("cmd {name} failed: {} {}", e.code(), e.message()));
    }
    r
}

/// `--log` names every command; the persistent log does not (it would drown in them).
fn trace(host: &Host, name: &str) {
    trace_line(host, &format!("cmd {name}"));
}

/// A module's `Result<_, String>` as the command's.
fn m<T>(r: Result<T, String>) -> HostResult<T> {
    r.map_err(HostError::from)
}

/// A module's JSON answer as the command's typed one.
///
/// This is the compatibility layer of the typed commands (docs/HOST.md "Commands"): the module
/// functions still build their answers with `json!` and fail with `Result<_, String>` and a
/// `[code]` prefix, and each command reads the answer into its struct here and the error into
/// `HostError` (`m`). The signatures, and so the bindings, are typed; the shapes the modules
/// build are checked by `module_answers_fit_their_types`, which runs every module function that
/// comes through here against the struct its command answers, not by the compiler.
fn typed<T: for<'de> Deserialize<'de>>(v: Value) -> HostResult<T> {
    serde_json::from_value(v).map_err(|e| HostError::Io(format!("the host built an answer it cannot read: {e}")))
}

/// A module's JSON list as typed rows, each read on its own: a row that does not fit is left
/// out and said in the log (`drop`), so one odd record cannot fail the whole list. For lists
/// read from files on disk (the drafts), which may hold what an older or newer build wrote.
fn typed_rows<T: for<'de> Deserialize<'de>>(v: Value, drop: &dyn Fn(&str)) -> HostResult<Vec<T>> {
    let Value::Array(rows) = v else { return typed(v) };
    Ok(rows
        .into_iter()
        .filter_map(|row| match serde_json::from_value::<T>(row.clone()) {
            Ok(t) => Some(t),
            Err(e) => {
                let what = row.get("path").and_then(Value::as_str).unwrap_or("?").to_string();
                drop(&format!("left out of the list, it does not fit: {what}: {e}"));
                None
            }
        })
        .collect())
}

/// Runs `f` on a blocking worker: the commands that walk or copy a whole tree.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> HostResult<T> + Send + 'static) -> HostResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(HostError::Io(format!("worker failed: {e}"))))
}

/// A path that must be a vault path: `abs:` is refused.
fn vault_only(p: &str) -> HostResult<()> {
    if outside::is_abs(p) {
        return Err(HostError::EscapesVault(format!("a vault path is needed here, not an outside file: {p}")));
    }
    Ok(())
}

/// The window's root for a command on `path` that names `epoch`.
fn root_for(win: &Win, path: &str, epoch: Option<u64>) -> HostResult<PathBuf> {
    vault_only(path)?;
    m(win.require_root_at(epoch))
}

/// Where a command marked **A** lands.
enum Place {
    Vault { root: PathBuf },
    Outside { full: PathBuf },
}

fn place(win: &Win, path: &str, epoch: Option<u64>) -> HostResult<Place> {
    if outside::is_abs(path) {
        return Ok(Place::Outside { full: m(win.outside.resolve(path))? });
    }
    Ok(Place::Vault { root: m(win.require_root_at(epoch))? })
}

/// `expectedHash` must be present: a string, or `null` for "the file must not exist".
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}

// ---- argument and answer types -----------------------------------------------

/// Only the epoch.
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EpochOpts {
    #[specta(optional)]
    pub epoch: Option<u64>,
}

fn ep(o: &Option<EpochOpts>) -> Option<u64> {
    o.as_ref().and_then(|o| o.epoch)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RootInfo {
    pub root: Option<String>,
    pub name: Option<String>,
    pub epoch: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum RootSource {
    Arg,
    Exe,
    Env,
    Remembered,
    Picked,
    Opened,
}

impl From<Source> for RootSource {
    fn from(s: Source) -> Self {
        match s {
            Source::Arg => RootSource::Arg,
            Source::Exe => RootSource::Exe,
            Source::Env => RootSource::Env,
            Source::Remembered => RootSource::Remembered,
            Source::Picked => RootSource::Picked,
            Source::Opened => RootSource::Opened,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct VaultInfo {
    pub root: Option<String>,
    pub name: Option<String>,
    pub remembered: bool,
    pub source: Option<RootSource>,
    pub epoch: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct PickVaultOpts {
    #[specta(optional)]
    pub adopt: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PickedVault {
    pub root: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum OpenVault {
    Adopted { root: String, name: String, epoch: u64 },
    Focused { label: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WindowOpened {
    pub label: String,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecentVault {
    pub path: String,
    pub name: String,
    pub exists: bool,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BuildStamp {
    pub sha: String,
    pub short: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: String,
    pub version: String,
    pub exe: String,
    pub exe_dir: Option<String>,
    pub root: Option<String>,
    pub log_path: String,
    pub build: Option<BuildStamp>,
    /// A PNG the host wrote for the drag-out image, or null.
    pub drag_icon: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct ListOpts {
    #[specta(optional)]
    pub hidden: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct StatOpts {
    #[specta(optional)]
    pub sniff: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Stat {
    pub exists: bool,
    pub kind: Option<String>,
    pub mtime: i64,
    pub size: u64,
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub link: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub text: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct SearchOpts {
    #[specta(optional)]
    pub limit: Option<i64>,
    #[specta(optional)]
    pub chan: Option<String>,
    #[specta(optional)]
    pub hidden: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SearchHit {
    pub path: String,
    pub line: u64,
    pub col: u64,
    pub text: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub files: u64,
    pub total: u64,
    pub capped: bool,
    pub stale: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct ReadOpts {
    /// Decode in this encoding instead of detecting one (a WHATWG label).
    #[specta(optional)]
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ReadFile {
    pub text: String,
    pub hash: String,
    pub mtime: i64,
    pub size: u64,
    /// The encoding the text was decoded from, as the Encoding Standard names it (`UTF-8`,
    /// `UTF-16LE`, `windows-1252`, …).
    pub encoding: String,
    pub bom: bool,
    /// The bytes do not come back from encoding the text: open read-only.
    pub lossy: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum VersionMode {
    Save,
    Conflict,
    None,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveOpts {
    /// Required: the hash `readFile` answered, or `null` when the file must not exist.
    #[serde(deserialize_with = "present")]
    #[specta(type = Option<String>)]
    pub expected_hash: Option<String>,
    #[specta(optional)]
    pub version: Option<VersionMode>,
    /// The encoding to write in; UTF-8 when absent.
    #[specta(optional)]
    pub encoding: Option<String>,
    /// `true` only for an explicit conversion to UTF-8 (`page.save-utf8`). A UTF-8 save over a
    /// file whose bytes are not UTF-8 is `lossy` without it, and nothing is written.
    #[specta(optional)]
    pub convert: Option<bool>,
    #[specta(optional)]
    pub epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DiskState {
    pub exists: bool,
    pub text: Option<String>,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum SaveOutcome {
    Saved {
        hash: String,
        mtime: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        unchanged: Option<bool>,
    },
    Conflict {
        disk: DiskState,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Created {
    pub path: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Hashed {
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ReplaceOutcome {
    Replaced { hash: String },
    Conflict { actual: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Copied {
    pub path: String,
    pub files: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub left_out: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct TrashOpts {
    /// `vault` for the vault's `.trash`, anything else for the system bin.
    #[specta(optional)]
    pub mode: Option<String>,
    #[specta(optional)]
    pub epoch: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct TrashWhereOpts {
    #[specta(optional)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Trashed {
    pub id: Option<String>,
    #[serde(rename = "where")]
    pub place: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TrashPlace {
    #[serde(rename = "where")]
    pub place: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub name: String,
    pub original: String,
    pub deleted_at: i64,
    pub kind: String,
    pub size: u64,
    #[serde(rename = "where")]
    pub place: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub known: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RestoredItem {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FailedItem {
    pub id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Restored {
    pub restored: Vec<RestoredItem>,
    pub failed: Vec<FailedItem>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum EditorMode {
    Rich,
    Live,
    Source,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub text: String,
    pub baseline_hash: Option<String>,
    pub mode: EditorMode,
    #[serde(default = "yes")]
    #[specta(optional)]
    pub exact: bool,
    #[serde(default)]
    #[specta(optional)]
    pub rev: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub at: Option<i64>,
    /// Set by the host on the way out: the vault path or `abs:` path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub path: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DraftInfo {
    pub path: String,
    pub baseline_hash: Option<String>,
    pub mode: EditorMode,
    pub exact: bool,
    pub rev: f64,
    pub at: i64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DraftAt {
    pub at: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DraftDropOpts {
    #[specta(optional)]
    pub if_rev: Option<f64>,
    #[specta(optional)]
    pub epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Dropped {
    pub dropped: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct KeepOpts {
    #[specta(optional)]
    pub force: Option<bool>,
    /// `save`, `conflict`, `reload` or `restore`.
    #[specta(optional)]
    pub reason: Option<String>,
    #[specta(optional)]
    pub epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Kept {
    pub kept: bool,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct VersionInfo {
    pub id: String,
    pub at: i64,
    pub bytes: u64,
    pub reason: String,
    pub session: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RestoredVersion {
    pub kept: bool,
    pub id: Option<String>,
    pub hash: String,
}

/// Any JSON the page keeps (its state, the local store): `unknown` in TypeScript. (specta's own
/// `serde_json::Value` recurses without end in this beta, so the value travels in a newtype.)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct Json(#[specta(type = specta_typescript::Unknown)] pub Value);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum LocalScope {
    App,
    Vault,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct PdfOpts {
    #[specta(optional)]
    pub name: Option<String>,
    #[specta(optional)]
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum PdfOutcome {
    Written { path: String, bytes: u64 },
    Cancelled { cancelled: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Shown {
    pub shown: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct OutsideFile {
    /// The vault path when the file is inside this window's vault, else its `abs:` path.
    pub path: String,
    pub inside: bool,
    pub name: String,
    pub exists: bool,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct PickFileOpts {
    #[specta(optional)]
    pub title: Option<String>,
}

// ---- vaults and windows --------------------------------------------------------

fn root_info_of(win: &Win) -> RootInfo {
    let root = win.root();
    RootInfo {
        root: root.as_ref().map(|r| r.to_string_lossy().to_string()),
        name: root.as_deref().map(vault::root_name),
        epoch: win.epoch(),
    }
}

/// `rootInfo()`: this window's vault, or nulls, and its epoch.
#[tauri::command]
#[specta::specta]
pub async fn root_info(window: WebviewWindow, host: State<'_, Host>) -> HostResult<RootInfo> {
    trace(&host, "root_info");
    Ok(root_info_of(&win_of(&window, &host)))
}

/// `vaultInfo()`: `rootInfo` with where the root came from and whether one is remembered.
#[tauri::command]
#[specta::specta]
pub async fn vault_info(window: WebviewWindow, host: State<'_, Host>) -> HostResult<VaultInfo> {
    trace(&host, "vault_info");
    let win = win_of(&window, &host);
    let info = win.root_info();
    Ok(VaultInfo {
        root: info.as_ref().map(|r| r.path.to_string_lossy().to_string()),
        name: info.as_ref().map(|r| vault::root_name(&r.path)),
        remembered: vault::is_remembered(window.app_handle()),
        source: info.map(|r| r.source.into()),
        epoch: win.epoch(),
    })
}

/// Adopts `dir` in this window, unless another window has it open: that one is focused instead.
fn adopt_or_focus(app: &tauri::AppHandle, host: &Host, win: &Win, dir: &Path, source: Source) -> HostResult<OpenVault> {
    let full = vault::normalize(dir);
    if !full.is_dir() {
        return Err(HostError::NotFound(format!("not a folder: {}", full.display())));
    }
    if let Some(other) = host.window_of_root(&full).filter(|o| o.label != win.label) {
        windows::raise(app, &other.label);
        log_line(host, &format!("{}: {} is open in {}, focused it", win.label, full.display(), other.label));
        return Ok(OpenVault::Focused { label: other.label.clone() });
    }
    let (root, epoch) = m(vault::adopt(app, host, win, &full, source))?;
    // A vault the user chose is a vault they may want back.
    if let Err(e) = vaults::record(app, &root) {
        log_line(host, &format!("recent vaults: {e}"));
    }
    Ok(OpenVault::Adopted { root: root.to_string_lossy().to_string(), name: vault::root_name(&root), epoch })
}

/// `pickVault({adopt})`: the native folder picker, opened in the executable's folder; `null` on
/// cancel. With `adopt` (the default) the choice is adopted in this window; without, it is only
/// chosen and answered as `{root, name}`, so the page can leave the old vault first.
#[tauri::command]
#[specta::specta]
pub async fn pick_vault(
    window: WebviewWindow,
    host: State<'_, Host>,
    opts: Option<PickVaultOpts>,
) -> HostResult<Option<PickedVault>> {
    trace(&host, "pick_vault");
    let r = async {
        let adopt = opts.and_then(|o| o.adopt).unwrap_or(true);
        let picker = host.picker.ok_or_else(|| HostError::Unsupported("this build has no folder picker".into()))?;
        let start = vault::exe_dir().filter(|d| d.is_dir());
        let (tx, mut rx) = tauri::async_runtime::channel::<Option<PathBuf>>(1);
        picker(
            window.app_handle(),
            Some(window.clone()),
            start,
            Box::new(move |picked| {
                let _ = tx.try_send(picked);
            }),
        );
        let Some(path) = rx.recv().await.flatten() else { return Ok(None) };
        let full = vault::normalize(&path);
        if !full.is_dir() {
            return Err(HostError::NotFound(format!("not a folder: {}", full.display())));
        }
        if !adopt {
            return Ok(Some(PickedVault { root: full.to_string_lossy().to_string(), name: vault::root_name(&full), epoch: None }));
        }
        let win = win_of(&window, &host);
        match adopt_or_focus(window.app_handle(), &host, &win, &full, Source::Picked)? {
            OpenVault::Adopted { root, name, epoch } => Ok(Some(PickedVault { root, name, epoch: Some(epoch) })),
            // Already open in another window, which was brought forward: nothing changes here.
            OpenVault::Focused { .. } => Ok(None),
        }
    }
    .await;
    done(&host, "pick_vault", r)
}

/// `openVault(path)`: adopts a folder in this window with no dialog, or focuses the window that
/// already has it (`{status:'focused', label}`).
#[tauri::command]
#[specta::specta]
pub async fn open_vault(window: WebviewWindow, host: State<'_, Host>, path: String) -> HostResult<OpenVault> {
    trace(&host, "open_vault");
    let r = (|| {
        if path.trim().is_empty() {
            return Err(HostError::BadArg("openVault needs a path".into()));
        }
        let win = win_of(&window, &host);
        adopt_or_focus(window.app_handle(), &host, &win, Path::new(&path), Source::Picked)
    })();
    done(&host, "open_vault", r)
}

/// `openVaultWindow(path?)`: a window for the vault at `path`, focused when one exists, made
/// otherwise; with no path, a new window with no vault (the chooser).
#[tauri::command]
#[specta::specta]
pub async fn open_vault_window(window: WebviewWindow, host: State<'_, Host>, path: Option<String>) -> HostResult<WindowOpened> {
    trace(&host, "open_vault_window");
    let r = (|| {
        let app = window.app_handle();
        let root = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => {
                let full = vault::normalize(Path::new(p));
                if !full.is_dir() {
                    return Err(HostError::NotFound(format!("not a folder: {}", full.display())));
                }
                if let Some(w) = host.window_of_root(&full) {
                    windows::raise(app, &w.label);
                    return Ok(WindowOpened { label: w.label.clone(), created: false });
                }
                if let Err(e) = vaults::record(app, &full) {
                    log_line(&host, &format!("recent vaults: {e}"));
                }
                Some(crate::Root { path: full, source: Source::Picked })
            }
            None => None,
        };
        let label = host.next_label();
        m(windows::build(app, &label, root))?;
        Ok(WindowOpened { label, created: true })
    })();
    done(&host, "open_vault_window", r)
}

/// `recentVaults()`: the vaults this machine opened, newest first, at most ten.
#[tauri::command]
#[specta::specta]
pub async fn recent_vaults(window: WebviewWindow, host: State<'_, Host>) -> HostResult<Vec<RecentVault>> {
    trace(&host, "recent_vaults");
    let current = win_of(&window, &host).root();
    done(&host, "recent_vaults", typed(vaults::list_value(window.app_handle(), current.as_deref())))
}

/// `forgetVault(path?)`: with a path, drops that recent entry; without, stops remembering a root.
#[tauri::command]
#[specta::specta]
pub async fn forget_vault(window: WebviewWindow, host: State<'_, Host>, path: Option<String>) -> HostResult<()> {
    trace(&host, "forget_vault");
    let app = window.app_handle();
    let r = match path.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(p) => m(vaults::forget_one(app, Path::new(p))),
        None => m(vault::forget(app).map_err(crate::with_code)),
    };
    done(&host, "forget_vault", r)
}

/// `platform()`: what this host is.
#[tauri::command]
#[specta::specta]
pub async fn platform(window: WebviewWindow, host: State<'_, Host>) -> HostResult<PlatformInfo> {
    trace(&host, "platform");
    let win = win_of(&window, &host);
    Ok(PlatformInfo {
        os: platform::os_name().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        exe: std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
        exe_dir: vault::exe_dir().map(|p| p.display().to_string()),
        root: win.root().map(|p| p.display().to_string()),
        log_path: crate::persistent_log_path().map(|p| p.display().to_string()).unwrap_or_default(),
        build: platform::build_info().map(|b| BuildStamp { sha: b.sha, short: b.short, date: b.date }),
        drag_icon: host.drag_icon().map(|p| p.display().to_string()),
    })
}

/// `quit()`: every window closes through its own save path (CloseRequested -> the adapter's
/// `closing` handshake -> destroy), so Ctrl+Q saves like the close button does (S16).
#[tauri::command]
#[specta::specta]
pub async fn quit(window: WebviewWindow, host: State<'_, Host>) -> HostResult<()> {
    trace(&host, "quit");
    close_all(window.app_handle());
    Ok(())
}

/// Every window asked to close through its save path; the app exits when none is left.
pub fn close_all(app: &tauri::AppHandle) {
    let open = app.webview_windows();
    if open.is_empty() {
        app.exit(0);
        return;
    }
    log_line(app.state::<Host>().inner(), "quit: closing every window through its save path");
    for w in open.values() {
        let _ = w.close();
    }
}

/// `log(text, level)`: a line of the page's into the host log.
#[tauri::command]
#[specta::specta]
pub async fn log(host: State<'_, Host>, text: String, level: Option<String>) -> HostResult<()> {
    log_at(&host, Level::parse(level.as_deref().unwrap_or("info")), &format!("ui: {text}"));
    Ok(())
}

// ---- listing -------------------------------------------------------------------

/// `tree({hidden})`: the whole vault as one entry.
#[tauri::command]
#[specta::specta]
pub async fn tree(window: WebviewWindow, host: State<'_, Host>, opts: Option<ListOpts>) -> HostResult<vault::Entry> {
    trace(&host, "tree");
    let r = match m(win_of(&window, &host).require_root()) {
        Ok(root) => {
            let hidden = opts.and_then(|o| o.hidden).unwrap_or(false);
            blocking(move || m(vault::tree(&root, hidden))).await
        }
        Err(e) => Err(e),
    };
    done(&host, "tree", r)
}

/// `list(path, {hidden})`: one folder's entries.
#[tauri::command]
#[specta::specta]
pub async fn list(window: WebviewWindow, host: State<'_, Host>, path: String, opts: Option<ListOpts>) -> HostResult<Vec<vault::Entry>> {
    trace(&host, "list");
    let r = (|| {
        let root = root_for(&win_of(&window, &host), &path, None)?;
        m(vault::list(&root, &path, opts.and_then(|o| o.hidden).unwrap_or(false)))
    })();
    done(&host, "list", r)
}

/// `stat(path, {sniff})` (**A**).
#[tauri::command]
#[specta::specta]
pub async fn stat(window: WebviewWindow, host: State<'_, Host>, path: String, opts: Option<StatOpts>) -> HostResult<Stat> {
    trace(&host, "stat");
    let r = (|| {
        let sniff = opts.and_then(|o| o.sniff).unwrap_or(false);
        match place(&win_of(&window, &host), &path, None)? {
            Place::Vault { root } => typed(m(vault::stat(&root, &path, sniff))?),
            Place::Outside { full } => typed(vault::stat_outside(&full, sniff)),
        }
    })();
    done(&host, "stat", r)
}

/// `exists(path)` (**A**).
#[tauri::command]
#[specta::specta]
pub async fn exists(window: WebviewWindow, host: State<'_, Host>, path: String) -> HostResult<bool> {
    trace(&host, "exists");
    let r = (|| match place(&win_of(&window, &host), &path, None)? {
        Place::Vault { root } => m(vault::exists(&root, &path)),
        Place::Outside { full } => Ok(full.exists()),
    })();
    done(&host, "exists", r)
}

/// `search(query, {limit, chan, hidden})`: files, lines and names. `limit: 0` is no cap.
#[tauri::command]
#[specta::specta]
pub async fn search(window: WebviewWindow, host: State<'_, Host>, query: String, opts: Option<SearchOpts>) -> HostResult<SearchResult> {
    trace(&host, "search");
    let r = match m(win_of(&window, &host).require_root()) {
        Ok(root) => {
            let o = opts.unwrap_or_default();
            let limit = match o.limit {
                Some(n) if n >= 0 => n as usize,
                _ => vault::DEFAULT_SEARCH_LIMIT,
            };
            let chan = o.chan.filter(|c| !c.is_empty());
            let hidden = o.hidden.unwrap_or(false);
            blocking(move || typed(vault::search(&root, &query, limit, chan.as_deref(), hidden))).await
        }
        Err(e) => Err(e),
    };
    done(&host, "search", r)
}

// ---- files ---------------------------------------------------------------------

/// `readText(path)` (**A**): the file as UTF-8, nothing else.
#[tauri::command]
#[specta::specta]
pub async fn read_text(window: WebviewWindow, host: State<'_, Host>, path: String) -> HostResult<String> {
    trace(&host, "read_text");
    let r = (|| match place(&win_of(&window, &host), &path, None)? {
        Place::Vault { root } => m(vault::read_text(&root, &path)),
        Place::Outside { full } => {
            let bytes = std::fs::read(&full).map_err(HostError::from)?;
            String::from_utf8(bytes).map_err(|_| HostError::NotUtf8(format!("not valid UTF-8: {path}")))
        }
    })();
    done(&host, "read_text", r)
}

/// `readFile(path, {encoding})` (**A**): the text, its hash and its encoding.
#[tauri::command]
#[specta::specta]
pub async fn read_file(window: WebviewWindow, host: State<'_, Host>, path: String, opts: Option<ReadOpts>) -> HostResult<ReadFile> {
    trace(&host, "read_file");
    let r = (|| {
        let forced = opts.and_then(|o| o.encoding).filter(|e| !e.trim().is_empty());
        let full = match place(&win_of(&window, &host), &path, None)? {
            Place::Vault { root } => m(vault::resolve(&root, &path))?,
            Place::Outside { full } => full,
        };
        typed(m(files::read_file_at(&full, &path, forced.as_deref()))?)
    })();
    done(&host, "read_file", r)
}

/// `saveFile(path, text, {expectedHash, version, encoding})` (**A**): compares and writes in one
/// call under one lock. On an outside file no version is kept.
#[tauri::command]
#[specta::specta]
pub async fn save_file(window: WebviewWindow, host: State<'_, Host>, path: String, text: String, opts: SaveOpts) -> HostResult<SaveOutcome> {
    trace(&host, "save_file");
    let r = (|| {
        let keep = match opts.version {
            None | Some(VersionMode::Save) => Keep::Save,
            Some(VersionMode::Conflict) => Keep::Conflict,
            Some(VersionMode::None) => Keep::None,
        };
        let (root, full) = match place(&win_of(&window, &host), &path, opts.epoch)? {
            Place::Vault { root } => {
                let full = m(vault::resolve(&root, &path))?;
                (Some(root), full)
            }
            Place::Outside { full } => (None, full),
        };
        let req = SaveReq {
            root: root.as_deref(),
            full,
            rel: &path,
            text: &text,
            expected: opts.expected_hash.as_deref(),
            keep: if root.is_some() { keep } else { Keep::None },
            encoding: opts.encoding.as_deref().filter(|e| !e.trim().is_empty()),
            convert: opts.convert.unwrap_or(false),
        };
        let note = |s: &str| log_at(&host, Level::Warn, s);
        let out = files::save(&req, &note);
        files::log_save(&host, &path, &out);
        typed(m(out)?)
    })();
    done(&host, "save_file", r)
}

/// `createNew(path, text, opts)`: an exclusive create; never overwrites.
#[tauri::command]
#[specta::specta]
pub async fn create_new(window: WebviewWindow, host: State<'_, Host>, path: String, text: Option<String>, opts: Option<EpochOpts>) -> HostResult<Created> {
    trace(&host, "create_new");
    let r = (|| {
        let root = root_for(&win_of(&window, &host), &path, ep(&opts))?;
        typed(m(files::create_new(&root, &path, text.as_deref().unwrap_or("")))?)
    })();
    done(&host, "create_new", r)
}

/// `createNewBinary(path, base64, opts)`: bytes into a new file, created and written in one call.
#[tauri::command]
#[specta::specta]
pub async fn create_new_binary(window: WebviewWindow, host: State<'_, Host>, path: String, data: String, opts: Option<EpochOpts>) -> HostResult<Created> {
    trace(&host, "create_new_binary");
    let r = (|| {
        let root = root_for(&win_of(&window, &host), &path, ep(&opts))?;
        typed(m(files::create_new_binary(&root, &path, &data))?)
    })();
    done(&host, "create_new_binary", r)
}

/// `copyFile(from, to, opts)`: a byte copy under the create-only rule.
#[tauri::command]
#[specta::specta]
pub async fn copy_file(window: WebviewWindow, host: State<'_, Host>, from: String, to: String, opts: Option<EpochOpts>) -> HostResult<Created> {
    trace(&host, "copy_file");
    let r = (|| {
        vault_only(&from)?;
        let root = root_for(&win_of(&window, &host), &to, ep(&opts))?;
        typed(m(files::copy_file(&root, &from, &to))?)
    })();
    done(&host, "copy_file", r)
}

/// `importOutside(from, to, opts)`: a registered outside file's bytes into a new vault file.
#[tauri::command]
#[specta::specta]
pub async fn import_outside(window: WebviewWindow, host: State<'_, Host>, from: String, to: String, opts: Option<EpochOpts>) -> HostResult<Created> {
    trace(&host, "import_outside");
    let r = (|| {
        let win = win_of(&window, &host);
        if !outside::is_abs(&from) {
            return Err(HostError::BadArg(format!("importOutside takes an outside file: {from}")));
        }
        let src = m(win.outside.resolve(&from))?;
        let root = root_for(&win, &to, ep(&opts))?;
        typed(m(files::import_outside(&root, &src, &to))?)
    })();
    done(&host, "import_outside", r)
}

/// `appendLine(path, line, opts)`: one line, with the separator the file uses.
#[tauri::command]
#[specta::specta]
pub async fn append_line(window: WebviewWindow, host: State<'_, Host>, path: String, line: String, opts: Option<EpochOpts>) -> HostResult<Hashed> {
    trace(&host, "append_line");
    let r = (|| {
        let root = root_for(&win_of(&window, &host), &path, ep(&opts))?;
        typed(m(files::append_line(&root, &path, &line))?)
    })();
    done(&host, "append_line", r)
}

/// `replaceLine(path, index, expected, next, opts)`: one line, only while it still reads
/// `expected`.
#[tauri::command]
#[specta::specta]
pub async fn replace_line(
    window: WebviewWindow,
    host: State<'_, Host>,
    path: String,
    index: i64,
    expected: String,
    next: String,
    opts: Option<EpochOpts>,
) -> HostResult<ReplaceOutcome> {
    trace(&host, "replace_line");
    let r = (|| {
        let root = root_for(&win_of(&window, &host), &path, ep(&opts))?;
        let note = |s: &str| log_at(&host, Level::Warn, s);
        typed(m(files::replace_line(&root, &path, index, &expected, &next, &note))?)
    })();
    done(&host, "replace_line", r)
}

/// `writeText(path, text, opts)`: the bytes exactly as given, atomically.
#[tauri::command]
#[specta::specta]
pub async fn write_text(window: WebviewWindow, host: State<'_, Host>, path: String, text: String, opts: Option<EpochOpts>) -> HostResult<()> {
    trace(&host, "write_text");
    let r = (|| {
        let root = root_for(&win_of(&window, &host), &path, ep(&opts))?;
        m(vault::write_text(&root, &path, &text))
    })();
    done(&host, "write_text", r)
}

/// `appendText(path, text, opts)`.
#[tauri::command]
#[specta::specta]
pub async fn append_text(window: WebviewWindow, host: State<'_, Host>, path: String, text: String, opts: Option<EpochOpts>) -> HostResult<()> {
    trace(&host, "append_text");
    let r = (|| {
        let root = root_for(&win_of(&window, &host), &path, ep(&opts))?;
        m(vault::append_text(&root, &path, &text))
    })();
    done(&host, "append_text", r)
}

/// `writeBinary(path, base64, opts)`.
#[tauri::command]
#[specta::specta]
pub async fn write_binary(window: WebviewWindow, host: State<'_, Host>, path: String, data: String, opts: Option<EpochOpts>) -> HostResult<()> {
    trace(&host, "write_binary");
    let r = (|| {
        let root = root_for(&win_of(&window, &host), &path, ep(&opts))?;
        m(vault::write_binary(&root, &path, &data))
    })();
    done(&host, "write_binary", r)
}

/// `readBinary(path)` (**A**): the bytes as base64.
#[tauri::command]
#[specta::specta]
pub async fn read_binary(window: WebviewWindow, host: State<'_, Host>, path: String) -> HostResult<String> {
    trace(&host, "read_binary");
    let r = (|| match place(&win_of(&window, &host), &path, None)? {
        Place::Vault { root } => m(vault::read_binary(&root, &path)),
        Place::Outside { full } => {
            use base64::Engine as _;
            let bytes = std::fs::read(&full).map_err(HostError::from)?;
            Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
    })();
    done(&host, "read_binary", r)
}

/// `mkdir(path, opts)`.
#[tauri::command]
#[specta::specta]
pub async fn mkdir(window: WebviewWindow, host: State<'_, Host>, path: String, opts: Option<EpochOpts>) -> HostResult<()> {
    trace(&host, "mkdir");
    let r = (|| {
        let root = root_for(&win_of(&window, &host), &path, ep(&opts))?;
        m(vault::mkdir(&root, &path))
    })();
    done(&host, "mkdir", r)
}

/// `rename(from, to, opts)`: never overwrites; the history and the drafts follow.
#[tauri::command]
#[specta::specta]
pub async fn rename(window: WebviewWindow, host: State<'_, Host>, from: String, to: String, opts: Option<EpochOpts>) -> HostResult<()> {
    trace(&host, "rename");
    let r = (|| {
        vault_only(&from)?;
        let root = root_for(&win_of(&window, &host), &to, ep(&opts))?;
        m(vault::rename(&root, &from, &to))?;
        // The history moves with the file, or with every file of a folder (H10). A history that
        // cannot move is not a failed rename: the file is where it was asked to be.
        if let Err(e) = versions::move_history(&root, &from, &to) {
            log_at(&host, Level::Warn, &format!("history: {from} -> {to}: {e}"));
        }
        // A page's drafts follow it to its new name.
        if let Err(e) = drafts::rekey(host.data_dir().as_deref(), &root, &from, &to) {
            log_at(&host, Level::Warn, &format!("drafts: {from} -> {to}: {e}"));
        }
        Ok(())
    })();
    done(&host, "rename", r)
}

/// `copyPath(from, to, opts)`: a file or a whole folder, bytes, create-only.
#[tauri::command]
#[specta::specta]
pub async fn copy_path(window: WebviewWindow, host: State<'_, Host>, from: String, to: String, opts: Option<EpochOpts>) -> HostResult<Copied> {
    trace(&host, "copy_path");
    let r = match vault_only(&from).and_then(|_| root_for(&win_of(&window, &host), &to, ep(&opts))) {
        Ok(root) => blocking(move || typed(m(vault::copy_path(&root, &from, &to))?)).await,
        Err(e) => Err(e),
    };
    done(&host, "copy_path", r)
}

// ---- trash ---------------------------------------------------------------------

/// `trash(path, {mode})`: to the system bin or the vault's `.trash`; never a permanent delete.
#[tauri::command]
#[specta::specta]
pub async fn trash(window: WebviewWindow, host: State<'_, Host>, path: String, opts: Option<TrashOpts>) -> HostResult<Trashed> {
    trace(&host, "trash");
    let o = opts.unwrap_or_default();
    let r = match root_for(&win_of(&window, &host), &path, o.epoch) {
        Ok(root) => {
            let mode = o.mode.unwrap_or_default();
            blocking(move || typed(m(trashbin::trash(&root, &path, &mode))?)).await
        }
        Err(e) => Err(e),
    };
    done(&host, "trash", r)
}

/// `trashWhere(path, {mode})`: where `trash` would put it.
#[tauri::command]
#[specta::specta]
pub async fn trash_where(window: WebviewWindow, host: State<'_, Host>, path: String, opts: Option<TrashWhereOpts>) -> HostResult<TrashPlace> {
    trace(&host, "trash_where");
    let r = match root_for(&win_of(&window, &host), &path, None) {
        Ok(root) => {
            let mode = opts.and_then(|o| o.mode);
            blocking(move || typed(m(trashbin::trash_where(&root, &path, mode.as_deref()))?)).await
        }
        Err(e) => Err(e),
    };
    done(&host, "trash_where", r)
}

/// `trashList()`: what can be restored, newest first.
#[tauri::command]
#[specta::specta]
pub async fn trash_list(window: WebviewWindow, host: State<'_, Host>) -> HostResult<Vec<TrashItem>> {
    trace(&host, "trash_list");
    let r = match m(win_of(&window, &host).require_root()) {
        Ok(root) => blocking(move || {
            let mut items: Vec<TrashItem> = typed(m(trashbin::trash_list(&root))?)?;
            for i in &mut items {
                i.name = vault::nfc(std::mem::take(&mut i.name));
                i.original = vault::nfc(std::mem::take(&mut i.original));
            }
            Ok(items)
        })
        .await,
        Err(e) => Err(e),
    };
    done(&host, "trash_list", r)
}

/// `trashRestore(ids, opts)`: back where they came from; never overwrites.
#[tauri::command]
#[specta::specta]
pub async fn trash_restore(window: WebviewWindow, host: State<'_, Host>, ids: Vec<String>, opts: Option<EpochOpts>) -> HostResult<Restored> {
    trace(&host, "trash_restore");
    let r = match m(win_of(&window, &host).require_root_at(ep(&opts))) {
        Ok(root) => blocking(move || typed(m(trashbin::trash_restore(&root, &ids))?)).await,
        Err(e) => Err(e),
    };
    done(&host, "trash_restore", r)
}

// ---- drafts --------------------------------------------------------------------

fn data_dir(host: &Host) -> HostResult<PathBuf> {
    host.data_dir().ok_or_else(|| HostError::Io("this machine has no app data folder for drafts".into()))
}

/// The drafts scope of `path` for this window, the root checked against `epoch`.
fn draft_scope(win: &Win, path: &str, epoch: Option<u64>) -> HostResult<(Option<PathBuf>, bool)> {
    if outside::is_abs(path) {
        // An outside draft needs no registration: it is this machine's memory of what was typed
        // for that file, and the page reads it before it has reopened the file.
        m(outside::native(path))?;
        return Ok((None, true));
    }
    Ok((Some(m(win.require_root_at(epoch))?), false))
}

fn scope_of(root: &Option<PathBuf>) -> Scope<'_> {
    match root {
        Some(r) => Scope::Vault(r),
        None => Scope::Outside,
    }
}

/// `draftWrite(path, draft, opts)` (**A**) -> `{at}`.
#[tauri::command]
#[specta::specta]
pub async fn draft_write(window: WebviewWindow, host: State<'_, Host>, path: String, draft: Draft, opts: Option<EpochOpts>) -> HostResult<DraftAt> {
    trace(&host, "draft_write");
    let r = (|| {
        let (root, _) = draft_scope(&win_of(&window, &host), &path, ep(&opts))?;
        let data = data_dir(&host)?;
        let value = serde_json::to_value(&draft).map_err(|e| HostError::BadArg(e.to_string()))?;
        typed(m(drafts::write_in(&data, scope_of(&root), &path, &value, versions::now_ms()))?)
    })();
    done(&host, "draft_write", r)
}

/// `draftList()`: this window's vault's drafts and every outside file's, newest first.
#[tauri::command]
#[specta::specta]
pub async fn draft_list(window: WebviewWindow, host: State<'_, Host>) -> HostResult<Vec<DraftInfo>> {
    trace(&host, "draft_list");
    let r = (|| {
        let Some(data) = host.data_dir() else { return Ok(Vec::new()) };
        let root = win_of(&window, &host).root();
        let mut scopes = vec![Scope::Outside];
        if let Some(r) = &root {
            scopes.insert(0, Scope::Vault(r));
        }
        let drop = |s: &str| log_at(&host, Level::Warn, &format!("draft {s}"));
        typed_rows(drafts::list_in(&data, &scopes), &drop)
    })();
    done(&host, "draft_list", r)
}

/// `draftRead(path)` (**A**): the draft, or `null`.
#[tauri::command]
#[specta::specta]
pub async fn draft_read(window: WebviewWindow, host: State<'_, Host>, path: String) -> HostResult<Option<Draft>> {
    trace(&host, "draft_read");
    let r = (|| {
        let (root, _) = draft_scope(&win_of(&window, &host), &path, None)?;
        let Some(data) = host.data_dir() else { return Ok(None) };
        typed(drafts::read_in(&data, scope_of(&root), &path))
    })();
    done(&host, "draft_read", r)
}

/// `draftDrop(path, {ifRev})` (**A**): only a draft at that edit or before it goes.
#[tauri::command]
#[specta::specta]
pub async fn draft_drop(window: WebviewWindow, host: State<'_, Host>, path: String, opts: Option<DraftDropOpts>) -> HostResult<Dropped> {
    trace(&host, "draft_drop");
    let r = (|| {
        let o = opts.unwrap_or_default();
        let (root, _) = draft_scope(&win_of(&window, &host), &path, o.epoch)?;
        let Some(data) = host.data_dir() else { return Ok(Dropped { dropped: false }) };
        typed(m(drafts::drop_in(&data, scope_of(&root), &path, o.if_rev))?)
    })();
    done(&host, "draft_drop", r)
}

// ---- versions ------------------------------------------------------------------

/// The versions are the vault's (kept in the app's data folder): an outside file has none.
fn no_versions(path: &str) -> HostResult<()> {
    if outside::is_abs(path) {
        return Err(HostError::Unsupported(format!("an outside file keeps no versions: {path}")));
    }
    Ok(())
}

/// `versionKeep(path, text, {force, reason})`.
#[tauri::command]
#[specta::specta]
pub async fn version_keep(window: WebviewWindow, host: State<'_, Host>, path: String, text: String, opts: Option<KeepOpts>) -> HostResult<Kept> {
    trace(&host, "version_keep");
    let r = (|| {
        no_versions(&path)?;
        let o = opts.unwrap_or_default();
        let root = root_for(&win_of(&window, &host), &path, o.epoch)?;
        let reason = match o.reason.as_deref() {
            None => versions::Reason::Save,
            Some(r) => versions::Reason::parse(r).ok_or_else(|| HostError::BadArg(format!("not a version reason: {r}")))?,
        };
        typed(m(versions::keep(&root, &path, text.as_bytes(), o.force.unwrap_or(false), reason))?)
    })();
    done(&host, "version_keep", r)
}

/// `versionList(path)`: newest first.
#[tauri::command]
#[specta::specta]
pub async fn version_list(window: WebviewWindow, host: State<'_, Host>, path: String) -> HostResult<Vec<VersionInfo>> {
    trace(&host, "version_list");
    let r = (|| {
        no_versions(&path)?;
        let root = root_for(&win_of(&window, &host), &path, None)?;
        typed(m(versions::list(&root, &path))?)
    })();
    done(&host, "version_list", r)
}

/// `versionRead(path, id)`: the text, or `null` when there is no such version.
#[tauri::command]
#[specta::specta]
pub async fn version_read(window: WebviewWindow, host: State<'_, Host>, path: String, id: String) -> HostResult<Option<String>> {
    trace(&host, "version_read");
    let r = (|| {
        no_versions(&path)?;
        let root = root_for(&win_of(&window, &host), &path, None)?;
        match m(versions::read(&root, &path, &id)) {
            Ok(t) => Ok(Some(t)),
            Err(HostError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    })();
    done(&host, "version_read", r)
}

/// `versionRestore(path, id, opts)`.
#[tauri::command]
#[specta::specta]
pub async fn version_restore(window: WebviewWindow, host: State<'_, Host>, path: String, id: String, opts: Option<EpochOpts>) -> HostResult<RestoredVersion> {
    trace(&host, "version_restore");
    let r = (|| {
        no_versions(&path)?;
        let root = root_for(&win_of(&window, &host), &path, ep(&opts))?;
        typed(m(versions::restore(&root, &path, &id))?)
    })();
    done(&host, "version_restore", r)
}

// ---- state ---------------------------------------------------------------------

/// `getState()`: the vault's state, kept on this machine outside the vault.
#[tauri::command]
#[specta::specta]
pub async fn get_state(window: WebviewWindow, host: State<'_, Host>) -> HostResult<Json> {
    trace(&host, "get_state");
    let r = m(win_of(&window, &host).require_root()).map(|root| Json(state::get(&root)));
    done(&host, "get_state", r)
}

/// `setState(state, opts)`: the whole object.
#[tauri::command]
#[specta::specta]
pub async fn set_state(window: WebviewWindow, host: State<'_, Host>, state: Json, opts: Option<EpochOpts>) -> HostResult<()> {
    trace(&host, "set_state");
    let r = m(win_of(&window, &host).require_root_at(ep(&opts))).and_then(|root| m(state::set(&root, &state.0)));
    done(&host, "set_state", r)
}

fn local_file(host: &Host, win: &Win, scope: LocalScope, epoch: Option<u64>) -> HostResult<Option<PathBuf>> {
    let config = host.config_dir();
    Ok(match scope {
        LocalScope::App => config.as_deref().map(local::app_file),
        LocalScope::Vault => {
            // The vault scope needs a vault; a write names its epoch, so a late write from a page
            // of the vault that was just left never lands in the new one's file.
            let root = m(win.require_root_at(epoch))?;
            config.as_deref().map(|c| local::vault_file(c, &root))
        }
    })
}

/// `localGet(scope)`: this machine's object for the app or for this window's vault.
#[tauri::command]
#[specta::specta]
pub async fn local_get(window: WebviewWindow, host: State<'_, Host>, scope: LocalScope) -> HostResult<Json> {
    trace(&host, "local_get");
    let r = local_file(&host, &win_of(&window, &host), scope, None)
        .map(|f| Json(f.map(|f| local::get(&f, matches!(scope, LocalScope::App))).unwrap_or_else(|| serde_json::json!({}))));
    done(&host, "local_get", r)
}

/// `localSet(scope, value, opts)`: the whole object, at most 1 MB.
#[tauri::command]
#[specta::specta]
pub async fn local_set(window: WebviewWindow, host: State<'_, Host>, scope: LocalScope, value: Json, opts: Option<EpochOpts>) -> HostResult<()> {
    trace(&host, "local_set");
    let r = (|| {
        let file = local_file(&host, &win_of(&window, &host), scope, ep(&opts))?
            .ok_or_else(|| HostError::Io("this machine has no app config folder".into()))?;
        m(local::set(&file, &value.0, matches!(scope, LocalScope::App)))
    })();
    done(&host, "local_set", r)
}

// ---- platform ------------------------------------------------------------------

/// `openExternal(url)`: http, https and mailto only.
#[tauri::command]
#[specta::specta]
pub async fn open_external(host: State<'_, Host>, url: String) -> HostResult<()> {
    trace(&host, "open_external");
    done(&host, "open_external", m(platform::open_external(&url)))
}

/// The resolved path of a **A** path for the platform commands.
fn full_of(win: &Win, path: &str) -> HostResult<PathBuf> {
    match place(win, path, None)? {
        Place::Vault { root } => m(vault::resolve(&root, path)),
        Place::Outside { full } => Ok(full),
    }
}

/// `openPath(path)` (**A**): in the default application; an executable is revealed instead.
#[tauri::command]
#[specta::specta]
pub async fn open_path(window: WebviewWindow, host: State<'_, Host>, path: String) -> HostResult<()> {
    trace(&host, "open_path");
    let r = full_of(&win_of(&window, &host), &path).and_then(|full| m(platform::open_path(&full, &path)));
    done(&host, "open_path", r)
}

/// `reveal(path)` (**A**): selected in the file manager.
#[tauri::command]
#[specta::specta]
pub async fn reveal(window: WebviewWindow, host: State<'_, Host>, path: String) -> HostResult<()> {
    trace(&host, "reveal");
    let r = full_of(&win_of(&window, &host), &path).and_then(|full| m(platform::reveal(&full, &path)));
    done(&host, "reveal", r)
}

/// `printToPdf(path, {name, folder})`: the page as a PDF; with no path the host asks where.
#[tauri::command]
#[specta::specta]
pub async fn print_to_pdf(window: WebviewWindow, host: State<'_, Host>, path: Option<String>, opts: Option<PdfOpts>) -> HostResult<PdfOutcome> {
    trace(&host, "print_to_pdf");
    let o = opts.unwrap_or_default();
    let root = win_of(&window, &host).root();
    let r = print::to_pdf(&host, window.app_handle(), &window, root, path, o.name, o.folder).await;
    done(&host, "print_to_pdf", m(r).and_then(typed))
}

/// `showPrintUI()`: the system print dialog; returns at once. (The Rust name spells the last
/// two letters apart so the JS name is `showPrintUI`, the name the page has always called.)
#[tauri::command]
#[specta::specta]
pub async fn show_print_u_i(window: WebviewWindow, host: State<'_, Host>) -> HostResult<Shown> {
    trace(&host, "show_print_ui");
    done(&host, "show_print_ui", m(print::show_print_ui(&host, &window)).and_then(typed))
}

// ---- outside files and OS opens ----------------------------------------------

/// `outsideOpen(path)`: a native absolute path or `abs:`. Inside this window's vault it answers
/// the vault path and registers nothing; anywhere else the file is registered for this window
/// (reads, saves, drafts, its folder's media and a watch) and answered as `abs:`. Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn outside_open(window: WebviewWindow, host: State<'_, Host>, path: String) -> HostResult<OutsideFile> {
    trace(&host, "outside_open");
    let r = (|| {
        let full = m(outside::native(&path))?;
        let win = win_of(&window, &host);
        let meta = std::fs::metadata(&full).ok();
        let kind = meta.as_ref().map(|m| if m.is_dir() { "dir".to_string() } else { "file".to_string() });
        let name = vault::nfc(full.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        if let Some(rel) = win.root().and_then(|root| windows::inside(&root, &full)).filter(|r| !r.is_empty()) {
            return Ok(OutsideFile { path: rel, inside: true, name, exists: meta.is_some(), kind });
        }
        if meta.as_ref().is_some_and(|m| m.is_dir()) {
            return Err(HostError::BadArg(format!("a folder is not a file to open: {}", full.display())));
        }
        win.outside.register(window.app_handle(), &win.label, &full);
        Ok(OutsideFile { path: outside::js_path(&full), inside: false, name, exists: meta.is_some(), kind })
    })();
    done(&host, "outside_open", r)
}

/// `takeOpens()`: the OS opens queued for this window, emptied. From now on an open is the
/// `open` event.
#[tauri::command]
#[specta::specta]
pub async fn take_opens(window: WebviewWindow, host: State<'_, Host>) -> HostResult<Vec<OpenRequest>> {
    trace(&host, "take_opens");
    Ok(win_of(&window, &host).take_opens())
}

/// `pickFile({title})`: the native open-file dialog; a native absolute path, or `null`.
#[tauri::command]
#[specta::specta]
pub async fn pick_file(window: WebviewWindow, host: State<'_, Host>, opts: Option<PickFileOpts>) -> HostResult<Option<String>> {
    trace(&host, "pick_file");
    let r = async {
        let picker = host.file_picker.ok_or_else(|| HostError::Unsupported("this build has no file dialog".into()))?;
        let title = opts.and_then(|o| o.title).unwrap_or_else(|| "Open file".to_string());
        let (tx, mut rx) = tauri::async_runtime::channel::<Option<PathBuf>>(1);
        picker(
            window.app_handle(),
            Some(window.clone()),
            title,
            Box::new(move |picked| {
                let _ = tx.try_send(picked);
            }),
        );
        Ok(rx.recv().await.flatten().map(|p| vault::normalize(&p).to_string_lossy().to_string()))
    }
    .await;
    done(&host, "pick_file", r)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("ose-cmd-{tag}-{stamp}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// X7: an `abs:` path is refused until this window registered it, and then reads and saves
    /// go to that file and to no other; a command that takes no outside file refuses it.
    #[test]
    fn an_outside_path_needs_the_window_s_registration() {
        let base = tmp("abs");
        let vault_dir = base.join("vault");
        let loose = base.join("loose");
        std::fs::create_dir_all(&vault_dir).unwrap();
        std::fs::create_dir_all(&loose).unwrap();
        std::fs::write(loose.join("todo.md"), "one\n").unwrap();
        let win = Win::new("main", Some(crate::Root { path: vault_dir.clone(), source: Source::Arg }));
        let js = outside::js_path(&loose.join("todo.md"));

        // Not registered: refused, whatever the command.
        assert!(matches!(place(&win, &js, None), Err(HostError::NotRegistered(_))));
        // A command that takes vault paths only: `escapes_vault`, registered or not.
        assert!(matches!(root_for(&win, &js, None), Err(HostError::EscapesVault(_))));

        win.outside.register_quiet(&loose.join("todo.md"));
        let Ok(Place::Outside { full }) = place(&win, &js, None) else { panic!("an outside place") };
        assert_eq!(full, vault::normalize(&loose.join("todo.md")));
        let r = m(files::read_file_at(&full, &js, None)).unwrap();
        let hash = r["hash"].as_str().unwrap().to_string();
        let req = SaveReq { root: None, full: full.clone(), rel: &js, text: "two\n", expected: Some(&hash), keep: Keep::None, encoding: None, convert: false };
        let out: SaveOutcome = typed(m(files::save(&req, &|_| {})).unwrap()).unwrap();
        assert!(matches!(out, SaveOutcome::Saved { .. }));
        assert_eq!(std::fs::read_to_string(loose.join("todo.md")).unwrap(), "two\n");
        // Another file in the same folder is still not this window's.
        let other = outside::js_path(&loose.join("other.md"));
        assert!(matches!(place(&win, &other, None), Err(HostError::NotRegistered(_))));
        // The versions of an outside file are refused, not faked.
        assert!(matches!(no_versions(&js), Err(HostError::Unsupported(_))));
        // A vault path still goes to the vault, with the epoch checked.
        assert!(matches!(place(&win, "a.md", Some(1)), Ok(Place::Vault { .. })));
        assert!(matches!(place(&win, "a.md", Some(7)), Err(HostError::StaleVault(_))));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The answers the module functions build read as the typed shapes the bindings promise.
    #[test]
    fn module_answers_fit_their_types() {
        let base = tmp("typed");
        std::fs::write(base.join("a.md"), "\u{feff}# a\n").unwrap();
        let r: ReadFile = typed(m(files::read_file(&base, "a.md")).unwrap()).unwrap();
        assert_eq!((r.encoding.as_str(), r.bom, r.lossy), ("UTF-8", true, false));
        let s: Stat = typed(m(vault::stat(&base, "a.md", true)).unwrap()).unwrap();
        assert_eq!(s.text, Some(true));
        let s: Stat = typed(m(vault::stat(&base, "gone.md", false)).unwrap()).unwrap();
        assert!(!s.exists && s.kind.is_none());
        let c: SaveOutcome = typed(serde_json::json!({ "status": "conflict", "disk": { "exists": false, "text": null, "hash": null } })).unwrap();
        assert!(matches!(c, SaveOutcome::Conflict { .. }));
        let found: SearchResult = typed(vault::search(&base, "a", 10, None, false)).unwrap();
        assert_eq!(found.files, 1);
        let restored: Restored = typed(serde_json::json!({ "restored": [], "failed": [{ "id": "x", "error": "[bad_arg] no" }] })).unwrap();
        assert_eq!(restored.failed.len(), 1);
        // `expectedHash` is required: present and null, or a string.
        assert!(serde_json::from_value::<SaveOpts>(serde_json::json!({})).is_err());
        let o: SaveOpts = serde_json::from_value(serde_json::json!({ "expectedHash": null })).unwrap();
        assert!(o.expected_hash.is_none());
        let o: SaveOpts = serde_json::from_value(serde_json::json!({ "expectedHash": "ab", "encoding": "windows-1252", "epoch": 3 })).unwrap();
        assert_eq!((o.expected_hash.as_deref(), o.encoding.as_deref(), o.epoch), (Some("ab"), Some("windows-1252"), Some(3)));
        // A draft's mode is one of the three.
        let d: Draft = serde_json::from_value(serde_json::json!({ "text": "x", "baselineHash": null, "mode": "live" })).unwrap();
        assert!(matches!(d.mode, EditorMode::Live) && d.exact);
        assert!(serde_json::from_value::<Draft>(serde_json::json!({ "text": "x", "baselineHash": null, "mode": "wysiwyg" })).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Every module function that comes through `typed()` (the compatibility layer), run for
    /// real, read as the struct its command answers: each branch of the save path, the files,
    /// the drafts, the versions, the trash and the copies. A shape the compiler cannot check
    /// is checked here, over the same output the exe would send.
    #[test]
    fn every_module_answer_that_goes_through_typed_fits() {
        let base = tmp("typed-all");
        let root = base.join("vault");
        let data = base.join("data");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let quiet = |_: &str| {};

        // The save path: created, saved, unchanged, conflict.
        let req = |text: &'static str, expected: Option<String>| (text, expected);
        let save = |(text, expected): (&str, Option<String>)| -> SaveOutcome {
            let full = root.join("notes/a.md");
            let r = SaveReq { root: Some(&root), full, rel: "notes/a.md", text, expected: expected.as_deref(), keep: Keep::Save, encoding: None, convert: false };
            typed(m(files::save(&r, &quiet)).unwrap()).unwrap()
        };
        let SaveOutcome::Saved { hash, unchanged: None, .. } = save(req("one\n", None)) else { panic!("created") };
        let SaveOutcome::Saved { hash, .. } = save(req("two\n", Some(hash))) else { panic!("saved") };
        let SaveOutcome::Saved { unchanged: Some(true), .. } = save(req("two\n", Some(hash.clone()))) else { panic!("unchanged") };
        let SaveOutcome::Conflict { disk } = save(req("three\n", Some("0".into()))) else { panic!("conflict") };
        assert_eq!((disk.exists, disk.text.as_deref(), disk.hash.as_deref()), (true, Some("two\n"), Some(hash.as_str())));
        let r: ReadFile = typed(m(files::read_file_at(&root.join("notes/a.md"), "notes/a.md", None)).unwrap()).unwrap();
        assert_eq!(r.hash, hash);

        // Creates, copies, lines.
        let c: Created = typed(m(files::create_new(&root, "notes/b.md", "b\n")).unwrap()).unwrap();
        assert_eq!(c.path, "notes/b.md");
        let c: Created = typed(m(files::create_new_binary(&root, "img/x.png", "AAEC")).unwrap()).unwrap();
        assert_eq!(c.path, "img/x.png");
        let c: Created = typed(m(files::copy_file(&root, "notes/b.md", "notes/c.md")).unwrap()).unwrap();
        assert_eq!(c.path, "notes/c.md");
        std::fs::write(base.join("loose.md"), "loose\n").unwrap();
        let c: Created = typed(m(files::import_outside(&root, &base.join("loose.md"), "notes/loose.md")).unwrap()).unwrap();
        assert_eq!(c.path, "notes/loose.md");
        let h: Hashed = typed(m(files::append_line(&root, "notes/b.md", "- [ ] x")).unwrap()).unwrap();
        assert!(!h.hash.is_empty());
        let r: ReplaceOutcome = typed(m(files::replace_line(&root, "notes/b.md", 1, "- [ ] x", "- [x] x", &quiet)).unwrap()).unwrap();
        assert!(matches!(r, ReplaceOutcome::Replaced { .. }));
        let r: ReplaceOutcome = typed(m(files::replace_line(&root, "notes/b.md", 1, "- [ ] x", "- [x] y", &quiet)).unwrap()).unwrap();
        assert!(matches!(r, ReplaceOutcome::Conflict { actual: Some(ref a) } if a == "- [x] x"), "{r:?}");
        let r: ReplaceOutcome = typed(m(files::replace_line(&root, "notes/b.md", 9, "", "x", &quiet)).unwrap()).unwrap();
        assert!(matches!(r, ReplaceOutcome::Conflict { actual: None }), "{r:?}");
        let c: Copied = typed(m(vault::copy_path(&root, "notes", "notes-copy")).unwrap()).unwrap();
        assert_eq!(c.path, "notes-copy");
        let s: Stat = typed(vault::stat_outside(&base.join("loose.md"), true)).unwrap();
        assert!(s.exists);

        // Drafts, both scopes.
        let draft = Draft { text: "typed".into(), baseline_hash: Some(hash.clone()), mode: EditorMode::Live, exact: true, rev: 3.0, at: None, path: None };
        let value = serde_json::to_value(&draft).unwrap();
        let at: DraftAt = typed(m(drafts::write_in(&data, Scope::Vault(&root), "notes/a.md", &value, 42)).unwrap()).unwrap();
        assert_eq!(at.at, 42);
        let outside = outside::js_path(&base.join("loose.md"));
        let _: DraftAt = typed(m(drafts::write_in(&data, Scope::Outside, &outside, &value, 43)).unwrap()).unwrap();
        let list: Vec<DraftInfo> = typed_rows(drafts::list_in(&data, &[Scope::Vault(&root), Scope::Outside]), &quiet).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].at, list[1].path.as_str(), list[1].bytes), (43, "notes/a.md", 5));
        let read: Option<Draft> = typed(drafts::read_in(&data, Scope::Vault(&root), "notes/a.md")).unwrap();
        assert_eq!(read.map(|d| (d.text, d.rev)), Some(("typed".to_string(), 3.0)));
        let none: Option<Draft> = typed(drafts::read_in(&data, Scope::Vault(&root), "notes/none.md")).unwrap();
        assert!(none.is_none());
        let d: Dropped = typed(m(drafts::drop_in(&data, Scope::Vault(&root), "notes/a.md", Some(2.0))).unwrap()).unwrap();
        assert!(!d.dropped, "a newer draft stays");
        let d: Dropped = typed(m(drafts::drop_in(&data, Scope::Vault(&root), "notes/a.md", None)).unwrap()).unwrap();
        assert!(d.dropped);

        // Versions.
        let k: Kept = typed(m(versions::keep(&root, "notes/a.md", b"old\n", true, versions::Reason::Save)).unwrap()).unwrap();
        assert!(k.kept);
        let list: Vec<VersionInfo> = typed(m(versions::list(&root, "notes/a.md")).unwrap()).unwrap();
        let id = list.first().map(|v| v.id.clone()).expect("a version");
        let back: RestoredVersion = typed(m(versions::restore(&root, "notes/a.md", &id)).unwrap()).unwrap();
        assert_eq!(std::fs::read(root.join("notes/a.md")).unwrap(), b"old\n");
        assert!(!back.hash.is_empty());

        // The vault's own trash (the system bin is not touched by a test).
        let w: TrashPlace = typed(m(trashbin::trash_where(&root, "notes/c.md", Some("vault"))).unwrap()).unwrap();
        assert_eq!(w.place, "vault");
        let t: Trashed = typed(m(trashbin::trash(&root, "notes/c.md", "vault")).unwrap()).unwrap();
        let items: Vec<TrashItem> = typed(m(trashbin::trash_list(&root)).unwrap()).unwrap();
        assert!(items.iter().any(|i| i.original == "notes/c.md"), "{items:?}");
        let ids: Vec<String> = t.id.into_iter().collect();
        let r: Restored = typed(m(trashbin::trash_restore(&root, &ids)).unwrap()).unwrap();
        assert_eq!((r.restored.len(), r.failed.len()), (1, 0));

        // The recent vaults, from a list already read.
        let rows: Vec<RecentVault> = typed(vaults::rows_value(vec![root.clone()], Some(&root))).unwrap();
        assert!(rows[0].current && rows[0].exists);

        // A draft record that does not fit is left out of the list, not the list's failure.
        let odd = serde_json::json!([{ "path": "ok.md", "baselineHash": null, "mode": "rich", "exact": true, "rev": 0, "at": 1, "bytes": 0 }, { "path": "odd.md", "mode": 7 }]);
        let dropped = std::cell::RefCell::new(Vec::new());
        let rows: Vec<DraftInfo> = typed_rows(odd, &|s| dropped.borrow_mut().push(s.to_string())).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(dropped.borrow()[0].contains("odd.md"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
