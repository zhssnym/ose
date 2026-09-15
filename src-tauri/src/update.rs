//! Self-update for a portable app: no installer, ever. Every push to `main` publishes the
//! rolling prerelease `latest` with one asset per platform, built from one commit; "newer"
//! means "a different commit than the one this executable was stamped with". The check reads
//! the release API, the download streams the asset to a file beside the executable and
//! verifies it, and the swap renames the running binary out of the way and the new one into
//! place, then relaunches. Everything runs on a worker thread through `spawn_blocking`; the
//! main thread never waits on the network.
//!
//! The webview cannot do the download itself: GitHub's signed asset host sends no CORS header,
//! so a `fetch` from the page is refused before a byte arrives. Hence the small blocking
//! client here (`ureq`, rustls) rather than a browser request.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::Digest as _;
use tauri::{Emitter as _, Manager as _};

use crate::{log_line, AppState};

const REPO: &str = "zhssnym/ose";
const RELEASE_URL: &str = "https://api.github.com/repos/zhssnym/ose/releases/tags/latest";
/// Newest first, and no more than this: the dialog lists subjects, not a changelog.
const MAX_COMMITS: usize = 20;
/// One progress event per this many bytes: enough for a moving number, few enough to be free.
const PROGRESS_STEP: u64 = 256 * 1024;
/// The webview gets this long to paint `installing…` and settle its last writes before the
/// process goes away under it.
const EXIT_GRACE: Duration = Duration::from_millis(400);

// ---- the stamp ------------------------------------------------------------

/// The commit and day this executable was built from, stamped by CI (`OSE_BUILD_SHA`,
/// `OSE_BUILD_DATE` in build.yml, read at compile time). A local build has none and is a
/// "dev build": it never checks, because there is no commit to compare with.
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

/// `{sha, short, date}` for `platform` and `updateCheck`, `null` for a dev build.
pub fn build_json() -> Value {
    match build_info() {
        Some(b) => json!({ "sha": b.sha, "short": b.short, "date": b.date }),
        None => Value::Null,
    }
}

/// `ose 0.4.0 (a45404e, 2026-09-15)` or `ose 0.4.0 (dev build)`: the `--version` line. The
/// name is the app's, not the file's: a copy on disk still called `os.exe` prints `ose` too,
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

// ---- where things are ------------------------------------------------------

/// The files the update touches, all beside the executable: on Windows beside `ose.exe`, on
/// macOS beside the `Ose.app` bundle (the folder that holds it, never inside it).
///
/// Every name here is derived from the running executable's **own** file name, whatever it is.
/// A copy still called `os.exe` (0.3.x, renamed in 0.4.0) swaps `os.exe` -> `os.exe.old` and
/// `os.exe.new` -> `os.exe` and stays `os.exe`: a swap never renames the file it found, so a
/// shortcut, a script or a scheduled task naming the old file keeps working.
#[derive(Clone, Debug)]
pub struct Layout {
    /// The folder everything lives in.
    pub dir: PathBuf,
    /// `ose.exe` (or `os.exe`), or the `Ose.app` (or `os.app`) bundle folder.
    pub target: PathBuf,
    /// Where the download lands: `<name>.new`, or `ose-update.zip`.
    pub incoming: PathBuf,
    /// The previous build after a swap: `<name>.old`.
    pub old: PathBuf,
}

/// The layout for the running executable. `None` when the executable has no parent folder,
/// which no real launch produces.
pub fn layout() -> Option<Layout> {
    let exe = std::env::current_exe().ok()?;
    layout_for(&exe)
}

pub fn layout_for(exe: &Path) -> Option<Layout> {
    if cfg!(target_os = "macos") {
        if let Some(bundle) = exe
            .ancestors()
            .skip(1)
            .find(|a| a.extension().map(|e| e.eq_ignore_ascii_case("app")).unwrap_or(false))
        {
            let dir = bundle.parent()?.to_path_buf();
            let name = bundle.file_name()?.to_string_lossy().to_string();
            return Some(Layout {
                target: bundle.to_path_buf(),
                incoming: dir.join(ZIP),
                old: dir.join(format!("{name}.old")),
                dir,
            });
        }
    }
    let dir = exe.parent()?.to_path_buf();
    let name = exe.file_name()?.to_string_lossy().to_string();
    Some(Layout {
        target: exe.to_path_buf(),
        incoming: dir.join(format!("{name}.new")),
        old: dir.join(format!("{name}.old")),
        dir,
    })
}

/// The asset names this platform accepts, best first. Two of each for the 0.3.x -> 0.4.0
/// rename: CI publishes `ose.exe` and, for the transition, `os.exe` with the same bytes, so a
/// 0.3.x build in the field still finds the name it knows and a 0.4.0 build prefers the new
/// one. Empty where no build is published.
pub fn asset_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["ose.exe", "os.exe"]
    } else if cfg!(target_os = "macos") {
        &["ose-macos-arm64.zip", "os-macos-arm64.zip"]
    } else {
        &[]
    }
}

/// The two temp names the update writes itself, as opposed to the ones it derives from the
/// running file. The `os-update.*` pair a 0.3.x build wrote is still cleaned up.
const ZIP: &str = "ose-update.zip";
const TMP: &str = "ose-update-tmp";

// ---- cleanup on start ------------------------------------------------------

/// Deletes what an update leaves behind once the new build is running: the previous
/// executable (`<name>.old`), and a download an interrupted run never applied (`<name>.new`,
/// `os-update.zip`, `os-update-tmp`). It runs only after a start has succeeded, which is the
/// safety net: a build that will not start leaves `.old` for a manual rename back.
///
/// On Windows the old executable stays locked until the process that launched us has exited,
/// which is usually a few milliseconds after it spawned us; each removal is retried for a
/// while before it is given up on (the next start tries again). Returns what was removed.
pub fn finish_previous(dir: &Path, name: &str) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    let candidates = [
        dir.join(format!("{name}.old")),
        dir.join(format!("{name}.new")),
        dir.join(ZIP),
        dir.join(TMP),
        // What a 0.3.x build left behind before the rename.
        dir.join("os-update.zip"),
        dir.join("os-update-tmp"),
    ];
    for path in candidates {
        if fs::symlink_metadata(&path).is_err() {
            continue;
        }
        if remove_with_retries(&path) {
            removed.push(path);
        }
    }
    removed
}

fn remove_with_retries(path: &Path) -> bool {
    const TRIES: u32 = 20;
    for attempt in 0..TRIES {
        let is_dir = fs::symlink_metadata(path).map(|m| m.is_dir()).unwrap_or(false);
        let r = if is_dir { fs::remove_dir_all(path) } else { fs::remove_file(path) };
        match r {
            Ok(()) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) if attempt + 1 < TRIES => std::thread::sleep(Duration::from_millis(250)),
            Err(_) => return false,
        }
    }
    false
}

/// `finish_previous` for the running executable, on a thread so a locked `.old` never delays
/// the window. Logs what it cleaned.
pub fn finish_previous_in_background(app: tauri::AppHandle) {
    let Some(lay) = layout() else { return };
    let name = lay.target.file_name().map(|n| n.to_string_lossy().to_string());
    let Some(name) = name else { return };
    std::thread::spawn(move || {
        let removed = finish_previous(&lay.dir, &name);
        if !removed.is_empty() {
            let st = app.state::<AppState>();
            let names: Vec<String> = removed
                .iter()
                .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
                .collect();
            log_line(st.inner(), &format!("update: cleaned up previous build ({})", names.join(", ")));
        }
    });
}

// ---- rpc ------------------------------------------------------------------

/// `updateCheck`, `updateDownload`, `updateApply`. Each runs on a blocking worker; `None`
/// means "not mine". Errors are plain strings.
pub async fn handle(app: &tauri::AppHandle, cmd: &str) -> Option<Result<Value, String>> {
    let app = app.clone();
    let r = match cmd {
        "updateCheck" => tauri::async_runtime::spawn_blocking(move || Ok(check(&app))).await,
        "updateDownload" => tauri::async_runtime::spawn_blocking(move || download(&app)).await,
        "updateApply" => tauri::async_runtime::spawn_blocking(move || apply(&app)).await,
        _ => return None,
    };
    Some(r.unwrap_or_else(|e| Err(format!("update worker failed: {e}"))))
}

// ---- check ----------------------------------------------------------------

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(format!("os-editor/{}", env!("CARGO_PKG_VERSION")))
        .timeout_global(Some(timeout))
        // 404 and friends are answers, not failures: the release is deleted for a few seconds
        // while CI recreates it, and that must read as "nothing yet", not as an error.
        .http_status_as_error(false)
        .build()
        .into()
}

fn get_json(agent: &ureq::Agent, url: &str) -> Result<(u16, Value), String> {
    let mut resp = agent
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
    let value = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    Ok((status, value))
}

#[derive(Debug)]
struct Latest {
    sha: String,
    published_at: String,
    asset: Option<Asset>,
}

#[derive(Clone, Debug)]
struct Asset {
    name: String,
    size: u64,
    url: String,
    /// `sha256:<hex>` as the API gives it, when it gives one.
    digest: Option<String>,
}

impl Asset {
    fn json(&self) -> Value {
        json!({ "name": self.name, "size": self.size, "url": self.url, "digest": self.digest })
    }
}

/// The `latest` release as `{sha, publishedAt, asset}`. `Ok(None)` is a 404: no release right
/// now. A release whose `target_commitish` is not a commit (a branch name) cannot be compared
/// with anything and is reported as an error rather than as "behind".
fn fetch_latest(agent: &ureq::Agent) -> Result<Option<Latest>, String> {
    let (status, v) = get_json(agent, RELEASE_URL)?;
    if status == 404 {
        return Ok(None);
    }
    if status != 200 {
        let msg = v["message"].as_str().unwrap_or("").to_string();
        return Err(format!("release lookup: http {status}{}", if msg.is_empty() { String::new() } else { format!(" ({msg})") }));
    }
    let sha = v["target_commitish"].as_str().unwrap_or("").to_string();
    if !is_sha(&sha) {
        return Err(format!("release lookup: target_commitish is not a commit ({sha:?})"));
    }
    let empty = Vec::new();
    let assets = v["assets"].as_array().unwrap_or(&empty);
    let read = |a: &Value| -> Option<Asset> {
        Some(Asset {
            name: a["name"].as_str()?.to_string(),
            size: a["size"].as_u64().unwrap_or(0),
            url: a["browser_download_url"].as_str()?.to_string(),
            digest: a["digest"].as_str().map(str::to_string).filter(|d| d.starts_with("sha256:")),
        })
    };
    // Best name first, so a release carrying both `ose.exe` and the transitional `os.exe`
    // gives this build the new one.
    let asset = asset_names()
        .iter()
        .find_map(|wanted| assets.iter().find(|a| a["name"].as_str() == Some(*wanted)).and_then(read));
    Ok(Some(Latest {
        sha,
        published_at: v["published_at"].as_str().unwrap_or("").to_string(),
        asset,
    }))
}

/// The commits between this build and the release, newest first, at most `MAX_COMMITS`. Any
/// failure is an empty list: the subjects are a courtesy, the check itself does not depend
/// on them.
fn fetch_commits(agent: &ureq::Agent, from: &str, to: &str) -> Vec<Value> {
    let url = format!("https://api.github.com/repos/{REPO}/compare/{from}...{to}");
    let Ok((200, v)) = get_json(agent, &url) else { return Vec::new() };
    let Some(list) = v["commits"].as_array() else { return Vec::new() };
    list.iter()
        .rev()
        .take(MAX_COMMITS)
        .filter_map(|c| {
            let sha = c["sha"].as_str()?;
            let message = c["commit"]["message"].as_str().unwrap_or("");
            Some(json!({
                "short": &sha[..sha.len().min(7)],
                "subject": message.lines().next().unwrap_or("").trim(),
                "date": c["commit"]["committer"]["date"].as_str().unwrap_or(""),
            }))
        })
        .collect()
}

/// `updateCheck`. Never throws: a network failure is `error`, a missing release is `latest:
/// null`, and a dev build answers at once without a request.
fn check(app: &tauri::AppHandle) -> Value {
    let st = app.state::<AppState>();
    let st = st.inner();
    let Some(current) = build_info() else {
        return json!({ "current": null, "latest": null, "behind": false, "commits": [], "asset": null, "error": null });
    };
    let current_json = build_json();
    let agent = agent(Duration::from_secs(10));
    match fetch_latest(&agent) {
        Ok(None) => {
            log_line(st, "update: no release right now (404)");
            json!({ "current": current_json, "latest": null, "behind": false, "commits": [], "asset": null, "error": null })
        }
        Ok(Some(latest)) => {
            let behind = latest.sha != current.sha;
            let commits = if behind { fetch_commits(&agent, &current.sha, &latest.sha) } else { Vec::new() };
            if behind {
                log_line(st, &format!("update: {} → {} ({} commits listed)", current.short, &latest.sha[..7], commits.len()));
            } else {
                log_line(st, &format!("update: up to date ({})", current.short));
            }
            json!({
                "current": current_json,
                "latest": { "sha": latest.sha, "short": &latest.sha[..7], "publishedAt": latest.published_at },
                "behind": behind,
                "commits": commits,
                "asset": latest.asset.as_ref().map(Asset::json),
                "error": null,
            })
        }
        Err(e) => {
            log_line(st, &format!("update: check failed: {e}"));
            json!({ "current": current_json, "latest": null, "behind": false, "commits": [], "asset": null, "error": e })
        }
    }
}

/// `ose --update`: the whole loop with no window — check, download when behind, swap, relaunch.
/// Exit 0 when already up to date; on a successful swap `apply` exits after spawning the new
/// build, which runs this same argv, logs itself as up to date and exits 0. Exit 1 on any
/// failure, with the reason in the log. This is what proves the assembled loop on a machine
/// where nobody can click the dialog, and what a script uses to update in place.
pub fn run_headless(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let st = app.state::<AppState>();
        let st = st.inner();
        let v = check(&app);
        if let Some(e) = v["error"].as_str() {
            log_line(st, &format!("update: --update stopped at the check: {e}"));
            app.exit(1);
            return;
        }
        if !v["behind"].as_bool().unwrap_or(false) {
            // The relaunched build lands here within a second of the swap, while the build it
            // replaced may still hold `.old` open; the background cleanup would be cut off by
            // the exit below, so wait for it here (its retries are bounded).
            if let Some(lay) = layout() {
                let name = lay.target.file_name().map(|n| n.to_string_lossy().to_string());
                let removed = name.map(|n| finish_previous(&lay.dir, &n)).unwrap_or_default();
                if !removed.is_empty() {
                    let names: Vec<String> = removed
                        .iter()
                        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
                        .collect();
                    log_line(st, &format!("update: cleaned up previous build ({})", names.join(", ")));
                }
            }
            log_line(st, "update: --update: nothing to do");
            app.exit(0);
            return;
        }
        if let Err(e) = download(&app) {
            log_line(st, &format!("update: --update stopped at the download: {e}"));
            app.exit(1);
            return;
        }
        if let Err(e) = apply(&app) {
            log_line(st, &format!("update: --update stopped at the swap: {e}"));
            app.exit(1);
        }
    });
}

// ---- download -------------------------------------------------------------

static DOWNLOADING: AtomicBool = AtomicBool::new(false);
/// The download `apply` may install: its path and size, set only after verification, so a
/// half-written or stale `.new` is never swapped in.
static READY: Mutex<Option<(PathBuf, u64)>> = Mutex::new(None);

fn emit(app: &tauri::AppHandle, payload: Value) {
    let _ = app.emit("update", payload);
}

/// `updateDownload`: the release's asset for this platform, streamed to `incoming`, then
/// checked against the size and, when the API gave one, the sha256 digest. One at a time.
fn download(app: &tauri::AppHandle) -> Result<Value, String> {
    if DOWNLOADING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("already downloading".to_string());
    }
    let r = download_inner(app);
    DOWNLOADING.store(false, Ordering::Release);
    r
}

fn download_inner(app: &tauri::AppHandle) -> Result<Value, String> {
    let st = app.state::<AppState>();
    let st = st.inner();
    *READY.lock().unwrap_or_else(|p| p.into_inner()) = None;
    if build_info().is_none() {
        return Err("a dev build cannot update itself".to_string());
    }
    let lay = layout().ok_or("cannot locate the executable")?;
    let lookup = agent(Duration::from_secs(10));
    let latest = fetch_latest(&lookup)?.ok_or("no release right now")?;
    let asset = latest.asset.ok_or_else(|| match asset_names() {
        [] => "no build is published for this platform".to_string(),
        names => format!("the release has no {}", names.join(" and no ")),
    })?;
    log_line(st, &format!("update: downloading {} ({} bytes) to {}", asset.name, asset.size, lay.incoming.display()));

    let r = stream_to_file(app, &asset, &lay.incoming);
    if let Err(e) = &r {
        let _ = fs::remove_file(&lay.incoming);
        log_line(st, &format!("update: download failed: {e}"));
        return Err(e.clone());
    }
    let verified = r?;
    *READY.lock().unwrap_or_else(|p| p.into_inner()) = Some((lay.incoming.clone(), asset.size));
    log_line(st, &format!("update: downloaded and {}", if verified { "verified" } else { "size-checked (no digest published)" }));
    Ok(json!({ "path": lay.incoming.display().to_string(), "bytes": asset.size, "verified": verified }))
}

/// Streams the asset into `dest`, emitting progress, and returns whether a digest confirmed
/// it. Size and digest mismatches are errors: a truncated or altered binary must never be
/// the one that gets swapped in.
fn stream_to_file(app: &tauri::AppHandle, asset: &Asset, dest: &Path) -> Result<bool, String> {
    // Connect and headers on the usual budget; the body gets minutes, because an 8 MB file on
    // a slow link must not be cut off by a timeout meant for an API call.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .user_agent(format!("os-editor/{}", env!("CARGO_PKG_VERSION")))
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(20)))
        .timeout_recv_body(Some(Duration::from_secs(600)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut resp = agent.get(&asset.url).call().map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(format!("download: http {status}"));
    }
    let total = asset.size;
    let mut file = fs::File::create(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut reader = resp.body_mut().with_config().limit(total.saturating_add(1)).reader();
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut received: u64 = 0;
    let mut last_report: u64 = 0;
    emit(app, json!({ "phase": "download", "received": 0, "total": total }));
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("download: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("{}: {e}", dest.display()))?;
        hasher.update(&buf[..n]);
        received += n as u64;
        if received - last_report >= PROGRESS_STEP {
            last_report = received;
            emit(app, json!({ "phase": "download", "received": received, "total": total }));
        }
    }
    file.flush().map_err(|e| format!("{}: {e}", dest.display()))?;
    drop(file);
    emit(app, json!({ "phase": "download", "received": received, "total": total }));
    if received != total {
        return Err(format!("download: got {received} bytes, expected {total}"));
    }
    match &asset.digest {
        Some(d) => {
            let want = d.trim_start_matches("sha256:").to_ascii_lowercase();
            let got = hex(&hasher.finalize());
            if got != want {
                return Err("download: sha256 does not match the release".to_string());
            }
            Ok(true)
        }
        None => Ok(false),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---- apply ----------------------------------------------------------------

/// `updateApply`: the swap for this platform, the relaunch, then the exit. Refused while a
/// download runs or when none has been verified in this run. Only returns on failure; on
/// success the process is gone.
fn apply(app: &tauri::AppHandle) -> Result<Value, String> {
    let st = app.state::<AppState>();
    let st = st.inner();
    if DOWNLOADING.load(Ordering::Acquire) {
        return Err("download in progress".to_string());
    }
    let lay = layout().ok_or("cannot locate the executable")?;
    let ready = READY.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let Some((path, size)) = ready else {
        return Err("nothing downloaded".to_string());
    };
    let on_disk = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if path != lay.incoming || on_disk != size {
        *READY.lock().unwrap_or_else(|p| p.into_inner()) = None;
        return Err("the download is no longer intact; download again".to_string());
    }

    emit(app, json!({ "phase": "apply" }));
    log_line(st, "update: applying");
    let args: Vec<String> = std::env::args().skip(1).collect();

    #[cfg(windows)]
    let launched = swap_windows(&lay, &args, true);
    #[cfg(target_os = "macos")]
    let launched = swap_macos(&lay, &args, true);
    #[cfg(not(any(windows, target_os = "macos")))]
    let launched: Result<PathBuf, String> = Err("self-update is not available on this platform".to_string());

    let launched = launched?;
    *READY.lock().unwrap_or_else(|p| p.into_inner()) = None;
    log_line(st, &format!("update: relaunched {}; exiting", launched.display()));

    // Window geometry and theme are written on the ordinary close path, which an exit from a
    // worker thread would skip; the binary supplies the same save as a hook.
    if let Some(save) = st.before_restart {
        save(app);
    }
    std::thread::sleep(EXIT_GRACE);
    app.exit(0);
    // `exit` asks the event loop to wind down; if it never gets there, do not stay alive as
    // the old build beside the new one.
    std::thread::sleep(Duration::from_secs(2));
    std::process::exit(0);
}

/// Windows: `<name>.exe` → `<name>.exe.old` (renaming a running executable is allowed;
/// deleting or overwriting it is not), then `<name>.exe.new` → `<name>.exe`, then the new
/// executable is started with `args`. `<name>` is whatever the running file is called, so a
/// copy still named `os.exe` stays `os.exe`. Returns the path of the executable now in place.
/// A failed second rename puts the old name back so the folder is never left without one.
/// `relaunch: false` skips the spawn so a test can drive the swap on a copy.
#[cfg(windows)]
pub fn swap_windows(lay: &Layout, args: &[String], relaunch: bool) -> Result<PathBuf, String> {
    let (exe, new, old) = (&lay.target, &lay.incoming, &lay.old);
    if !new.is_file() {
        return Err(format!("nothing to install at {}", new.display()));
    }
    if old.exists() && !remove_with_retries(old) {
        return Err(format!("cannot remove the previous build at {}", old.display()));
    }
    fs::rename(exe, old).map_err(|e| format!("rename {} → {}: {e}", exe.display(), old.display()))?;
    if let Err(e) = fs::rename(new, exe) {
        let _ = fs::rename(old, exe);
        return Err(format!("rename {} → {}: {e}", new.display(), exe.display()));
    }
    if relaunch {
        relaunch_windows(exe, args)?;
    }
    Ok(exe.clone())
}

/// The argv the relaunched build gets: the original one, minus any `--after-pid` a previous
/// swap left in it, plus this process's pid, which the new build waits out before it starts
/// (main.rs). Without that wait the single-instance plugin sees the old build still alive,
/// hands the launch over to it, and the new build never runs.
pub fn relaunch_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len() + 2);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--after-pid" {
            it.next();
            continue;
        }
        out.push(a.clone());
    }
    out.push("--after-pid".to_string());
    out.push(std::process::id().to_string());
    out
}

/// True while a process with that id is alive. `tasklist` on Windows, `kill -0` elsewhere:
/// no dependency, called a few times a second for at most a few seconds.
pub fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = crate::platform::quiet_command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output();
        match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")),
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// The build that spawned us did not say its pid (it predates `--after-pid`), but it left
/// `.old` beside us, so it is exiting right now: wait until `.old` can be removed, which on
/// Windows is the moment the old image is unlocked, or a short grace period elsewhere.
pub fn wait_for_previous_without_pid() {
    let Some(lay) = layout() else { return };
    if !lay.old.exists() {
        return;
    }
    #[cfg(windows)]
    {
        let start = Instant::now();
        while fs::remove_file(&lay.old).is_err() && start.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    #[cfg(not(windows))]
    std::thread::sleep(Duration::from_millis(1500));
}

/// Waits until `pid` is gone, or `timeout` has passed. Returns whether it is gone.
pub fn wait_for_exit(pid: u32, timeout: Duration) -> bool {
    let start = Instant::now();
    while process_alive(pid) {
        if start.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    true
}

#[cfg(windows)]
fn relaunch_windows(exe: &Path, args: &[String]) -> Result<(), String> {
    use std::os::windows::process::CommandExt as _;
    // Its own process group and no console of ours: the child must outlive this process and
    // must not be tied to whatever started it.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    Command::new(exe)
        .args(relaunch_args(args))
        .creation_flags(CREATE_NEW_PROCESS_GROUP)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(drop)
        .map_err(|e| format!("installed, but could not start {}: {e}", exe.display()))
}

/// macOS: the zip is unpacked beside the bundle with `ditto` (the tool that made it, so the
/// bundle structure and resource forks survive), the running bundle is renamed to `.old`, the
/// unpacked one moved into its place under the running bundle's own name, the temp folder and
/// the zip removed, then `open -n` on the new bundle. So a copy still called `os.app` stays
/// `os.app` even though the zip holds `Ose.app`. A failure after the first rename restores
/// `.old`.
#[cfg(target_os = "macos")]
pub fn swap_macos(lay: &Layout, args: &[String], relaunch: bool) -> Result<PathBuf, String> {
    let (bundle, zip, old) = (&lay.target, &lay.incoming, &lay.old);
    let tmp = lay.dir.join(TMP);
    if !zip.is_file() {
        return Err(format!("nothing to install at {}", zip.display()));
    }
    let _ = fs::remove_dir_all(&tmp);
    let out = Command::new("/usr/bin/ditto")
        .arg("-x")
        .arg("-k")
        .arg(zip)
        .arg(&tmp)
        .output()
        .map_err(|e| format!("ditto: {e}"))?;
    if !out.status.success() {
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("ditto failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let unpacked = find_bundle(&tmp).ok_or_else(|| {
        let _ = fs::remove_dir_all(&tmp);
        "the zip holds no .app bundle".to_string()
    })?;
    if old.exists() && !remove_with_retries(old) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("cannot remove the previous build at {}", old.display()));
    }
    if bundle.exists() {
        fs::rename(bundle, old).map_err(|e| format!("rename {} → {}: {e}", bundle.display(), old.display()))?;
    }
    if let Err(e) = fs::rename(&unpacked, bundle) {
        let _ = fs::rename(old, bundle);
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("rename {} → {}: {e}", unpacked.display(), bundle.display()));
    }
    let _ = fs::remove_dir_all(&tmp);
    let _ = fs::remove_file(zip);
    if relaunch {
        let mut c = Command::new("/usr/bin/open");
        c.arg("-n").arg(bundle);
        c.arg("--args").args(relaunch_args(args));
        c.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let status = c.status().map_err(|e| format!("installed, but could not start {}: {e}", bundle.display()))?;
        if !status.success() {
            return Err(format!("installed, but `open` failed with {status}"));
        }
    }
    Ok(bundle.clone())
}

/// `Ose.app` (or the older `os.app`) at the top of the unpacked folder, or one level down
/// (ditto `--keepParent` puts the bundle at the top; a zip made another way may wrap it in a
/// folder). Any `.app` in there is accepted, so neither name is load-bearing.
#[cfg(target_os = "macos")]
fn find_bundle(tmp: &Path) -> Option<PathBuf> {
    let is_app = |p: &Path| p.is_dir() && p.extension().map(|e| e.eq_ignore_ascii_case("app")).unwrap_or(false);
    for name in ["Ose.app", "os.app"] {
        let direct = tmp.join(name);
        if is_app(&direct) {
            return Some(direct);
        }
    }
    let mut found = None;
    for entry in fs::read_dir(tmp).ok()?.flatten() {
        let p = entry.path();
        if is_app(&p) {
            return Some(p);
        }
        if p.is_dir() {
            for inner in fs::read_dir(&p).ok()?.flatten() {
                let q = inner.path();
                if is_app(&q) {
                    found = Some(q);
                }
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    #[test]
    fn process_alive_knows_itself_and_a_ghost() {
        assert!(super::process_alive(std::process::id()));
        assert!(!super::process_alive(4_000_000));
    }

    #[test]
    fn relaunch_args_replaces_the_pid() {
        let a = super::relaunch_args(&["--root".into(), "x".into(), "--after-pid".into(), "7".into()]);
        assert_eq!(a[..2], ["--root".to_string(), "x".to_string()]);
        assert_eq!(a[2], "--after-pid");
        assert_eq!(a[3], std::process::id().to_string());
    }

    use super::*;

    #[test]
    fn version_line_shape() {
        let line = version_line();
        assert!(line.starts_with(concat!("ose ", env!("CARGO_PKG_VERSION"), " (")), "{line}");
        assert!(line.ends_with(')'), "{line}");
    }

    /// The rename: the new asset name is preferred, the old one still accepted, and a build
    /// running under the old file name keeps it through a swap.
    #[test]
    fn both_asset_names_are_accepted() {
        let names = asset_names();
        if cfg!(windows) {
            assert_eq!(names, ["ose.exe", "os.exe"]);
        } else if cfg!(target_os = "macos") {
            assert_eq!(names, ["ose-macos-arm64.zip", "os-macos-arm64.zip"]);
        } else {
            assert!(names.is_empty());
        }
    }

    #[test]
    fn a_swap_keeps_the_name_it_found() {
        let old = if cfg!(windows) { Path::new("C:\\vault\\os.exe") } else { Path::new("/vault/os.exe") };
        let lay = layout_for(old).unwrap();
        assert_eq!(lay.target.file_name().unwrap(), "os.exe");
        assert_eq!(lay.incoming.file_name().unwrap(), "os.exe.new");
        assert_eq!(lay.old.file_name().unwrap(), "os.exe.old");
    }

    #[test]
    fn sha_check() {
        assert!(is_sha("a7d42de29e5383305cc3e95773b8c255e1395e12"));
        assert!(!is_sha("main"));
        assert!(!is_sha("a7d42de"));
    }

    #[test]
    fn hex_encodes() {
        assert_eq!(hex(&[0, 255, 16]), "00ff10");
    }

    #[test]
    fn layout_beside_the_exe() {
        let exe = if cfg!(windows) { Path::new("C:\\vault\\ose.exe") } else { Path::new("/vault/ose.exe") };
        let lay = layout_for(exe).unwrap();
        assert_eq!(lay.dir, exe.parent().unwrap());
        assert_eq!(lay.incoming.file_name().unwrap(), "ose.exe.new");
        assert_eq!(lay.old.file_name().unwrap(), "ose.exe.old");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn layout_beside_the_bundle() {
        let lay = layout_for(Path::new("/Applications/Ose.app/Contents/MacOS/ose")).unwrap();
        assert_eq!(lay.dir, Path::new("/Applications"));
        assert_eq!(lay.target, Path::new("/Applications/Ose.app"));
        assert_eq!(lay.incoming, Path::new("/Applications/ose-update.zip"));
        assert_eq!(lay.old, Path::new("/Applications/Ose.app.old"));
        // A 0.3.x bundle keeps its own name through the swap.
        let old = layout_for(Path::new("/Applications/os.app/Contents/MacOS/os")).unwrap();
        assert_eq!(old.target, Path::new("/Applications/os.app"));
        assert_eq!(old.old, Path::new("/Applications/os.app.old"));
    }

    #[test]
    fn finish_previous_removes_leftovers() {
        let dir = std::env::temp_dir().join(format!("ose-finish-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("ose.exe.old"), b"old").unwrap();
        fs::write(dir.join("ose.exe.new"), b"new").unwrap();
        fs::create_dir_all(dir.join("ose-update-tmp")).unwrap();
        // What a 0.3.x build left behind: cleaned up too.
        fs::create_dir_all(dir.join("os-update-tmp")).unwrap();
        fs::write(dir.join("ose.exe"), b"current").unwrap();
        let removed = finish_previous(&dir, "ose.exe");
        assert_eq!(removed.len(), 4, "{removed:?}");
        assert!(dir.join("ose.exe").is_file());
        assert!(!dir.join("ose.exe.old").exists());
        assert!(!dir.join("ose-update-tmp").exists());
        assert!(!dir.join("os-update-tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
