// The webview draws the whole window, including the title bar, so the console subsystem is off
// in release: no flash of a terminal behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, WindowEvent};
use tauri_plugin_dialog::DialogExt as _;

use ose::{args, log_line, protocol, state, update, vault, AppState, Root, Source};

/// The last geometry the window had while neither maximised nor minimised. Tauri reports the
/// maximised rectangle while maximised, so this is what gets written to `state.json`.
static LAST_NORMAL: Mutex<Option<state::Bounds>> = Mutex::new(None);

/// `--update`: the page still loads (the webview is the process), but the window is never
/// shown and nothing but the update loop runs.
static HEADLESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

const NO_VAULT_SELFTEST: &str = "os --selftest needs a vault.\n\n\
Pass --root <folder>, set OSE_ROOT, or start it from inside a vault (a folder with .ose/ or CLAUDE.md).";

fn main() {
    let opts = args::parse(std::env::args().skip(1));

    if opts.version {
        // The release binary has no console of its own; borrowing the parent's makes the line
        // land in the terminal that asked.
        attach_parent_console();
        println!("{}", update::version_line());
        std::process::exit(0);
    }

    // A running copy with no window, for the swap test (tests/swap.rs) and nothing else.
    #[cfg(debug_assertions)]
    if let Some(secs) = opts.hold {
        std::thread::sleep(Duration::from_secs(secs));
        std::process::exit(0);
    }

    // Steps 1 to 3 of the resolution order need no app: the argument, the executable's
    // ancestors, the environment. The remembered root (step 4) needs the app's config folder
    // and is read in `setup`; with nothing at all the UI asks (step 5). Only the self-test,
    // which has no UI to ask with, still refuses to start without a root.
    let found = vault::resolve_root(opts.root.as_deref());
    if opts.selftest && found.is_none() {
        fatal(opts.log.as_deref(), NO_VAULT_SELFTEST);
    }

    let root = found.map(|(path, source)| Root { path, source });
    let mut app_state = AppState::new(
        root.clone(),
        opts.log.as_deref().and_then(open_log),
        Some(pick_folder),
    );
    app_state.before_restart = Some(save_for_restart);
    match &root {
        Some(r) => log_line(
            &app_state,
            &format!("os editor starting, vault root: {} (from {})", r.path.display(), r.source.as_str()),
        ),
        None => log_line(&app_state, "os editor starting, no vault yet"),
    }

    let selftest = opts.selftest;
    if opts.update {
        HEADLESS.store(true, std::sync::atomic::Ordering::Relaxed);
        log_line(&app_state, "os --update: headless");
    }
    let headless = opts.update;

    tauri::Builder::default()
        .manage(app_state)
        // The native folder picker behind `pickVault` (`pick_folder` below); used from Rust
        // only, so no capability entry is needed: permissions gate the webview's own invoke,
        // not host code.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![ose::commands::rpc])
        // Read-only access to the vault for <img src> and friends. The root is read per request
        // so a vault picked after startup is served at once.
        .register_uri_scheme_protocol("vault", |ctx, request| {
            let st = ctx.app_handle().state::<AppState>();
            protocol::serve_current(st.inner(), &request)
        })
        // The window starts invisible; the first finished page load is the earliest moment
        // showing it cannot flash an empty frame.
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), PageLoadEvent::Finished)
                && !HEADLESS.load(std::sync::atomic::Ordering::Relaxed)
            {
                let window = webview.window();
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .setup(move |app| setup(app, selftest, headless))
        .on_window_event(on_window_event)
        .run(tauri::generate_context!())
        .expect("os failed to start");
}

/// The `ose::FolderPicker` for this binary: the dialog plugin's native folder picker, parented
/// to the main window, opened in `start`. The plugin hops to the main thread only to create
/// the dialog, runs it on a thread of its own and calls `done` from there, so nothing here
/// blocks the event loop on any platform.
fn pick_folder(app: &tauri::AppHandle, start: Option<PathBuf>, done: Box<dyn FnOnce(Option<PathBuf>) + Send>) {
    let mut dialog = app.dialog().file().set_title("Choose a vault folder");
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_folder(move |picked| {
        done(picked.and_then(|fp| fp.as_path().map(Path::to_path_buf)));
    });
}

fn setup(app: &mut tauri::App, selftest: bool, headless: bool) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let st = app.state::<AppState>();

    // Step 4: the remembered root, now that the app knows its config folder.
    if st.root().is_none() {
        match vault::read_remembered(&handle) {
            Some(path) => {
                log_line(st.inner(), &format!("vault root: {} (from remembered)", path.display()));
                st.set_root(path, Source::Remembered);
            }
            None => log_line(st.inner(), "no vault: the UI will ask for a folder"),
        }
    }
    let root = st.root();

    // This build started, so the one it replaced can go (update.rs `finish_previous`).
    update::finish_previous_in_background(handle.clone());

    // `--update`: no window, no theme, no bounds; the loop runs on its own thread and exits.
    if headless {
        update::run_headless(handle);
        return Ok(());
    }

    let window = app
        .get_webview_window("main")
        .ok_or("the main window is missing from tauri.conf.json")?;

    // Theme first: the background colour has to be right before anything is painted. Without a
    // vault there is no state file, and the dark default from tauri.conf.json stands.
    if let Some(root) = &root {
        let theme = state::theme(root);
        let _ = window.set_theme(Some(if theme == "dark" {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }));
        let (r, g, b) = state::background_of(theme);
        let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
    }

    // Saved bounds, but only if they still land on a monitor that exists.
    if let Some(bounds) = root.as_deref().and_then(state::read_window) {
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
        if state::usable(bounds, &monitors) {
            let _ = window.set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y));
            let _ = window.set_size(tauri::PhysicalSize::new(bounds.w, bounds.h));
            *LAST_NORMAL.lock().unwrap_or_else(|p| p.into_inner()) = Some(bounds);
            if bounds.maximized {
                let _ = window.maximize();
            }
        } else {
            log_line(st.inner(), "saved window bounds are off-screen, using the default");
        }
    }

    if let Some(root) = &root {
        st.watch(&handle, root.clone());
    }

    if selftest {
        // The self-test page is a second Vite entry, so it sits next to index.html in both the
        // dev server and the bundled frontend.
        // window.url() is still about:blank this early, so build the origin ourselves: the dev
        // server in dev builds, Tauri's app origin (platform-specific) in production builds.
        let origin = if cfg!(dev) {
            app.config().build.dev_url.as_ref().map(|u| u.to_string()).unwrap_or_default()
        } else if cfg!(windows) {
            "http://tauri.localhost/".to_string()
        } else {
            "tauri://localhost/".to_string()
        };
        match tauri::Url::parse(&format!("{}selftest.html", origin.trim_end_matches('/').to_string() + "/")) {
            Ok(url) => {
                log_line(st.inner(), &format!("selftest: navigating to {url}"));
                let _ = window.navigate(url);
            }
            Err(e) => log_line(st.inner(), &format!("selftest: bad url: {e}")),
        }
    }

    // A page that never loads must not leave an invisible process behind.
    let fallback = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let _ = fallback.show();
    });

    Ok(())
}

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let st = app.state::<AppState>();

    match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => remember_bounds(window),

        // The adapter prevents this close, flushes the UI and destroys the window 400ms later,
        // so this is the last moment the geometry is still readable.
        WindowEvent::CloseRequested { .. } => save_geometry(window),

        // The system theme changed under us: repaint the native background to match.
        WindowEvent::ThemeChanged(theme) => {
            let name = persist_theme(st.inner(), *theme);
            let (r, g, b) = state::background_of(name);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
            }
        }

        WindowEvent::Destroyed => {
            *st.watcher.lock().unwrap_or_else(|p| p.into_inner()) = None;
            log_line(st.inner(), "os editor exited");
        }

        _ => {}
    }
}

/// Bounds and theme into `state.json`. Without a vault there is nowhere to write them.
fn save_geometry(window: &tauri::Window) {
    let app = window.app_handle();
    let st = app.state::<AppState>();
    let Some(root) = st.root() else { return };
    let bounds = current_bounds(window);
    if let Err(e) = state::save_window(&root, bounds) {
        log_line(st.inner(), &format!("window state save failed: {e}"));
    }
    // `ThemeChanged` only fires for system theme changes, so the value the adapter set
    // with `winSetTheme` is read back here instead.
    if let Ok(theme) = window.theme() {
        persist_theme(st.inner(), theme);
    }
}

/// The `ose::BeforeRestart` hook: `updateApply` exits from a worker thread and never reaches
/// `CloseRequested`, so it asks for the same save first.
fn save_for_restart(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        save_geometry(&w.as_ref().window());
    }
}

/// Mirrors the window theme into `state.json` so the next launch paints the right colour before
/// the UI has run a line of JavaScript. Returns the name it wrote (or would have, with no vault).
fn persist_theme(st: &AppState, theme: tauri::Theme) -> &'static str {
    let name = if matches!(theme, tauri::Theme::Dark) {
        "dark"
    } else {
        "light"
    };
    if let Some(root) = st.root() {
        if let Err(e) = state::patch(&root, "theme", serde_json::Value::String(name.to_string())) {
            log_line(st, &format!("theme persist failed: {e}"));
        }
    }
    name
}

fn remember_bounds(window: &tauri::Window) {
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    *LAST_NORMAL.lock().unwrap_or_else(|p| p.into_inner()) = Some(state::Bounds {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
        maximized: false,
    });
}

fn current_bounds(window: &tauri::Window) -> state::Bounds {
    let maximized = window.is_maximized().unwrap_or(false);
    let remembered = *LAST_NORMAL.lock().unwrap_or_else(|p| p.into_inner());

    if let Some(bounds) = remembered {
        return state::Bounds { maximized, ..bounds };
    }
    let (x, y) = window.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
    let (w, h) = window
        .outer_size()
        .map(|s| (s.width, s.height))
        .unwrap_or((1280, 800));
    state::Bounds { x, y, w, h, maximized }
}

fn open_log(path: &Path) -> Option<File> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(dir);
        }
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// The self-test with no vault: say so where the user can see it, then exit 2. The ordinary
/// start never comes here any more; it asks for a folder instead.
fn fatal(log: Option<&Path>, message: &str) -> ! {
    eprintln!("{message}");
    if let Some(path) = log {
        if let Some(mut file) = open_log(path) {
            use std::io::Write as _;
            let _ = writeln!(file, "{message}");
        }
    }
    message_box("os", message);
    std::process::exit(2)
}

#[cfg(windows)]
fn message_box(title: &str, text: &str) {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    let (body, caption) = (wide(text), wide(title));
    const MB_ICONERROR: u32 = 0x0000_0010;
    // Safe: both buffers are NUL-terminated and outlive the call.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            caption.as_ptr(),
            MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn message_box(_title: &str, _text: &str) {}

/// `--version` from a terminal: the release build is a windows-subsystem process with no
/// console, so it attaches to the parent's; with none (double-clicked) this fails and the
/// line goes nowhere, which is fine. A console build already has one and the call is a no-op.
#[cfg(windows)]
fn attach_parent_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(pid: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    // Safe: no pointers cross; failure is reported by the return value and ignored.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_parent_console() {}
