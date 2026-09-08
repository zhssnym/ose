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
    let full = crate::vault::resolve(&ctx.st.root, rel)?;
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

fn platform_info(ctx: &Ctx) -> Value {
    json!({
        "os": os_name(),
        "version": env!("CARGO_PKG_VERSION"),
        "exe": std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
        "root": ctx.st.root.display().to_string(),
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
