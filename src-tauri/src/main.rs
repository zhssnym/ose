// The webview draws the whole window, including the title bar, so the console subsystem is off
// in release: no flash of a terminal behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, WindowEvent};

use ose::{args, log_line, protocol, pty, state, vault, watcher, AppState};

/// The last geometry the window had while neither maximised nor minimised. Tauri reports the
/// maximised rectangle while maximised, so this is what gets written to `state.json`.
static LAST_NORMAL: Mutex<Option<state::Bounds>> = Mutex::new(None);

const NO_VAULT: &str = "os could not find the vault.\n\n\
Start it from inside the vault folder, pass --root <folder>, or set OSE_ROOT.\n\
The vault is the folder that holds CLAUDE.md.";

fn main() {
    let opts = args::parse(std::env::args().skip(1));

    let root = match vault::resolve_root(opts.root.as_deref()) {
        Some(root) => root,
        None => fatal(opts.log.as_deref(), NO_VAULT),
    };

    let app_state = AppState::new(root.clone(), opts.log.as_deref().and_then(open_log));
    log_line(
        &app_state,
        &format!("os editor starting, vault root: {}", root.display()),
    );

    let protocol_root = root.clone();
    let selftest = opts.selftest;

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![ose::commands::rpc])
        // Read-only access to the vault for <img src> and friends.
        .register_uri_scheme_protocol("vault", move |_ctx, request| {
            protocol::serve(&protocol_root, &request)
        })
        // The window starts invisible; the first finished page load is the earliest moment
        // showing it cannot flash an empty frame.
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Finished) {
                let window = webview.window();
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .setup(move |app| setup(app, selftest))
        .on_window_event(on_window_event)
        .run(tauri::generate_context!())
        .expect("os failed to start");
}

fn setup(app: &mut tauri::App, selftest: bool) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let st = app.state::<AppState>();
    let root = st.root.clone();

    let window = app
        .get_webview_window("main")
        .ok_or("the main window is missing from tauri.conf.json")?;

    // Theme first: the background colour has to be right before anything is painted.
    let theme = state::theme(&root);
    let _ = window.set_theme(Some(if theme == "dark" {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    }));
    let (r, g, b) = state::background_of(theme);
    let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, 255)));

    // Saved bounds, but only if they still land on a monitor that exists.
    if let Some(bounds) = state::read_window(&root) {
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

    let started = watcher::start(handle, root.clone());
    *st.watcher.lock().unwrap_or_else(|p| p.into_inner()) = Some(started);

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
        WindowEvent::CloseRequested { .. } => {
            let bounds = current_bounds(window);
            if let Err(e) = state::save_window(&st.root, bounds) {
                log_line(st.inner(), &format!("window state save failed: {e}"));
            }
            // `ThemeChanged` only fires for system theme changes, so the value the adapter set
            // with `winSetTheme` is read back here instead.
            if let Ok(theme) = window.theme() {
                persist_theme(st.inner(), theme);
            }
        }

        // The system theme changed under us: repaint the native background to match.
        WindowEvent::ThemeChanged(theme) => {
            let name = persist_theme(st.inner(), *theme);
            let (r, g, b) = state::background_of(name);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
            }
        }

        WindowEvent::Destroyed => {
            pty::kill_all(st.inner());
            *st.watcher.lock().unwrap_or_else(|p| p.into_inner()) = None;
            log_line(st.inner(), "os editor exited");
        }

        _ => {}
    }
}

/// Mirrors the window theme into `state.json` so the next launch paints the right colour before
/// the UI has run a line of JavaScript. Returns the name it wrote.
fn persist_theme(st: &AppState, theme: tauri::Theme) -> &'static str {
    let name = if matches!(theme, tauri::Theme::Dark) {
        "dark"
    } else {
        "light"
    };
    if let Err(e) = state::patch(&st.root, "theme", serde_json::Value::String(name.to_string())) {
        log_line(st, &format!("theme persist failed: {e}"));
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

/// No vault, no app. Say so where the user can see it, then exit 2.
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
