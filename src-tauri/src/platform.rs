//! Platform integration: opening external URLs and revealing a file in the file manager.

use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

use crate::{arg_str, Ctx};

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

// ---- rpc ------------------------------------------------------------------

pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    match cmd {
        "openExternal" => Some(cmd_open_external(args)),
        "openPath" => Some(cmd_open_path(ctx, args)),
        "reveal" => Some(cmd_reveal(ctx, args)),
        "platform" => Some(Ok(platform_info(ctx))),
        _ => None,
    }
}

fn cmd_open_external(args: &[Value]) -> Result<Value, String> {
    open_external(&arg_str(args, 0)?)?;
    Ok(Value::Null)
}

fn cmd_reveal(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    reveal(ctx, &arg_str(args, 0)?)?;
    Ok(Value::Null)
}

fn cmd_open_path(ctx: &Ctx, args: &[Value]) -> Result<Value, String> {
    open_path(ctx, &arg_str(args, 0)?)?;
    Ok(Value::Null)
}

// ---- openPath -------------------------------------------------------------

/// A vault file — or folder, which lands in the file manager — in the platform's default
/// application (N10, N24). The argument is a vault-relative path and nothing else: it is
/// resolved through `vault::resolve`, so it can never leave the root, and `opener::open` is
/// handed the resolved *path*, never a string the UI composed — a `file:` or `vscode:` url in
/// the argument is a path segment here, not a scheme, which is why `openExternal` can keep
/// refusing every scheme it does not know. The executable check below is deliberately made on
/// folders too: a macOS `.app` bundle is a directory, and opening one runs a program.
fn open_path(ctx: &Ctx, rel: &str) -> Result<(), String> {
    let root = ctx.st.require_root()?;
    let full = crate::vault::resolve(&root, rel)?;
    let meta = std::fs::symlink_metadata(&full).map_err(|_| format!("nothing to open: {rel}"))?;
    if meta.file_type().is_symlink() {
        return Err(format!("refusing to open a symlink: {rel}"));
    }
    // A link in a page must never run a program: an executable or script is revealed in the
    // file manager instead of opened, so `[x](build.bat)` is a safe thing to click.
    if is_executable(&full) {
        return reveal_os(&full).map_err(|e| format!("failed to reveal {rel}: {e}"));
    }
    opener::open(&full).map_err(|e| format!("failed to open {rel}: {e}"))
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
fn open_external(url: &str) -> Result<(), String> {
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

fn reveal(ctx: &Ctx, rel: &str) -> Result<(), String> {
    let root = ctx.st.require_root()?;
    let full = crate::vault::resolve(&root, rel)?;
    if std::fs::symlink_metadata(&full).is_err() {
        return Err(format!("nothing to reveal: {rel}"));
    }
    reveal_os(&full)
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

/// `root` is null while no vault is open. `exeDir` is the folder the chooser suggests: the
/// executable's own, or the folder holding `Ose.app` on macOS. `build` is the CI stamp
/// `{sha, short, date}`, null for a local build (update.rs).
///
/// The three origins (round four, docs/KERNEL.md) are here rather than guessed in the page,
/// because the spelling is the platform's: `http://ose.localhost` on Windows and
/// `ose://localhost` on macOS and Linux. Nothing in a rice ever writes one down.
fn platform_info(ctx: &Ctx) -> Value {
    json!({
        "os": os_name(),
        "version": env!("CARGO_PKG_VERSION"),
        "build": crate::update::build_json(),
        "exe": std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
        "exeDir": crate::vault::exe_dir().map(|p| p.display().to_string()),
        "root": ctx.st.root().map(|p| p.display().to_string()),
        "api": crate::rice::API,
        "kernelOrigin": crate::rice::kernel_origin(),
        "appOrigin": crate::rice::app_origin(),
        "vaultOrigin": crate::rice::vault_origin(),
    })
}

fn os_name() -> &'static str {
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
}
