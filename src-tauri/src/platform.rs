//! Platform integration: opening external URLs, revealing a file in the file manager, and
//! locating the Claude Code CLI (which `pty.rs` runs and the settings pane reports).
//!
//! Ported from `host/Bridge.cs` (`OpenExternal`, `Reveal`) and `host/ClaudeProcess.cs` (`Probe`).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::{arg_str, Ctx};

/// How long `claude --version` may take before the probe gives up.
const VERSION_TIMEOUT: Duration = Duration::from_secs(30);

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
        "claudeInfo" => Some(Ok(claude_info())),
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

// ---- claude binary lookup -------------------------------------------------

/// `OSE_CLAUDE`, then PATH, then the usual install locations, then (macOS only) a login
/// shell, because a bundled .app inherits a minimal PATH from launchd.
pub fn find_claude() -> Option<PathBuf> {
    if let Some(v) = std::env::var_os("OSE_CLAUDE") {
        let p = PathBuf::from(v);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(p) = find_on_path("claude") {
        return Some(p);
    }
    if let Some(p) = fallback_candidates().into_iter().find(|c| c.is_file()) {
        return Some(p);
    }
    #[cfg(target_os = "macos")]
    if let Some(p) = zsh_login_lookup() {
        return Some(p);
    }
    None
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    // On Windows only .exe is useful: CreateProcess cannot run a .cmd or .bat shim directly,
    // which is why the .NET host preferred the .exe out of `where claude` too.
    let exts: &[&str] = if cfg!(windows) { &[".exe"] } else { &[""] };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for ext in exts {
            let cand = dir.join(format!("{name}{ext}"));
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

fn fallback_candidates() -> Vec<PathBuf> {
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let mut v = Vec::new();
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".local").join("bin").join(exe));
        if !cfg!(windows) {
            v.push(PathBuf::from("/opt/homebrew/bin/claude"));
            v.push(PathBuf::from("/usr/local/bin/claude"));
        }
        v.push(home.join(".npm-global").join("bin").join(exe));
    } else if !cfg!(windows) {
        v.push(PathBuf::from("/opt/homebrew/bin/claude"));
        v.push(PathBuf::from("/usr/local/bin/claude"));
    }
    v
}

#[cfg(target_os = "macos")]
fn zsh_login_lookup() -> Option<PathBuf> {
    let out = Command::new("zsh")
        .args(["-lc", "command -v claude"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let p = PathBuf::from(line);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

// ---- claudeInfo -----------------------------------------------------------

struct Cli {
    path: PathBuf,
    version: Option<String>,
}

static CLI: OnceLock<Option<Cli>> = OnceLock::new();

/// Located once per run, `--version` included. `pty.rs` calls `find_claude` directly; this is
/// only the report the settings pane and the empty state show.
fn claude_info() -> Value {
    let cli = CLI.get_or_init(|| {
        let path = find_claude()?;
        let version = run_capture(&path, &["--version"], VERSION_TIMEOUT)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Some(Cli { path, version })
    });
    match cli {
        Some(c) => json!({ "path": c.path.display().to_string(), "version": c.version }),
        None => json!({ "path": Value::Null, "version": Value::Null }),
    }
}

/// Runs a short command and returns its stdout, or `None` on failure or timeout.
fn run_capture(exe: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = quiet_command(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = child.wait_with_output().ok()?;
                return status
                    .success()
                    .then(|| String::from_utf8_lossy(&out.stdout).into_owned());
            }
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return None;
        }
        thread::sleep(Duration::from_millis(25));
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
