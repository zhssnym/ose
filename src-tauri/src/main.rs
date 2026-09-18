// The webview draws the whole window, including the title bar, so the console subsystem is off
// in release: no flash of a terminal behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_dialog::DialogExt as _;

use ose::{args, log_line, platform, protocol, run, shell, state, vault, vaults, AppState, Root, Source};

/// The last geometry the window had while neither maximised nor minimised. Tauri reports the
/// maximised rectangle while maximised, so this is what gets written to `state.json`.
static LAST_NORMAL: Mutex<Option<state::Bounds>> = Mutex::new(None);

fn main() {
    let opts = args::parse(std::env::args().skip(1));

    if opts.version {
        // The release binary has no console of its own; borrowing the parent's makes the line
        // land in the terminal that asked.
        attach_parent_console();
        println!("{}", platform::version_line());
        std::process::exit(0);
    }

    // Steps 1 to 3 of the resolution order need no app: the argument, the executable's
    // ancestors, the environment. The remembered root (step 4) needs the app's config folder
    // and is read in `setup`; with nothing at all the shell asks (step 5).
    let root = vault::resolve_root(opts.root.as_deref()).map(|(path, source)| Root { path, source });
    let app_state = AppState::new(
        root.clone(),
        opts.log.as_deref().and_then(open_log),
        Some(pick_folder),
        Some(save_file),
    );
    app_state.set_shell_options(shell::Options { dir: opts.shell.clone() });
    match &root {
        Some(r) => log_line(
            &app_state,
            &format!("ose starting, vault root: {} (from {})", r.path.display(), r.source.as_str()),
        ),
        None => log_line(&app_state, "ose starting, no vault yet"),
    }

    // One window per vault (S14): when another instance already holds the lock, the plugin
    // below hands it this process's argv and ends the process *inside* `builder.build()`,
    // before a line of ours could run. That is invisible on purpose while a window comes
    // forward — and a trap when it does not, because the copy holding the lock can be a ghost:
    // a force-killed app whose process is still there. "The app does not start and the log
    // says nothing" cost QA-K forty minutes. So the lock is probed first and the handover is
    // said out loud, in this process's own log and on its stderr. If the other copy happens to
    // exit between the probe and the plugin's own check, this launch simply carries on and the
    // log carries on under the line.
    if another_instance_holds_the_lock(&app_identifier()) {
        log_line(&app_state, HANDOVER);
    }

    let app = tauri::Builder::default()
        .manage(app_state)
        // First plugin, as the plugin's own documentation requires: a second launch hands its
        // argv over and exits before anything else in this process runs (S14).
        .plugin(tauri_plugin_single_instance::init(on_second_instance))
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
        // The kernel's own bundles, embedded from `dist-kernel/` (frontendDist). Read-only,
        // CORS open, never cached: `http://ose.localhost/kernel.js` on Windows and
        // `ose://localhost/kernel.js` on macOS (docs/KERNEL.md "Origins").
        .register_uri_scheme_protocol("ose", |ctx, request| {
            shell::serve_kernel(ctx.app_handle(), &request)
        })
        // The app itself: `/plugins/...` from `<vault>/.ose/plugins` on disk, everything else
        // from the shell inside the executable (or `--shell <dir>`). Files only; `index.html`
        // gets the import map and the two stylesheet links on the way out.
        .register_uri_scheme_protocol("app", |ctx, request| {
            let app = ctx.app_handle();
            let st = app.state::<AppState>();
            shell::serve_app(st.inner(), &request, |name| {
                app.asset_resolver().get(name.to_string()).map(|a| (a.bytes, a.mime_type))
            })
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
        .setup(setup)
        // The one menu item with an action of ours: Quit takes the close path, so the editor's
        // last save is awaited exactly as it is when the window's close button is pressed.
        .on_menu_event(|app, event| {
            if event.id() == MENU_QUIT {
                quit_through_the_save_path(app);
            }
        })
        .on_window_event(on_window_event)
        .build(tauri::generate_context!())
        .expect("ose failed to start");

    app.run(on_run_event);
}

/// Quitting must not skip the save (S16). `ExitRequested` with no code is the app being asked
/// to go — `app.quit`, and on Windows and Linux the last window closing. While the main window
/// is still there the exit is held and the window is asked to close instead, which is the one
/// path that waits for the editor: CloseRequested -> the adapter's `closing` notice -> destroy.
/// Once the window is gone the same event means "nothing left to save", and the app exits.
///
/// A code (`app.exit(n)`) is honoured as asked.
///
/// macOS: the system's own Quit (the Apple menu, the Dock, `terminate:`) reaches tao as
/// `applicationWillTerminate`, which is already past the point of no return and arrives here as
/// `RunEvent::Exit`, not `ExitRequested`. The app menu's Quit item must therefore be a custom
/// item that runs the `quit` command, never `PredefinedMenuItem::quit()`. `Exit` still writes
/// the geometry, so at worst a forced quit loses the unsaved buffer, never the window position.
fn quit_through_the_save_path(app: &tauri::AppHandle) {
    let st = app.state::<AppState>();
    match app.get_webview_window("main") {
        Some(window) => {
            log_line(st.inner(), "quit: closing the window through the save path");
            let _ = window.close();
        }
        None => app.exit(0),
    }
}

fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { code: None, api, .. } => {
            if app.get_webview_window("main").is_none() {
                return;
            }
            api.prevent_exit();
            quit_through_the_save_path(app);
        }
        tauri::RunEvent::Exit => {
            save_on_exit(app);
            run::kill_all(app.state::<AppState>().inner());
        }
        _ => {}
    }
}

/// The macOS menu bar, and the whole reason S16 needed more than a `RunEvent` handler.
///
/// Tauri gives a macOS app a default menu whose Quit is `PredefinedMenuItem::quit()`. That item
/// sends `terminate:` to NSApp; tao catches it in `applicationWillTerminate`, which is already
/// past the point of no return, and it reaches the app as `RunEvent::Exit` — never
/// `ExitRequested`, so there is nothing to prevent and no way to wait for the editor. Cmd+Q
/// with that item loses unsaved work, whatever `on_run_event` does.
///
/// So the app submenu's Quit is a plain item with the same accelerator, and choosing it runs
/// the same close path as the close button: `window.close()` -> CloseRequested -> the adapter
/// holds it open until the last save has settled -> destroy -> exit.
///
/// The Edit submenu is not decoration: on macOS the standard editing accelerators
/// (Cmd+C/V/X/A/Z) come from the menu bar, and a window with a menu that does not carry them
/// loses copy and paste in the web view.
///
/// Built on every platform so it compiles and type-checks in CI on Windows too, and installed
/// on macOS alone: Windows and Linux draw their own title bar and want no menu bar at all.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as P, Submenu};

    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Ose", true, Some("Cmd+Q"))?;
    let about = P::about(app, Some("About Ose"), Some(AboutMetadata::default()))?;
    let app_menu = Submenu::with_items(
        app,
        "Ose",
        true,
        &[
            &about,
            &P::separator(app)?,
            &P::services(app, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &quit,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&P::minimize(app, None)?, &P::fullscreen(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

/// The id of the one menu item with an action of our own.
const MENU_QUIT: &str = "app.quit";

/// The one line a handed-over launch leaves behind. It says what happened and what to do when
/// no window comes forward, because that is the case a person cannot otherwise diagnose.
const HANDOVER: &str = concat!(
    "another Ose is already running; handed this launch over to it and exiting. ",
    "If no window came forward, that copy has none: end the ose process and start again."
);

/// The app identifier, read from the very `tauri.conf.json` the build reads. The
/// single-instance plugin spells its lock out of this string, and the probe below has to spell
/// the same one; embedding the file is how the two cannot drift apart.
fn app_identifier() -> String {
    const CONF: &str = include_str!("../tauri.conf.json");
    serde_json::from_str::<serde_json::Value>(CONF)
        .ok()
        .and_then(|v| v.get("identifier")?.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Is another instance already holding the single-instance lock?
///
/// The plugin exposes nothing to ask, so this reads its own mechanism, without taking it.
/// **Windows**: the named mutex `<identifier>-sim` exists exactly while another instance holds
/// it, and `OpenMutexW` only looks. **macOS**: the plugin's rendezvous is a unix socket, and
/// connecting is the only way to tell a live singleton from the socket file a crash left
/// behind — the running app sees a connection that says nothing, which `on_second_instance`
/// ignores. **Linux** is dbus, is not probed, and is not a platform Ose ships to.
#[cfg(windows)]
fn another_instance_holds_the_lock(identifier: &str) -> bool {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenMutexW(access: u32, inherit: i32, name: *const u16) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    const SYNCHRONIZE: u32 = 0x0010_0000;

    let name: Vec<u16> = OsStr::new(&format!("{identifier}-sim"))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // Safe: the name is NUL-terminated and outlives the call, and the handle is closed at
    // once. Opening a named mutex neither acquires it nor changes it.
    unsafe {
        let handle = OpenMutexW(SYNCHRONIZE, 0, name.as_ptr());
        if handle.is_null() {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(target_os = "macos")]
fn another_instance_holds_the_lock(identifier: &str) -> bool {
    let socket = format!("/tmp/{}_si.sock", identifier.replace(['.', '-'], "_"));
    std::os::unix::net::UnixStream::connect(socket).is_ok()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn another_instance_holds_the_lock(_identifier: &str) -> bool {
    false
}

/// A second `ose` launched while one is running. The plugin has already handed us its argv and
/// ended that process, so this decides what the launch meant: the same vault (or none named)
/// brings the window forward, another folder is adopted and the window reloads into it — one
/// window per vault, and never two watchers on one folder (S14).
fn on_second_instance(app: &tauri::AppHandle, argv: Vec<String>, cwd: String) {
    // A notification with no argv at all is not a launch: on macOS it is the knock from
    // `another_instance_holds_the_lock`, which connects and says nothing. Ignore it whole.
    if argv.iter().all(|a| a.trim().is_empty()) {
        return;
    }
    let st = app.state::<AppState>();
    log_line(st.inner(), &format!("second instance: {}", argv.join(" ")));

    let opts = args::parse(argv.into_iter().skip(1));
    let asked = opts.root.as_deref().map(|r| {
        let p = PathBuf::from(r);
        if p.is_absolute() { p } else { Path::new(&cwd).join(p) }
    });
    let asked = asked.filter(|p| p.is_dir()).map(|p| vault::normalize(&p));

    let open = st.root();
    let different = matches!((&asked, &open), (Some(a), Some(o)) if !vaults::same(a, o))
        || (asked.is_some() && open.is_none());

    if different {
        let dir = asked.expect("different implies a folder was named");
        let ctx = ose::Ctx { app, st: st.inner() };
        match vault::adopt(&ctx, &dir, Source::Picked) {
            Ok(_) => {
                if let Err(e) = vaults::record(app, &dir) {
                    log_line(st.inner(), &format!("recent vaults: {e}"));
                }
                // Whatever the previous vault's plugins were running belongs to a world that
                // is gone.
                run::kill_all(st.inner());
                // The page goes back to the shell's index: the plugins of the *new* vault are
                // other files, and nothing in the page could swap them under itself.
                let _ = app.emit("vault", serde_json::json!({ "changed": true }));
                if let Some(window) = app.get_webview_window("main") {
                    shell::load_window(app, &window);
                }
            }
            Err(e) => log_line(st.inner(), &format!("second instance: {e}")),
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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

/// The `ose::FileSaver` for this binary: the dialog plugin's native save dialog, behind
/// `Export to PDF` (print.rs). Same shape as the folder picker above, and the same reason for
/// living here: the plugin is the binary's.
fn save_file(
    app: &tauri::AppHandle,
    start: Option<PathBuf>,
    name: String,
    done: Box<dyn FnOnce(Option<PathBuf>) + Send>,
) {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export to PDF")
        .set_file_name(name)
        .add_filter("PDF", &["pdf"]);
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |chosen| {
        done(chosen.and_then(|fp| fp.as_path().map(Path::to_path_buf)));
    });
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let st = app.state::<AppState>();

    // Step 4: the remembered root, now that the app knows its config folder.
    if st.root().is_none() {
        match vault::read_remembered(&handle) {
            Some(path) => {
                log_line(st.inner(), &format!("vault root: {} (from remembered)", path.display()));
                st.set_root(path, Source::Remembered);
            }
            None => log_line(st.inner(), "no vault: the shell will ask for a folder"),
        }
    }
    // The menu bar (macOS only; see `build_menu`). Built everywhere so a mistake here is a
    // compile error on every runner, installed only where a menu bar belongs.
    match build_menu(&handle) {
        Ok(menu) => {
            if cfg!(target_os = "macos") {
                if let Err(e) = handle.set_menu(menu) {
                    log_line(st.inner(), &format!("menu: {e}"));
                }
            }
        }
        Err(e) => log_line(st.inner(), &format!("menu: {e}")),
    }

    let root = st.root();

    // Whatever we ended up opening — argument, exe folder, environment, remembered — belongs
    // at the top of the recent list, so the chooser and `Change vault…` know about the vault
    // the app opens by itself as well as the ones that were picked (S46).
    if let Some(root) = &root {
        if let Err(e) = vaults::record(&handle, root) {
            log_line(st.inner(), &format!("recent vaults: {e}"));
        }
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

    // The window shows the shell, whether or not there is a vault: with none it draws its own
    // vault chooser. It starts on the blank `frontendDist` index (scripts/embed-shell.mjs), so
    // a failure to navigate leaves a plain window rather than an error page.
    shell::load_window(&handle, &window);

    // A page that never loads must not leave an invisible process behind.
    let anyway = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let _ = anyway.show();
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
            // Nothing a module started outlives the window that asked for it.
            run::kill_all(st.inner());
            log_line(st.inner(), "ose exited");
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

/// `RunEvent::Exit`: a quit that never reached `CloseRequested` (macOS `terminate:`, or
/// `app.exit`) still has its geometry written.
fn save_on_exit(app: &tauri::AppHandle) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The single-instance lock is named after the identifier. An empty one would make the
    /// probe answer "nobody is holding it" for ever, and silently — which is the bug it exists
    /// to close.
    #[test]
    fn the_identifier_comes_out_of_the_config() {
        let id = app_identifier();
        assert!(id.contains('.'), "not an app identifier: {id:?}");
        assert!(!id.contains(char::is_whitespace), "not an app identifier: {id:?}");
    }

    /// Nobody holds a lock named after a string no app uses — and asking must not make one.
    #[test]
    fn a_lock_nobody_holds_reads_as_free() {
        let name = "com.example.ose-no-such-app-4242";
        assert!(!another_instance_holds_the_lock(name));
        assert!(!another_instance_holds_the_lock(name), "the probe created the lock it asked about");
    }
}
