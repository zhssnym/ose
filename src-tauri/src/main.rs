// The release build has no console of its own: no flash of a terminal behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use tauri::webview::PageLoadEvent;
use tauri::{Manager, WindowEvent};
use tauri_plugin_dialog::DialogExt as _;

use ose::windows::{self, Host};
use ose::{args, commands, local, log_line, platform, protocol, state, vault, vaults, Root, Source};

fn main() {
    // Tauri's, wry's and notify's own warnings into our log (lib.rs `Records`), before any of
    // them can say something.
    ose::install_log_records();
    let opts = args::parse(std::env::args().skip(1));

    if opts.version {
        // The release binary has no console of its own; borrowing the parent's makes the line
        // land in the terminal that asked.
        attach_parent_console();
        println!("{}", platform::version_line());
        std::process::exit(0);
    }

    let host = Host::new(opts.log.as_deref().and_then(open_log), Some(pick_folder), Some(save_file), Some(pick_file));
    log_line(&host, &format!("ose starting ({})", platform::version_line()));
    if opts.shell_ignored {
        log_line(&host, "--shell is gone: the shell is inside the executable, and `npm run tauri dev` is the live loop");
    }

    // One window per vault (S14, D14): when another instance already holds the lock, the plugin
    // below hands it this process's argv and ends the process *inside* `builder.build()`, before
    // a line of ours could run. That is invisible on purpose while a window comes forward — and
    // a trap when it does not, because the copy holding the lock can be a ghost: a force-killed
    // app whose process is still there. So the lock is probed first and the handover is said out
    // loud, in this process's own log and on its stderr.
    // The identifier the plugin names its lock after is the built config's, which a
    // `tauri build --config` overlay can change; the file alone would name another app's lock.
    let context = tauri::generate_context!();
    if another_instance_holds_the_lock(&context.config().identifier) {
        log_line(&host, HANDOVER);
    }

    let typed = ose::bindings::builder();
    let app = tauri::Builder::default()
        .manage(host)
        // First plugin, as the plugin's own documentation requires: a second launch hands its
        // argv over and exits before anything else in this process runs (S14).
        .plugin(tauri_plugin_single_instance::init(on_second_instance))
        // The native folder picker, save dialog and open-file dialog (`pick_folder` and friends
        // below); used from Rust only, so no capability entry is needed.
        .plugin(tauri_plugin_dialog::init())
        // Drag out (§5.5): the page starts a native drag of vault files, as copies.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(typed.invoke_handler())
        // Read-only access to the vault for <img src> and friends: each window its own vault,
        // read per request so a vault picked after startup is served at once. Asynchronous: the
        // synchronous form is answered inside WebView2's request callback, on the UI thread, so
        // a slow disk or a big read froze every window and the IPC with it. The read runs on a
        // blocking worker, and an answer is never more than protocol::CHUNK bytes.
        .register_asynchronous_uri_scheme_protocol("vault", |ctx, request, responder| {
            let host = ctx.app_handle().state::<Host>();
            let win = host.get(ctx.webview_label());
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::serve_for(win.as_deref(), &request));
            });
        })
        // A window starts invisible; the first finished page load is the earliest moment showing
        // it cannot flash an empty frame.
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let window = webview.window();
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .setup(move |app| setup(app, &opts))
        // The one menu item with an action of ours: Quit takes the close path of every window,
        // so each editor's last save is awaited exactly as it is when a close button is pressed.
        .on_menu_event(|app, event| {
            if event.id() == MENU_QUIT {
                commands::close_all(app);
            }
        })
        .on_window_event(on_window_event)
        .build(context)
        .expect("ose failed to start");

    app.run(on_run_event);
}

/// Quitting must not skip the save (S16). `ExitRequested` with no code is the app being asked to
/// go — `app.quit`, and on Windows and Linux the last window closing. While any window is still
/// there the exit is held and every window is asked to close instead, which is the one path that
/// waits for its editor: CloseRequested -> the adapter's `closing` notice -> destroy. Once no
/// window is left the same event means "nothing left to save", and the app exits.
///
/// A code (`app.exit(n)`) is honoured as asked.
///
/// macOS: the system's own Quit (the Dock, `terminate:`) reaches tao as
/// `applicationWillTerminate`, already past the point of no return, and arrives here as
/// `RunEvent::Exit`. The app menu's Quit is therefore a custom item that closes every window,
/// never `PredefinedMenuItem::quit()`. `Exit` still writes the geometry.
fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { code: None, api, .. } => {
            if app.webview_windows().is_empty() {
                return;
            }
            api.prevent_exit();
            commands::close_all(app);
        }
        tauri::RunEvent::Exit => {
            for w in app.webview_windows().values() {
                windows::save_geometry(app, &w.as_ref().window());
            }
            log_line(app.state::<Host>().inner(), "ose exited");
        }
        // A file handed to the app by Finder (a double-click, "Open with", a drop on the Dock
        // icon). It can come before `setup` on a cold start: then it waits for the first window.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        tauri::RunEvent::Opened { urls } => {
            let host = app.state::<Host>();
            for url in urls {
                let Ok(path) = url.to_file_path() else { continue };
                if host.is_ready() {
                    windows::open_path(app, &path);
                } else {
                    host.queue_pending(path);
                }
            }
        }
        _ => {}
    }
}

/// The macOS menu bar, and the whole reason S16 needed more than a `RunEvent` handler.
///
/// Tauri gives a macOS app a default menu whose Quit is `PredefinedMenuItem::quit()`, which sends
/// `terminate:` to NSApp: past the point of no return, with no way to wait for the editor. So the
/// app submenu's Quit is a plain item with the same accelerator, and choosing it closes every
/// window through its save path.
///
/// The Edit submenu is not decoration: on macOS the standard editing accelerators
/// (Cmd+C/V/X/A/Z) come from the menu bar, and a window with a menu that does not carry them
/// loses copy and paste in the web view.
///
/// Built on every platform so it compiles and type-checks in CI on Windows too, and installed on
/// macOS alone: Windows draws its own title bar and wants no menu bar.
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
    let window_menu = Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::fullscreen(app, None)?])?;
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

/// The app identifier as `tauri.conf.json` spells it, for the tests. At run time the probe takes
/// it from the built context instead (`main`), which is what the single-instance plugin reads.
#[cfg(test)]
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
/// connecting is the only way to tell a live singleton from the socket file a crash left behind —
/// the running app sees a connection that says nothing, which `on_second_instance` ignores.
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

    let name: Vec<u16> = OsStr::new(&format!("{identifier}-sim")).encode_wide().chain(std::iter::once(0)).collect();
    // Safe: the name is NUL-terminated and outlives the call, and the handle is closed at once.
    // Opening a named mutex neither acquires it nor changes it.
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

/// A second `ose` launched while one is running (D14). The plugin has already handed us its argv
/// and ended that process, so this decides what the launch meant (docs/HOST.md "OS opens"):
///
/// - paths: each one routed (`windows::route`): a folder or a file of another vault opens (or
///   focuses) that vault's window, a file of an open vault goes to its window, anything else is
///   an outside tab in the window focused last;
/// - `--root <dir>` and no path: that vault's window, made when there is none;
/// - nothing: the window focused last comes forward.
fn on_second_instance(app: &tauri::AppHandle, argv: Vec<String>, cwd: String) {
    // A notification with no argv at all is not a launch: on macOS it is the knock from
    // `another_instance_holds_the_lock`, which connects and says nothing. Ignore it whole.
    if argv.iter().all(|a| a.trim().is_empty()) {
        return;
    }
    let host = app.state::<Host>();
    log_line(host.inner(), &format!("second instance: {}", argv.join(" ")));

    let opts = args::parse(argv.into_iter().skip(1));
    let cwd = PathBuf::from(cwd);
    let mut paths: Vec<PathBuf> = opts.paths.iter().map(|p| args::absolute(p, Some(&cwd))).collect();
    if paths.is_empty() {
        if let Some(root) = opts.root.as_deref().filter(|r| !r.is_empty()) {
            paths.push(args::absolute(root, Some(&cwd)));
        }
    }
    if paths.is_empty() {
        match host.most_recent() {
            Some(w) => windows::raise(app, &w.label),
            None => windows::deliver(app, windows::Route::New { root: None, request: None }, Path::new("")),
        }
        return;
    }
    for p in paths {
        windows::open_path(app, &p);
    }
}

/// The `ose::FolderPicker` for this binary: the dialog plugin's native folder picker, parented to
/// the window that asked, opened in `start`. The plugin hops to the main thread only to create
/// the dialog, runs it on a thread of its own and calls `done` from there, so nothing here blocks
/// the event loop on any platform.
fn pick_folder(
    app: &tauri::AppHandle,
    parent: Option<tauri::WebviewWindow>,
    start: Option<PathBuf>,
    done: Box<dyn FnOnce(Option<PathBuf>) + Send>,
) {
    let mut dialog = app.dialog().file().set_title("Choose a vault folder");
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    if let Some(window) = parent {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_folder(move |picked| {
        done(picked.and_then(|fp| fp.as_path().map(Path::to_path_buf)));
    });
}

/// The `ose::FileSaver` for this binary: the dialog plugin's native save dialog, behind `Export
/// to PDF` (print.rs). Same shape as the folder picker above, and the same reason for living here:
/// the plugin is the binary's.
fn save_file(
    app: &tauri::AppHandle,
    parent: Option<tauri::WebviewWindow>,
    start: Option<PathBuf>,
    name: String,
    done: Box<dyn FnOnce(Option<PathBuf>) + Send>,
) {
    let mut dialog = app.dialog().file().set_title("Export to PDF").set_file_name(name).add_filter("PDF", &["pdf"]);
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    if let Some(window) = parent {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |chosen| {
        done(chosen.and_then(|fp| fp.as_path().map(Path::to_path_buf)));
    });
}

/// The `ose::FilePicker` for this binary: the dialog plugin's open-file dialog, behind "Open
/// file…" (`pickFile`).
fn pick_file(app: &tauri::AppHandle, parent: Option<tauri::WebviewWindow>, title: String, done: Box<dyn FnOnce(Option<PathBuf>) + Send>) {
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(window) = parent {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |picked| {
        done(picked.and_then(|fp| fp.as_path().map(Path::to_path_buf)));
    });
}

fn setup(app: &mut tauri::App, opts: &args::Args) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let host = app.state::<Host>();
    let host = host.inner();

    // The persistent log (M54), in every build: `<app log dir>/ose.log`, rotated at 2 MB. The
    // lines written before this point were held and land first.
    match handle.path().app_log_dir() {
        Ok(dir) => match ose::open_persistent_log(&dir) {
            Ok(path) => log_line(host, &format!("log: {}", path.display())),
            Err(e) => log_line(host, &format!("log: no persistent log: {e}")),
        },
        Err(e) => log_line(host, &format!("log: no log folder: {e}")),
    }
    // Drafts live per machine, outside every vault (docs/HOST.md "Drafts"), and so does the local
    // store: the session, the window, the theme mirror (docs/HOST.md "Local state").
    match handle.path().app_local_data_dir() {
        Ok(dir) => {
            write_drag_icon(host, &dir);
            // A vault's state and its file history live here too: nothing of the app in the vault.
            ose::state::set_home(dir.clone());
            ose::versions::set_home(dir.clone());
            host.set_data_dir(dir);
        }
        Err(e) => log_line(host, &format!("drafts: no app data folder: {e}")),
    }
    match handle.path().app_config_dir() {
        Ok(dir) => host.set_config_dir(dir),
        Err(e) => log_line(host, &format!("local state: no app config folder: {e}")),
    }
    // The menu bar (macOS only; see `build_menu`). Built everywhere so a mistake here is a compile
    // error on every runner, installed only where a menu bar belongs.
    match build_menu(&handle) {
        Ok(menu) => {
            if cfg!(target_os = "macos") {
                if let Err(e) = handle.set_menu(menu) {
                    log_line(host, &format!("menu: {e}"));
                }
            }
        }
        Err(e) => log_line(host, &format!("menu: {e}")),
    }

    // The first window's vault, in the resolution order of docs/HOST.md "The vault root", with
    // one step first: a folder, or a file of a vault (one holding `.ose/`), handed to this launch
    // by the OS is the vault to open. The other paths are routed once the window exists.
    let cwd = std::env::current_dir().ok();
    let paths: Vec<PathBuf> = opts.paths.iter().map(|p| args::absolute(p, cwd.as_deref())).collect();
    let explicit = opts.root.as_deref().filter(|r| !r.is_empty()).and_then(|r| {
        let full = vault::normalize(Path::new(r));
        full.is_dir().then_some(Root { path: full, source: Source::Arg })
    });
    let from_open = if explicit.is_none() {
        paths.first().and_then(|p| {
            if p.is_dir() {
                // A folder of a vault opens that vault (and `open_path` below shows the folder),
                // never a vault of its own nested in it.
                Some(windows::vault_of_folder(p, &windows::ose_vault_of).unwrap_or_else(|| p.clone()))
            } else {
                windows::ose_vault_of(p)
            }
        })
    } else {
        None
    };
    let root = explicit
        .or_else(|| from_open.map(|path| Root { path, source: Source::Opened }))
        .or_else(|| vault::resolve_root(None).map(|(path, source)| Root { path, source }))
        .or_else(|| vault::read_remembered(&handle).map(|path| Root { path, source: Source::Remembered }));
    match &root {
        Some(r) => log_line(host, &format!("vault root: {} (from {})", r.path.display(), r.source.as_str())),
        None => log_line(host, "no vault: the shell will ask for a folder"),
    }
    // Whatever we ended up opening belongs at the top of the recent list, so the chooser and
    // `Change vault…` know about the vault the app opens by itself as well (S46).
    if let Some(r) = &root {
        if let Err(e) = vaults::record(&handle, &r.path) {
            log_line(host, &format!("recent vaults: {e}"));
        }
    }

    windows::build(&handle, windows::MAIN, root)?;

    // Every path of this launch, and what the OS asked for before the app was ready (macOS).
    // A folder that became the vault above routes to its own window, which is a no-op.
    let queued = host.set_ready();
    for p in paths.iter().chain(queued.iter()) {
        windows::open_path(&handle, p);
    }
    Ok(())
}

/// The picture a drag out carries: the app's icon, written once into the app's data folder so
/// the drag plugin can read it by path (`platform().dragIcon`).
fn write_drag_icon(host: &Host, dir: &Path) {
    const ICON: &[u8] = include_bytes!("../icons/128x128.png");
    let file = dir.join("drag.png");
    let same = std::fs::read(&file).map(|b| b == ICON).unwrap_or(false);
    if !same {
        let written = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&file, ICON));
        if let Err(e) = written {
            log_line(host, &format!("drag icon: {e}"));
            return;
        }
    }
    host.set_drag_icon(file);
}

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    let host = app.state::<Host>();

    match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => windows::remember_bounds(app, window),

        // The adapter prevents this close, flushes the UI and destroys the window afterwards, so
        // this is the last moment the geometry is still readable.
        WindowEvent::CloseRequested { .. } => {
            windows::save_geometry(app, window);
            if let Ok(theme) = window.theme() {
                persist_theme(host.inner(), theme);
            }
        }

        WindowEvent::Focused(true) => host.touch(window.label()),

        // The system theme changed under us: repaint every window's native background to match.
        WindowEvent::ThemeChanged(theme) => {
            let name = persist_theme(host.inner(), *theme);
            let (r, g, b) = state::background_of(name);
            for w in app.webview_windows().values() {
                let _ = w.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
            }
        }

        WindowEvent::Destroyed => {
            host.remove(window.label());
            log_line(host.inner(), &format!("{}: window closed", window.label()));
        }

        _ => {}
    }
}

/// Mirrors the window theme into this machine's local store so the next launch paints the right
/// colour before the UI has run a line of JavaScript. Returns the name it wrote (or would have,
/// with no config folder).
fn persist_theme(host: &Host, theme: tauri::Theme) -> &'static str {
    let name = if matches!(theme, tauri::Theme::Dark) { "dark" } else { "light" };
    if let Some(config) = host.config_dir() {
        if let Err(e) = local::host_set(&config, "theme", serde_json::Value::String(name.to_string())) {
            log_line(host, &format!("theme persist failed: {e}"));
        }
    }
    name
}

fn open_log(path: &Path) -> Option<File> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(dir);
        }
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// `--version` from a terminal: the release build is a windows-subsystem process with no console,
/// so it attaches to the parent's; with none (double-clicked) this fails and the line goes
/// nowhere, which is fine. A console build already has one and the call is a no-op.
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

    /// The single-instance lock is named after the identifier. An empty one would make the probe
    /// answer "nobody is holding it" for ever, and silently — which is the bug it exists to close.
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
