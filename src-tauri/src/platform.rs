//! Platform integration: opening external URLs, revealing a file in the file manager, and
//! what this build is (`--version`, and the `build` field of `platform`).

use std::path::Path;
use std::process::{Command, Stdio};

// ---- what this build is ----------------------------------------------------

/// The commit and day this executable was built from, stamped by CI (`OSE_BUILD_SHA`,
/// `OSE_BUILD_DATE` in build.yml, read at compile time). A local build has none and says so.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildInfo {
    pub sha: String,
    pub short: String,
    pub date: String,
}

pub fn build_info() -> Option<BuildInfo> {
    let sha = option_env!("OSE_BUILD_SHA")?.trim();
    if !is_sha(sha) {
        return None;
    }
    Some(BuildInfo {
        sha: sha.to_string(),
        short: sha[..7].to_string(),
        date: option_env!("OSE_BUILD_DATE").unwrap_or("").trim().to_string(),
    })
}

/// `ose 1.0.0 (a45404e, 2026-09-15)` or `ose 1.0.0 (dev build)`: the `--version` line. The
/// name is the app's, not the file's: a copy on disk under another name prints `ose` too,
/// because that is what it is.
pub fn version_line() -> String {
    let v = env!("CARGO_PKG_VERSION");
    match build_info() {
        Some(b) if !b.date.is_empty() => format!("ose {v} ({}, {})", b.short, b.date),
        Some(b) => format!("ose {v} ({})", b.short),
        None => format!("ose {v} (dev build)"),
    }
}

fn is_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Windows `CREATE_NO_WINDOW`: no console window for any child process we spawn.
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `Command` that never flashes a console window on Windows.
pub(crate) fn quiet_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

// ---- browser keys ---------------------------------------------------------

/// WebView2's browser accelerator keys off (M53): F5, Ctrl+R and Ctrl+Shift+R reload, Ctrl+P
/// prints, F3 finds, Alt+Left goes back — each one a way to throw the page away under unsaved
/// work without asking. With the setting off the page still receives every key, so the app's
/// own commands (Ctrl+P, Ctrl+F) keep working, and editing keys (Ctrl+C/V/X/Z/A) are untouched.
/// The shell guards the same keys in JS as well (docs/SHELL.md), which is all a Mac has.
#[cfg(windows)]
pub fn disable_browser_keys(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;
    let done = window.with_webview(|webview| unsafe {
        let set = webview
            .controller()
            .CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|s| s.cast::<ICoreWebView2Settings3>())
            .and_then(|s| s.SetAreBrowserAcceleratorKeysEnabled(false));
        if let Err(e) = set {
            eprintln!("browser keys: {e}");
        }
    });
    if let Err(e) = done {
        eprintln!("browser keys: {e}");
    }
}

/// WKWebView has no browser keys of its own to switch off: a Mac reloads only through the menu,
/// and ours has no Reload item.
#[cfg(not(windows))]
pub fn disable_browser_keys(_window: &tauri::WebviewWindow) {}

// ---- openPath -------------------------------------------------------------

/// A file — or folder, which lands in the file manager — in the platform's default application
/// (N10, N24). `full` is a vault path the command resolved through `vault::resolve`, so it can
/// never leave the root, or a registered outside file; `opener::open` is handed that resolved
/// *path*, never a string the UI composed — a `file:` or `vscode:` url in the argument is a path
/// segment, not a scheme, which is why `openExternal` can keep refusing every scheme it does not
/// know. The executable check below is deliberately made on folders too: a macOS `.app` bundle is
/// a directory, and opening one runs a program. `rel` names it in errors.
pub fn open_path(full: &Path, rel: &str) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(full).map_err(|_| crate::coded("not_found", format!("nothing to open: {rel}")))?;
    if meta.file_type().is_symlink() {
        return Err(crate::coded("bad_arg", format!("refusing to open a symlink: {rel}")));
    }
    // A link in a page must never run a program: an executable or script is revealed in the
    // file manager instead of opened, so `[x](build.bat)` is a safe thing to click.
    if is_executable(full) {
        return reveal_os(full).map_err(|e| format!("failed to reveal {rel}: {e}"));
    }
    opener::open(full).map_err(|e| format!("failed to open {rel}: {e}"))
}

/// Extensions the platform shells would execute rather than display.
const EXECUTABLE: &[&str] = &[
    "exe", "bat", "cmd", "com", "msi", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "scr",
    "pif", "reg", "lnk", "url", "sh", "command", "app", "jar", "py", "pyw", "rb", "pl",
];

pub(crate) fn is_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXECUTABLE.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

// ---- openExternal ---------------------------------------------------------

/// http, https and mailto only, exactly like the .NET host. Anything else is refused
/// rather than handed to the shell.
pub fn open_external(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() || url.chars().any(char::is_control) {
        return Err(format!("not a url: {url}"));
    }
    let scheme = match url.find(':') {
        Some(i) => &url[..i],
        None => return Err(format!("not a url: {url}")),
    };
    let valid_scheme = !scheme.is_empty()
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !valid_scheme {
        return Err(format!("not a url: {url}"));
    }
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "mailto") {
        return Err(format!("refusing to open scheme: {scheme}"));
    }
    opener::open(url).map_err(|e| format!("failed to open {url}: {e}"))
}

// ---- reveal ---------------------------------------------------------------

/// Shows `full` selected in the file manager. `rel` names it in errors.
pub fn reveal(full: &Path, rel: &str) -> Result<(), String> {
    if std::fs::symlink_metadata(full).is_err() {
        return Err(crate::coded("not_found", format!("nothing to reveal: {rel}")));
    }
    reveal_os(full)
}

#[cfg(windows)]
fn reveal_os(full: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // explorer.exe does not parse its command line the standard way: the argument has to
    // reach it as the single literal `/select,"<path>"`, so it is passed raw.
    let mut c = quiet_command("explorer.exe");
    c.raw_arg(format!("/select,\"{}\"", full.display()));
    spawn_detached(c)
}

#[cfg(target_os = "macos")]
fn reveal_os(full: &Path) -> Result<(), String> {
    let mut c = Command::new("open");
    c.arg("-R").arg(full);
    spawn_detached(c)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_os(full: &Path) -> Result<(), String> {
    let parent = full.parent().unwrap_or(full);
    let mut c = Command::new("xdg-open");
    c.arg(parent);
    spawn_detached(c)
}

/// Starts a helper (explorer, open, xdg-open) and reaps it on a thread so nothing blocks
/// the caller and no zombie is left behind on unix.
fn spawn_detached(mut c: Command) -> Result<(), String> {
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

// ---- platform -------------------------------------------------------------

/// `windows`, `macos` or `linux`.
pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_other_schemes() {
        assert!(open_external("file:///c:/windows").is_err());
        assert!(open_external("javascript:alert(1)").is_err());
        assert!(open_external("nonsense").is_err());
        assert!(open_external("").is_err());
    }

    /// `ose --version` is what a person runs to see what they have, and CI asserts its shape.
    #[test]
    fn the_version_line_names_the_app_and_the_version() {
        let line = version_line();
        assert!(line.starts_with(&format!("ose {} (", env!("CARGO_PKG_VERSION"))), "{line}");
        assert!(line.ends_with(')'), "{line}");
        assert!(!is_sha("abc"));
        assert!(!is_sha(&"z".repeat(40)));
        assert!(is_sha(&"a1b2c3d4".repeat(5)));
    }
}
