//! Windows (docs/HOST.md "Windows", D14): one window per vault, and everything a window owns.
//!
//! `Host` is what Tauri manages: the windows by label, the opens that arrived before the app
//! was ready, the per-machine folders, the log and the native dialogs. `Win` is one window:
//! its vault root and epoch, its watcher, the outside files it opened, the opens queued for it,
//! and when it last had the focus.
//!
//! The rules:
//!
//! 1. At most one window per vault root, compared with `vaults::same`. A window may have no vault
//!    (the chooser).
//! 2. Labels are `main`, then `w2`, `w3` and so on. `build` creates every window, with the same
//!    options (native decorations, 480 by 360 at the least, drag and drop left to HTML5).
//! 3. Every command finds its `Win` from the window that invoked it; epochs are per window.
//! 4. `main` keeps its geometry in `local/app.json`; any other window in its vault's local store.
//!    A new window with nothing saved opens 32 px down and right of the focused one.
//! 5. A window closes through its own save path (the adapter's `closing` handshake). The app
//!    exits once no window is left.
//!
//! `route` decides where an OS open goes, and is a pure function so it is tested on every
//! platform.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use tauri::{Emitter as _, Manager as _};

use crate::{log_line, outside, state, vault, vaults, watcher, FileSaver, FilePicker, FolderPicker, Root, Source};

/// The label of the first window.
pub const MAIN: &str = "main";
/// How far a new window with no saved geometry sits from the focused one, in logical pixels.
const CASCADE: f64 = 32.0;
/// The smallest a window may be made (L13).
pub const MIN_WIDTH: f64 = 480.0;
pub const MIN_HEIGHT: f64 = 360.0;

/// One OS open for a window: a vault path, or `abs:` for a file outside every vault.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// A vault path, or `abs:<absolute path>` for a file outside the vault.
    pub path: String,
    pub outside: bool,
    pub kind: OpenKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub line: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum OpenKind {
    File,
    Dir,
}

/// The payload of the `open` event.
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct OpenEvent {
    pub requests: Vec<OpenRequest>,
}

// ---- one window ------------------------------------------------------------

/// Everything one window owns.
pub struct Win {
    pub label: String,
    root: RwLock<Option<Root>>,
    /// Which vault this window's page is talking about (docs/HOST.md "Epoch"). 1 when the window
    /// is made, one more on every vault it adopts. A mutating command naming another epoch is
    /// refused with `[stale_vault]`, so the last save of a page from the vault that was just
    /// left can never land in the one that replaced it.
    epoch: AtomicU64,
    watcher: Mutex<Option<watcher::Handle>>,
    /// The files outside every vault this window opened (outside.rs).
    pub outside: outside::Outside,
    /// OS opens waiting for the page (`takeOpens`).
    opens: Mutex<Vec<OpenRequest>>,
    /// Set once the page has asked for its opens: from then on an open is the `open` event.
    took: AtomicBool,
    /// When the window last had the focus, on `Host`'s clock (bigger is later).
    focused_at: AtomicU64,
    /// The last geometry while neither maximised nor minimised (Tauri reports the maximised
    /// rectangle while maximised, so this is what is written).
    pub last_normal: Mutex<Option<state::Bounds>>,
}

impl Win {
    pub fn new(label: &str, root: Option<Root>) -> Self {
        Self {
            label: label.to_string(),
            root: RwLock::new(root),
            epoch: AtomicU64::new(1),
            watcher: Mutex::new(None),
            outside: outside::Outside::default(),
            opens: Mutex::new(Vec::new()),
            took: AtomicBool::new(false),
            focused_at: AtomicU64::new(0),
            last_normal: Mutex::new(None),
        }
    }

    /// The open root's path, if any. Read at call time, never cached by a caller.
    pub fn root(&self) -> Option<PathBuf> {
        self.root_info().map(|r| r.path)
    }

    pub fn root_info(&self) -> Option<Root> {
        self.root.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The open root, or the one error every file command shares.
    pub fn require_root(&self) -> Result<PathBuf, String> {
        self.root().ok_or_else(|| crate::NO_VAULT.to_string())
    }

    /// The open root, for a command that said which epoch it belongs to. `None` is a caller that
    /// did not say (every read) and is let through. The root and the epoch are read under one
    /// lock, so a command can never pair the new root with the old epoch.
    pub fn require_root_at(&self, epoch: Option<u64>) -> Result<PathBuf, String> {
        let guard = self.root.read().unwrap_or_else(|p| p.into_inner());
        if let Some(asked) = epoch {
            let now = self.epoch.load(Ordering::SeqCst);
            if asked != now {
                return Err(crate::coded(
                    "stale_vault",
                    format!("this page belongs to vault epoch {asked}, this window's vault is epoch {now}"),
                ));
            }
        }
        guard.as_ref().map(|r| r.path.clone()).ok_or_else(|| crate::NO_VAULT.to_string())
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// A vault adopted while the window runs: the root changes and the epoch goes up by one,
    /// both under the write lock.
    pub fn adopt_root(&self, path: PathBuf, source: Source) -> u64 {
        let mut guard = self.root.write().unwrap_or_else(|p| p.into_inner());
        let next = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        *guard = Some(Root { path, source });
        next
    }

    /// (Re)starts the watcher on `root`, its events for this window only. Dropping the previous
    /// handle stops its thread.
    pub fn watch(&self, app: &tauri::AppHandle, root: PathBuf) {
        let started = watcher::start(app.clone(), self.label.clone(), root);
        *self.watcher.lock().unwrap_or_else(|p| p.into_inner()) = Some(started);
    }

    /// Stops every watcher of this window: the vault's and the outside folders'.
    pub fn stop(&self) {
        *self.watcher.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.outside.clear();
    }

    /// An open for this window: queued while the page has not asked for its opens yet, the
    /// `open` event once it has. Answers whether it was sent as an event.
    pub fn deliver(&self, app: &tauri::AppHandle, request: OpenRequest) -> bool {
        if !self.took.load(Ordering::SeqCst) {
            self.opens.lock().unwrap_or_else(|p| p.into_inner()).push(request);
            return false;
        }
        let payload = OpenEvent { requests: vec![request] };
        if let Err(e) = app.emit_to(tauri::EventTarget::webview_window(&self.label), "open", payload) {
            log::warn!("open event to {} dropped: {e}", self.label);
        }
        true
    }

    /// `takeOpens()`: what was queued, emptied. From now on an open is the `open` event.
    pub fn take_opens(&self) -> Vec<OpenRequest> {
        let mut q = self.opens.lock().unwrap_or_else(|p| p.into_inner());
        self.took.store(true, Ordering::SeqCst);
        std::mem::take(&mut *q)
    }

    pub fn focused_at(&self) -> u64 {
        self.focused_at.load(Ordering::SeqCst)
    }
}

// ---- the host --------------------------------------------------------------

/// Everything the host owns, managed by Tauri and reachable from any command or thread.
pub struct Host {
    windows: RwLock<HashMap<String, Arc<Win>>>,
    /// Paths the OS asked to open before the app was ready (`RunEvent::Opened` can come before
    /// `setup` on macOS). `setup` routes them once the first window exists.
    pending: Mutex<Vec<PathBuf>>,
    ready: AtomicBool,
    /// The next number a window label takes (`w2`, `w3`, …).
    next: AtomicU64,
    /// The focus clock: every focus takes the next tick.
    clock: AtomicU64,
    data_dir: RwLock<Option<PathBuf>>,
    config_dir: RwLock<Option<PathBuf>>,
    drag_icon: RwLock<Option<PathBuf>>,
    pub log: Option<Mutex<File>>,
    pub picker: Option<FolderPicker>,
    pub saver: Option<FileSaver>,
    pub file_picker: Option<FilePicker>,
}

impl Host {
    pub fn new(
        log: Option<File>,
        picker: Option<FolderPicker>,
        saver: Option<FileSaver>,
        file_picker: Option<FilePicker>,
    ) -> Self {
        Self {
            windows: RwLock::new(HashMap::new()),
            pending: Mutex::new(Vec::new()),
            ready: AtomicBool::new(false),
            next: AtomicU64::new(2),
            clock: AtomicU64::new(1),
            data_dir: RwLock::new(None),
            config_dir: RwLock::new(None),
            drag_icon: RwLock::new(None),
            log: log.map(Mutex::new),
            picker,
            saver,
            file_picker,
        }
    }

    /// The window `label`, made (with no vault) when the host has not seen it yet.
    pub fn win(&self, label: &str) -> Arc<Win> {
        if let Some(w) = self.get(label) {
            return w;
        }
        let mut map = self.windows.write().unwrap_or_else(|p| p.into_inner());
        Arc::clone(map.entry(label.to_string()).or_insert_with(|| Arc::new(Win::new(label, None))))
    }

    pub fn get(&self, label: &str) -> Option<Arc<Win>> {
        self.windows.read().unwrap_or_else(|p| p.into_inner()).get(label).cloned()
    }

    /// Registers a window made by `build`.
    pub fn insert(&self, win: Win) -> Arc<Win> {
        let win = Arc::new(win);
        self.windows
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(win.label.clone(), Arc::clone(&win));
        win
    }

    /// Forgets a window that is gone, stopping its watchers.
    pub fn remove(&self, label: &str) -> Option<Arc<Win>> {
        let win = self.windows.write().unwrap_or_else(|p| p.into_inner()).remove(label);
        if let Some(w) = &win {
            w.stop();
        }
        win
    }

    pub fn all(&self) -> Vec<Arc<Win>> {
        let mut v: Vec<Arc<Win>> = self.windows.read().unwrap_or_else(|p| p.into_inner()).values().cloned().collect();
        v.sort_by(|a, b| a.label.cmp(&b.label));
        v
    }

    pub fn is_empty(&self) -> bool {
        self.windows.read().unwrap_or_else(|p| p.into_inner()).is_empty()
    }

    /// The window whose vault is `root`, if any (rule 1).
    pub fn window_of_root(&self, root: &Path) -> Option<Arc<Win>> {
        self.all().into_iter().find(|w| w.root().is_some_and(|r| vaults::same(&r, root)))
    }

    /// The label the next window takes.
    pub fn next_label(&self) -> String {
        format!("w{}", self.next.fetch_add(1, Ordering::SeqCst))
    }

    /// `label` had the focus just now.
    pub fn touch(&self, label: &str) {
        let t = self.clock.fetch_add(1, Ordering::SeqCst);
        if let Some(w) = self.get(label) {
            w.focused_at.store(t, Ordering::SeqCst);
        }
    }

    /// The window that had the focus last, `main` first when none ever had it.
    pub fn most_recent(&self) -> Option<Arc<Win>> {
        let all = self.all();
        all.iter()
            .max_by_key(|w| (w.focused_at(), u8::from(w.label == MAIN)))
            .cloned()
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// The first window exists: queued opens can be routed. Answers them, emptied.
    pub fn set_ready(&self) -> Vec<PathBuf> {
        let mut q = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        self.ready.store(true, Ordering::SeqCst);
        std::mem::take(&mut *q)
    }

    /// An OS open that arrived before the app was ready.
    pub fn queue_pending(&self, path: PathBuf) {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).push(path);
    }

    /// The per-machine app data folder (drafts, the drag icon), when the app has told us.
    pub fn data_dir(&self) -> Option<PathBuf> {
        self.data_dir.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_data_dir(&self, dir: PathBuf) {
        *self.data_dir.write().unwrap_or_else(|p| p.into_inner()) = Some(dir);
    }

    /// The per-user app config folder: the remembered root, the recent vaults and the local
    /// store live under it.
    pub fn config_dir(&self) -> Option<PathBuf> {
        self.config_dir.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_config_dir(&self, dir: PathBuf) {
        *self.config_dir.write().unwrap_or_else(|p| p.into_inner()) = Some(dir);
    }

    pub fn drag_icon(&self) -> Option<PathBuf> {
        self.drag_icon.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_drag_icon(&self, path: PathBuf) {
        *self.drag_icon.write().unwrap_or_else(|p| p.into_inner()) = Some(path);
    }
}

// ---- routing an OS open ----------------------------------------------------

/// A window as `route` sees it.
#[derive(Clone, Debug)]
pub struct WinView {
    pub label: String,
    pub root: Option<PathBuf>,
    pub focused_at: u64,
}

/// Where an OS open goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    /// An existing window, brought forward, and given `request` when there is one.
    Existing { label: String, request: Option<OpenRequest> },
    /// A new window on `root` (`None`: the normal root resolution), given `request`.
    New { root: Option<PathBuf>, request: Option<OpenRequest> },
}

/// `full` relative to `root` with forward slashes, when it is inside it (`vaults::relative`:
/// the one fold, compared by segments). The answer keeps the spelling of `full`.
pub fn inside(root: &Path, full: &Path) -> Option<String> {
    vaults::relative(root, full)
}

/// The vault a folder belongs to when no window holds it: the nearest of itself and its
/// ancestors that holds `.ose/` (`vault_of` looks at the ancestors of what it is given, so it is
/// given a name inside the folder).
pub fn vault_of_folder(dir: &Path, vault_of: &dyn Fn(&Path) -> Option<PathBuf>) -> Option<PathBuf> {
    vault_of(&dir.join("_"))
}

/// Where the absolute path `p` opens (docs/HOST.md "OS opens"):
///
/// 1. a folder: the window whose root it is; else, inside some window's vault, that window, as
///    a folder route (`kind: dir`), never a second window nested in the first; else, inside a
///    vault that has no window (the nearest `.ose/` at or above it), a new window on that vault
///    showing the folder; else a new window on the folder itself;
/// 2. a file inside some window's vault: that window, with the vault path;
/// 3. a file whose nearest ancestor holding `.ose/` is `A` (`vault_of`): the window of `A`,
///    made when there is none, with the path relative to `A`. Only `.ose`, never `CLAUDE.md`:
///    a code repository is not a vault;
/// 4. anything else: the window focused last (or a new one with the normal root when there is
///    none), with `abs:<p>` as an outside file.
///
/// Every comparison is `vaults::fold`, the same one `Host::window_of_root` uses.
pub fn route(p: &Path, is_dir: bool, windows: &[WinView], vault_of: &dyn Fn(&Path) -> Option<PathBuf>) -> Route {
    let window_of = |root: &Path| windows.iter().find(|w| w.root.as_deref().is_some_and(|r| vaults::same(r, root)));
    // The deepest root that holds it: a vault inside another vault's folder is its own.
    let holder = windows
        .iter()
        .filter_map(|w| w.root.as_deref().and_then(|r| inside(r, p).map(|rel| (w, r, rel))))
        .filter(|(_, _, rel)| !rel.is_empty())
        .max_by_key(|(_, r, _)| vaults::fold(r).len());
    if is_dir {
        let folder = |path: String| Some(OpenRequest { path, outside: false, kind: OpenKind::Dir, line: None });
        if let Some(w) = window_of(p) {
            return Route::Existing { label: w.label.clone(), request: None };
        }
        if let Some((w, _, rel)) = holder {
            return Route::Existing { label: w.label.clone(), request: folder(rel) };
        }
        if let Some(a) = vault_of_folder(p, vault_of) {
            if let Some(rel) = inside(&a, p).filter(|r| !r.is_empty()) {
                return Route::New { root: Some(a), request: folder(rel) };
            }
        }
        return Route::New { root: Some(p.to_path_buf()), request: None };
    }
    let file = |path: String| Some(OpenRequest { path, outside: false, kind: OpenKind::File, line: None });
    if let Some((w, _, rel)) = holder {
        return Route::Existing { label: w.label.clone(), request: file(rel) };
    }
    if let Some(a) = vault_of(p) {
        if let Some(rel) = inside(&a, p).filter(|r| !r.is_empty()) {
            return match window_of(&a) {
                Some(w) => Route::Existing { label: w.label.clone(), request: file(rel) },
                None => Route::New { root: Some(a), request: file(rel) },
            };
        }
    }
    let request = Some(OpenRequest { path: outside::js_path(p), outside: true, kind: OpenKind::File, line: None });
    match windows.iter().max_by_key(|w| (w.focused_at, u8::from(w.label == MAIN))) {
        Some(w) => Route::Existing { label: w.label.clone(), request },
        None => Route::New { root: None, request },
    }
}

/// The nearest ancestor of `file` that holds a `.ose` folder (rule 3). A filesystem root (`D:`,
/// `/`) is never taken for a vault: a stray `.ose` at the top of a drive would otherwise turn
/// every loose file on it into a page of a vault the size of the disk.
pub fn ose_vault_of(file: &Path) -> Option<PathBuf> {
    vault_of_with(file, &|a| a.join(".ose").is_dir())
}

/// `ose_vault_of` with the `.ose` check given, for the tests.
pub fn vault_of_with(file: &Path, holds_ose: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    file.ancestors()
        .skip(1)
        .filter(|a| a.parent().is_some())
        .find(|a| holds_ose(a))
        .map(Path::to_path_buf)
}

// ---- building a window -----------------------------------------------------

/// The one builder every window goes through: no system title bar (the page's toolbar is the
/// title bar: its own window buttons on Windows, the traffic lights over it on macOS), the
/// system's shadow and resize edges, at least 480 by 360,
/// invisible until its page has loaded, HTML5 drag and drop (the tree's drag-to-move needs it:
/// Tauri's own drag-drop turns it off in WebView2), and no zoom hotkeys. Registers the window's
/// `Win`, paints the theme's background, puts it where it was, and starts the watcher.
pub fn build(app: &tauri::AppHandle, label: &str, root: Option<Root>) -> Result<tauri::WebviewWindow, String> {
    let host = app.state::<Host>();
    let host = host.inner();
    let win = host.insert(Win::new(label, root.clone()));

    let theme = theme_now(host, root.as_ref().map(|r| r.path.as_path()));
    let (r, g, b) = state::background_of(theme);

    let saved = saved_bounds(host, label, root.as_ref().map(|r| r.path.as_path()));
    let mut builder = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title("Ose")
        .inner_size(1280.0, 800.0)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        .decorations(cfg!(target_os = "macos"))
        .shadow(true)
        .visible(false)
        .background_color(tauri::window::Color(r, g, b, 255))
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(false);
    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    let cascade = saved.is_none() && label != MAIN;
    if saved.is_none() && !cascade {
        builder = builder.center();
    }
    if cascade {
        if let Some((x, y)) = cascade_from(app, host) {
            builder = builder.position(x, y);
        } else {
            builder = builder.center();
        }
    }
    let window = builder.build().map_err(|e| {
        host.remove(label);
        format!("window {label}: {e}")
    })?;
    match &root {
        Some(r) => log_line(host, &format!("window {label}: {} (from {})", r.path.display(), r.source.as_str())),
        None => log_line(host, &format!("window {label}: no vault")),
    }

    if let Some(bounds) = saved {
        place(&window, &win, bounds, host);
    }
    // F5, Ctrl+R and the rest of WebView2's browser keys would reload the page under unsaved
    // work without asking (M53, C5). The page still receives the keys.
    crate::platform::disable_browser_keys(&window);
    if let Some(root) = &root {
        win.watch(app, root.path.clone());
    }
    host.touch(label);

    // A page that never loads must not leave an invisible window behind.
    let anyway = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let _ = anyway.show();
    });
    // The page is the shell inside the executable (`frontendDist`, Tauri's asset protocol, the CSP
    // of tauri.conf.json), or the dev server's under `tauri dev`: the window is already on it.
    log_line(host, if tauri::is_dev() { "shell: the dev server (devUrl)" } else { "shell: the copy inside the executable" });
    Ok(window)
}

/// The theme a new window paints before its page runs: this machine's mirror of the last
/// resolved theme, the vault's old state file on the first launch after the upgrade, else dark.
/// The window's own theme is left unset (M26), so the page sees the system change.
fn theme_now(host: &Host, root: Option<&Path>) -> &'static str {
    host.config_dir()
        .as_deref()
        .and_then(|c| state::theme_of(crate::local::host_get(c, "theme").as_ref()))
        .or_else(|| root.and_then(state::theme))
        .unwrap_or("dark")
}

/// Where `label` was: `main` in `local/app.json`, any other window in its vault's local store,
/// and an older version's bounds in the vault's state as the last fallback for `main`.
fn saved_bounds(host: &Host, label: &str, root: Option<&Path>) -> Option<state::Bounds> {
    let config = host.config_dir();
    if label == MAIN {
        return config
            .as_deref()
            .and_then(|c| crate::local::host_get(c, "window"))
            .and_then(|v| state::bounds_of(&v))
            .or_else(|| root.and_then(state::read_window));
    }
    let (config, root) = (config?, root?);
    crate::local::vault_host_get(&config, root, "window").and_then(|v| state::bounds_of(&v))
}

/// Saved bounds, but only when they still land on a monitor that exists.
fn place(window: &tauri::WebviewWindow, win: &Win, bounds: state::Bounds, host: &Host) {
    let monitors: Vec<state::MonitorRect> = window
        .available_monitors()
        .map(|list| {
            list.iter()
                .map(|m| {
                    let p = m.position();
                    let s = m.size();
                    (p.x, p.y, s.width, s.height)
                })
                .collect()
        })
        .unwrap_or_default();
    if !state::usable(bounds, &monitors) {
        log_line(host, &format!("{}: saved bounds are off-screen, using the default", win.label));
        return;
    }
    let _ = window.set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y));
    let _ = window.set_size(tauri::PhysicalSize::new(bounds.w, bounds.h));
    *win.last_normal.lock().unwrap_or_else(|p| p.into_inner()) = Some(bounds);
    if bounds.maximized {
        let _ = window.maximize();
    }
}

/// 32 px down and right of the window focused last, in logical pixels.
fn cascade_from(app: &tauri::AppHandle, host: &Host) -> Option<(f64, f64)> {
    let w = host.most_recent()?;
    let window = app.get_webview_window(&w.label)?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let pos = window.outer_position().ok()?.to_logical::<f64>(scale);
    Some((pos.x + CASCADE, pos.y + CASCADE))
}

/// Brings a window forward: unminimised, shown, focused.
pub fn raise(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Records the window's geometry where `saved_bounds` reads it.
pub fn save_geometry(app: &tauri::AppHandle, window: &tauri::Window) {
    let host = app.state::<Host>();
    let host = host.inner();
    let Some(config) = host.config_dir() else { return };
    let Some(win) = host.get(window.label()) else { return };
    let bounds = current_bounds(window, &win);
    let written = if win.label == MAIN {
        crate::local::host_set(&config, "window", state::bounds_json(bounds))
    } else {
        match win.root() {
            Some(root) => crate::local::vault_host_set(&config, &root, "window", state::bounds_json(bounds)),
            None => Ok(()),
        }
    };
    if let Err(e) = written {
        log_line(host, &format!("{}: window state save failed: {e}", win.label));
    }
}

/// Remembers the geometry while neither maximised nor minimised.
pub fn remember_bounds(app: &tauri::AppHandle, window: &tauri::Window) {
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let host = app.state::<Host>();
    if let Some(win) = host.get(window.label()) {
        *win.last_normal.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(state::Bounds { x: pos.x, y: pos.y, w: size.width, h: size.height, maximized: false });
    }
}

fn current_bounds(window: &tauri::Window, win: &Win) -> state::Bounds {
    let maximized = window.is_maximized().unwrap_or(false);
    if let Some(bounds) = *win.last_normal.lock().unwrap_or_else(|p| p.into_inner()) {
        return state::Bounds { maximized, ..bounds };
    }
    let (x, y) = window.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
    let (w, h) = window.outer_size().map(|s| (s.width, s.height)).unwrap_or((1280, 800));
    state::Bounds { x, y, w, h, maximized }
}

// ---- delivering an open ----------------------------------------------------

/// Routes and delivers the OS open of `p` (absolute): the window it belongs to is brought
/// forward (made when needed) and given the request. A path that is not there is logged and
/// dropped.
pub fn open_path(app: &tauri::AppHandle, p: &Path) {
    let host = app.state::<Host>();
    let host = host.inner();
    let full = vault::normalize(p);
    let Ok(meta) = std::fs::metadata(&full) else {
        log_line(host, &format!("open: not there: {}", full.display()));
        return;
    };
    let views: Vec<WinView> = host
        .all()
        .iter()
        .map(|w| WinView { label: w.label.clone(), root: w.root(), focused_at: w.focused_at() })
        .collect();
    let target = route(&full, meta.is_dir(), &views, &ose_vault_of);
    log_line(host, &format!("open {}: {target:?}", full.display()));
    deliver(app, target, &full);
}

/// Carries out a `Route`.
pub fn deliver(app: &tauri::AppHandle, target: Route, full: &Path) {
    let host = app.state::<Host>();
    let host = host.inner();
    match target {
        Route::Existing { label, request } => {
            let win = host.win(&label);
            if let Some(req) = request {
                if req.outside {
                    win.outside.register(app, &label, full);
                }
                win.deliver(app, req);
            }
            raise(app, &label);
        }
        Route::New { root, request } => {
            let root = match root {
                Some(path) => Some(Root { path, source: Source::Opened }),
                None => resolve_default_root(app),
            };
            if let Some(r) = &root {
                if let Err(e) = vaults::record(app, &r.path) {
                    log_line(host, &format!("recent vaults: {e}"));
                }
            }
            let label = if host.get(MAIN).is_none() { MAIN.to_string() } else { host.next_label() };
            match build(app, &label, root) {
                Ok(_) => {
                    let win = host.win(&label);
                    if let Some(req) = request {
                        if req.outside {
                            win.outside.register(app, &label, full);
                        }
                        win.deliver(app, req);
                    }
                }
                Err(e) => log_line(host, &format!("open: {e}")),
            }
        }
    }
}

/// The normal root resolution for a window made with no vault named: the executable's folder,
/// the environment, then the remembered root, skipping a vault already open in a window.
pub fn resolve_default_root(app: &tauri::AppHandle) -> Option<Root> {
    let host = app.state::<Host>();
    let free = |p: &Path| host.window_of_root(p).is_none();
    if let Some((path, source)) = vault::resolve_root(None) {
        if free(&path) {
            return Some(Root { path, source });
        }
    }
    vault::read_remembered(app)
        .filter(|p| free(p))
        .map(|path| Root { path, source: Source::Remembered })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(label: &str, root: Option<&str>, focused_at: u64) -> WinView {
        WinView { label: label.into(), root: root.map(PathBuf::from), focused_at }
    }

    fn abs(p: &str) -> String {
        outside::js_path(Path::new(p))
    }

    #[cfg(windows)]
    const A: &str = r"D:\vaults\a";
    #[cfg(not(windows))]
    const A: &str = "/vaults/a";
    #[cfg(windows)]
    const B: &str = r"D:\vaults\b";
    #[cfg(not(windows))]
    const B: &str = "/vaults/b";

    fn join(base: &str, rel: &str) -> PathBuf {
        let mut p = PathBuf::from(base);
        for seg in rel.split('/') {
            p.push(seg);
        }
        p
    }

    fn none(_: &Path) -> Option<PathBuf> {
        None
    }

    #[test]
    fn a_folder_goes_to_its_window_or_a_new_one() {
        let wins = [view("main", Some(A), 1)];
        assert_eq!(route(Path::new(A), true, &wins, &none), Route::Existing { label: "main".into(), request: None });
        assert_eq!(route(Path::new(B), true, &wins, &none), Route::New { root: Some(PathBuf::from(B)), request: None });
        if cfg!(windows) {
            // The same folder in another letter case is the same vault.
            let upper = A.to_uppercase();
            assert_eq!(route(Path::new(&upper), true, &wins, &none), Route::Existing { label: "main".into(), request: None });
        }
    }

    /// A folder inside an open vault is a folder route in that window, never a nested vault
    /// window (which would write `.ose/` into it and split every later open).
    #[test]
    fn a_folder_inside_an_open_vault_is_a_folder_route() {
        let wins = [view("main", Some(A), 1)];
        let r = route(&join(A, "2-learning"), true, &wins, &none);
        assert_eq!(
            r,
            Route::Existing {
                label: "main".into(),
                request: Some(OpenRequest { path: "2-learning".into(), outside: false, kind: OpenKind::Dir, line: None })
            }
        );
        // With no window on its vault, a new window on the vault, showing the folder.
        let vault_b = |p: &Path| if inside(Path::new(B), p).is_some_and(|r| !r.is_empty()) { Some(PathBuf::from(B)) } else { None };
        let r = route(&join(B, "sub"), true, &wins, &vault_b);
        assert_eq!(
            r,
            Route::New {
                root: Some(PathBuf::from(B)),
                request: Some(OpenRequest { path: "sub".into(), outside: false, kind: OpenKind::Dir, line: None })
            }
        );
        // The vault folder itself, with no window, is a new window on it.
        assert_eq!(route(Path::new(B), true, &wins, &vault_b), Route::New { root: Some(PathBuf::from(B)), request: None });
    }

    #[test]
    fn a_file_in_an_open_vault_goes_to_that_window() {
        let wins = [view("main", Some(A), 5), view("w2", Some(B), 9)];
        let r = route(&join(A, "notes/x.md"), false, &wins, &none);
        let Route::Existing { label, request: Some(req) } = r else { panic!("{r:?}") };
        assert_eq!(label, "main");
        assert_eq!(req.path, "notes/x.md");
        assert!(!req.outside);
        assert_eq!(req.kind, OpenKind::File);
    }

    #[test]
    fn a_file_in_another_vault_opens_that_vault() {
        let wins = [view("main", Some(A), 5)];
        let vault_b = |p: &Path| if inside(Path::new(B), p).is_some() { Some(PathBuf::from(B)) } else { None };
        let r = route(&join(B, "sub/y.md"), false, &wins, &vault_b);
        assert_eq!(
            r,
            Route::New {
                root: Some(PathBuf::from(B)),
                request: Some(OpenRequest { path: "sub/y.md".into(), outside: false, kind: OpenKind::File, line: None })
            }
        );
        // Once B has a window, the file goes there.
        let wins = [view("main", Some(A), 5), view("w2", Some(B), 1)];
        let r = route(&join(B, "sub/y.md"), false, &wins, &vault_b);
        assert!(matches!(r, Route::Existing { ref label, .. } if label == "w2"), "{r:?}");
    }

    #[test]
    fn a_plain_file_is_an_outside_tab_in_the_window_focused_last() {
        #[cfg(windows)]
        let file = r"E:\loose\todo.md";
        #[cfg(not(windows))]
        let file = "/loose/todo.md";
        let wins = [view("main", Some(A), 5), view("w2", Some(B), 9)];
        let r = route(Path::new(file), false, &wins, &none);
        let Route::Existing { label, request: Some(req) } = r else { panic!("{r:?}") };
        assert_eq!(label, "w2");
        assert!(req.outside);
        assert_eq!(req.path, abs(file));
        // With no window at all, a new one with the normal root.
        let r = route(Path::new(file), false, &[], &none);
        assert!(matches!(r, Route::New { root: None, request: Some(ref q) } if q.outside), "{r:?}");
    }

    #[test]
    fn inside_folds_case_only_where_the_filesystem_does() {
        let rel = inside(Path::new(A), &join(A, "Notes/X.md"));
        assert_eq!(rel.as_deref(), Some("Notes/X.md"));
        assert_eq!(inside(Path::new(A), Path::new(A)).as_deref(), Some(""));
        // `a2` is not inside `a`.
        let sibling = format!("{A}2");
        assert_eq!(inside(Path::new(A), &join(&sibling, "x.md")), None);
    }

    #[test]
    fn a_drive_root_is_never_a_vault() {
        let file = PathBuf::from(A).join("notes").join("x.md");
        let top = file.ancestors().last().unwrap().to_path_buf();
        // Only the root holds `.ose`: no vault.
        assert_eq!(vault_of_with(&file, &|a| a == top), None);
        // A real vault below it is found, the nearest first.
        assert_eq!(vault_of_with(&file, &|a| a == Path::new(A) || a == top), Some(PathBuf::from(A)));
    }

    #[test]
    fn a_stale_epoch_is_refused() {
        let win = Win::new("main", Some(Root { path: PathBuf::from("/one"), source: Source::Arg }));
        assert_eq!(win.epoch(), 1);
        assert_eq!(win.require_root_at(Some(1)).unwrap(), PathBuf::from("/one"));
        assert_eq!(win.adopt_root(PathBuf::from("/two"), Source::Picked), 2);
        let e = win.require_root_at(Some(1)).unwrap_err();
        assert!(e.starts_with("[stale_vault]"), "{e}");
        assert_eq!(win.require_root_at(Some(2)).unwrap(), PathBuf::from("/two"));
        assert_eq!(win.require_root_at(None).unwrap(), PathBuf::from("/two"));
        // Epochs are per window.
        let other = Win::new("w2", None);
        assert_eq!(other.epoch(), 1);
        assert!(other.require_root_at(None).unwrap_err().starts_with("[no_vault]"));
    }

    #[test]
    fn opens_queue_until_the_page_takes_them() {
        let win = Win::new("main", None);
        let req = OpenRequest { path: "a.md".into(), outside: false, kind: OpenKind::File, line: None };
        win.opens.lock().unwrap().push(req.clone());
        assert_eq!(win.take_opens(), vec![req]);
        assert!(win.take_opens().is_empty(), "emptied");
        assert!(win.took.load(Ordering::SeqCst));
    }

    #[test]
    fn the_focus_clock_picks_the_last_window() {
        let host = Host::new(None, None, None, None);
        host.insert(Win::new("main", None));
        host.insert(Win::new("w2", None));
        assert_eq!(host.most_recent().unwrap().label, "main", "main first when none had the focus");
        host.touch("w2");
        assert_eq!(host.most_recent().unwrap().label, "w2");
        host.touch("main");
        assert_eq!(host.most_recent().unwrap().label, "main");
        assert_eq!(host.next_label(), "w2");
        assert_eq!(host.next_label(), "w3");
    }
}
