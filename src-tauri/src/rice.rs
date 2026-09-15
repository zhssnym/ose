//! The two new origins and the loader that decides what the window shows.
//!
//! - `ose` serves the kernel's embedded assets (`dist-kernel/`, `frontendDist` in
//!   tauri.conf.json): kernel.js, editor.js, ui.js, md.js, the two stylesheets, the fallback
//!   page and the self-test page. Read-only, CORS open, never cached.
//! - `app` serves the rice — `<vault>/.ose/app`, or the folder given by `--rice <dir>` — as
//!   plain files, with `index.html` rewritten on the way out so that no file of a rice ever
//!   spells an origin: the import map and the two stylesheet links are inserted by the host.
//!
//! Tauri maps a custom scheme to `http://<scheme>.localhost/...` on Windows and to
//! `<scheme>://localhost/...` on macOS and Linux; `origins()` is the one place that knows.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{Manager as _, Runtime};

use crate::{log_line, protocol, vault, AppState, Ctx};

/// The `ose.api` this kernel implements. A rice or a module asking for a later one is refused.
pub const API: u64 = 1;

/// How long the window may sit on the rice without the kernel saying it is up before the host
/// decides the rice is broken and shows the fallback page instead.
const FALLBACK_AFTER: Duration = Duration::from_secs(5);

/// `--rice <dir>` and `--no-rice`, settled once at startup and read on every navigation.
#[derive(Clone, Debug, Default)]
pub struct Options {
    pub arg: Option<PathBuf>,
    pub no_rice: bool,
}

/// The armed fallback timer's generation, or 0 for "nothing armed". Every navigation to a rice
/// takes the next number; `riceReady` and `riceFailed` store 0 back, which disarms it.
static ARMED: AtomicU64 = AtomicU64::new(0);
static NEXT: AtomicU64 = AtomicU64::new(1);

// ---- origins ---------------------------------------------------------------

/// `http://<scheme>.localhost` on Windows, `<scheme>://localhost` everywhere else. No trailing
/// slash, so `format!("{}/kernel.js", origin(..))` is the whole rule a caller needs.
pub fn origin(scheme: &str) -> String {
    if cfg!(windows) {
        format!("http://{scheme}.localhost")
    } else {
        format!("{scheme}://localhost")
    }
}

pub fn kernel_origin() -> String {
    origin("ose")
}
pub fn app_origin() -> String {
    origin("app")
}
pub fn vault_origin() -> String {
    origin("vault")
}

// ---- where the rice is -----------------------------------------------------

/// The rice folder and where it came from: `--rice <dir>` wins, then `<vault>/.ose/app`, then
/// nothing at all (no vault and no argument).
pub fn resolve(st: &AppState) -> (Option<PathBuf>, &'static str) {
    if let Some(dir) = st.rice_options().arg {
        return (Some(vault::normalize(&dir)), "arg");
    }
    match st.root() {
        Some(root) => (Some(root.join(".ose").join("app")), "vault"),
        None => (None, "none"),
    }
}

/// What the loader decided and why, which is also what `riceInfo` answers.
#[derive(Clone, Debug)]
pub struct Status {
    pub dir: Option<PathBuf>,
    pub source: &'static str,
    /// A rice is there and this kernel can load it.
    pub present: bool,
    /// `--no-rice`, or Shift held at launch: load the fallback page whatever is there.
    pub disabled: bool,
    /// `cockpit.json`'s `requires`, or `None` when there is no `cockpit.json`.
    pub requires: Option<u64>,
    /// Why a rice that is there was refused, for the log and the fallback page.
    pub why: Option<String>,
}

impl Status {
    pub fn json(&self) -> Value {
        json!({
            "dir": self.dir.as_ref().map(|d| d.display().to_string()),
            "source": self.source,
            "present": self.present,
            "disabled": self.disabled,
            "requires": self.requires,
            "why": self.why,
            "api": API,
        })
    }

    /// The one question the loader asks: does the window go to `app.localhost`?
    pub fn loads(&self) -> bool {
        self.present && !self.disabled
    }
}

/// RICE.md step 2: `<rice>/index.html` is a file, and `cockpit.json` either does not exist or
/// parses and asks for an api this kernel has.
pub fn status(st: &AppState) -> Status {
    let (dir, source) = resolve(st);
    let disabled = st.rice_options().no_rice;
    let Some(dir) = dir else {
        return Status { dir: None, source, present: false, disabled, requires: None, why: None };
    };

    let index = dir.join("index.html");
    if !index.is_file() {
        return Status {
            dir: Some(dir),
            source,
            present: false,
            disabled,
            requires: None,
            why: None, // "there is simply no rice here" is not a complaint
        };
    }

    let manifest = dir.join("cockpit.json");
    let (requires, why) = match std::fs::read_to_string(&manifest) {
        Err(_) => (None, None),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Err(e) => (None, Some(format!("cockpit.json is not valid JSON: {e}"))),
            Ok(v) => {
                let requires = v.get("requires").and_then(Value::as_u64);
                match requires {
                    Some(n) if n > API => (
                        Some(n),
                        Some(format!("cockpit.json requires ose.api {n}; this kernel is {API}")),
                    ),
                    other => (other, None),
                }
            }
        },
    };
    Status { dir: Some(dir), source, present: why.is_none(), disabled, requires, why }
}

// ---- the `ose` protocol: the kernel's own assets ---------------------------

/// Serves `dist-kernel/` out of the executable. GET only, CORS open, never cached, so a
/// rebuilt kernel is picked up by a reload and never by a stale cache entry.
pub fn serve_kernel<R: Runtime>(app: &tauri::AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    let raw = request.uri().path();
    // `..` never reaches the resolver: the embedded assets are a flat map, but a request that
    // spells an escape is a mistake or an attack either way and gets the same 404.
    if raw.split('/').any(|s| s == "..") {
        return plain(StatusCode::NOT_FOUND, "not found");
    }
    let path = if raw.is_empty() || raw == "/" { "/index.html".to_string() } else { raw.to_string() };

    let Some(asset) = app.asset_resolver().get(path.clone()) else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };
    // Tauri's resolver falls back to `index.html` for any name it does not hold, which would
    // answer a missing `kernel.js` with a page instead of a script. A name whose extension
    // says one thing and whose bytes came back as another is that fallback, and is a 404.
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let wanted = protocol::mime_of(&ext);
    let asset_is_html = asset.mime_type.starts_with("text/html");
    if asset_is_html && !ext.is_empty() && !wanted.starts_with("text/html") {
        return plain(StatusCode::NOT_FOUND, "not found");
    }

    let mime = if wanted == "application/octet-stream" { asset.mime_type.clone() } else { wanted.to_string() };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
        .body(asset.bytes)
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
}

// ---- the `app` protocol: the rice ------------------------------------------

/// Serves the rice folder as files. GET only; a directory, a missing file and anything whose
/// path leaves the folder are all the same 404 — no listing, no redirect, no guessing.
/// `index.html` is the one file that is rewritten (`rewrite_index`).
pub fn serve_rice(st: &AppState, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    let (dir, _) = resolve(st);
    let Some(dir) = dir else {
        return plain(StatusCode::NOT_FOUND, "no rice");
    };

    let decoded = percent_encoding::percent_decode_str(request.uri().path())
        .decode_utf8_lossy()
        .to_string();
    let rel = decoded.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };

    let Ok(full) = vault::resolve(&dir, rel) else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };
    if !full.is_file() {
        return plain(StatusCode::NOT_FOUND, "not found");
    }
    let Ok(bytes) = std::fs::read(&full) else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };

    let ext = full
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // The rice's own index.html, and only that one: a page of a module is served as it is.
    let is_index = rel.eq_ignore_ascii_case("index.html");
    let (bytes, csp) = if is_index {
        let text = String::from_utf8_lossy(&bytes).to_string();
        (rewrite_index(&text).into_bytes(), Some(csp_header()))
    } else {
        (bytes, None)
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, protocol::mime_of(&ext))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        // The policy is not a CORS-safelisted response header, so a page reading this file
        // across origins — the self-test does exactly that — cannot see it otherwise.
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Security-Policy")
        .header(header::CACHE_CONTROL, "no-store");
    if let Some(csp) = csp {
        builder = builder.header("Content-Security-Policy", csp);
    }
    builder
        .body(bytes)
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
}

/// Three origins, inline styles, the one inline script the host itself injects (by its hash,
/// not by `'unsafe-inline'`), and nothing whatsoever from the network.
///
/// A rice's own code therefore lives in files, never in an inline `<script>` — which is what
/// docs/RICE.md asks for anyway, and what keeps a `<script>` smuggled into a markdown file
/// from running even if it ever got past the renderer's sanitiser.
///
/// `ipc:` and the `ipc` origin are Tauri's own invoke channel: the injected bootstrap `fetch`es
/// it, and without it every call would silently fall back to the postMessage path with a CSP
/// error in the console.
pub fn csp_header() -> String {
    let (k, a, v) = (kernel_origin(), app_origin(), vault_origin());
    let ipc = origin("ipc");
    let map = import_map_hash();
    format!(
        "default-src 'none'; \
         script-src {k} {a} '{map}'; \
         style-src {k} {a} 'unsafe-inline'; \
         img-src {k} {a} {v} data: blob:; \
         font-src {k} {a} data:; \
         media-src {k} {a} {v} blob:; \
         connect-src {k} {a} {v} {ipc} ipc:; \
         worker-src {k} {a} blob:; \
         frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
}

/// The body of the import map of docs/KERNEL.md, with this platform's kernel origin. Kept
/// apart from the tag because the CSP hashes exactly these bytes.
fn import_map_body() -> String {
    let k = kernel_origin();
    format!(
        "{{\"imports\":{{\
\"ose:kernel\":\"{k}/kernel.js\",\
\"ose:editor\":\"{k}/editor.js\",\
\"ose:ui\":\"{k}/ui.js\",\
\"ose:md\":\"{k}/md.js\"\
}}}}"
    )
}

/// The import map as it goes into the page.
pub fn import_map() -> String {
    format!("<script type=\"importmap\">{}</script>", import_map_body())
}

/// `sha256-<base64>` of the import map's text, which is how a CSP names one inline script
/// without opening the door to every other one.
fn import_map_hash() -> String {
    use base64::Engine as _;
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(import_map_body().as_bytes());
    format!("sha256-{}", base64::engine::general_purpose::STANDARD.encode(digest))
}

/// The rice's `index.html` on the way out:
///
/// 1. the import map goes in immediately after `<head>` — or at the very top of the document
///    when the file has no `<head>` — so every `import 'ose:kernel'` in the page resolves;
/// 2. `<link data-ose="ui">` and `<link data-ose="editor">` are given the kernel origin's
///    `ui.css` and `editor.css`, whatever href they carried.
///
/// The rewrite is textual on purpose: a rice is a folder of hand-written files, and an HTML
/// parser that reformatted them would make what the author wrote and what the browser sees
/// two different things.
pub fn rewrite_index(html: &str) -> String {
    let mut out = insert_after_head(html, &import_map());
    for (which, file) in [("ui", "ui.css"), ("editor", "editor.css")] {
        out = rewrite_link(&out, which, &format!("{}/{}", kernel_origin(), file));
    }
    out
}

/// Inserts `what` right after the `<head ...>` tag, or at the top of the document when there
/// is none. Case-insensitive, and it never matches `<header>`.
fn insert_after_head(html: &str, what: &str) -> String {
    if let Some(at) = find_tag_end(html, "head") {
        let mut out = String::with_capacity(html.len() + what.len());
        out.push_str(&html[..at]);
        out.push_str(what);
        out.push_str(&html[at..]);
        return out;
    }
    // No <head>: after the doctype if there is one, so the document still starts the way it did.
    let at = doctype_end(html);
    let mut out = String::with_capacity(html.len() + what.len());
    out.push_str(&html[..at]);
    out.push_str(what);
    out.push_str(&html[at..]);
    out
}

/// The byte offset just past `<name ...>`, or `None`. `<header>` is not `<head>`.
fn find_tag_end(html: &str, name: &str) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    let needle = format!("<{name}");
    let mut from = 0usize;
    while let Some(i) = lower[from..].find(&needle) {
        let start = from + i;
        let after = start + needle.len();
        let next = lower[after..].chars().next();
        match next {
            Some('>') => return Some(after + 1),
            Some(c) if c.is_ascii_whitespace() => {
                return lower[after..].find('>').map(|j| after + j + 1);
            }
            _ => from = after, // <header>, <headline>, …
        }
    }
    None
}

/// Just past `<!doctype …>`, or 0.
fn doctype_end(html: &str) -> usize {
    let lower = html.to_ascii_lowercase();
    let trimmed = lower.trim_start();
    if !trimmed.starts_with("<!doctype") {
        return 0;
    }
    let offset = lower.len() - trimmed.len();
    lower[offset..].find('>').map(|j| offset + j + 1).unwrap_or(0)
}

/// Gives `<link data-ose="<which>" …>` the href `url`, adding the attribute when the tag has
/// none. Every such tag in the file, not only the first.
fn rewrite_link(html: &str, which: &str, url: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let marker_single = format!("data-ose='{which}'");
    let marker_double = format!("data-ose=\"{which}\"");
    let marker_bare = format!("data-ose={which}");

    let mut out = String::with_capacity(html.len() + 64);
    let mut cursor = 0usize;
    let mut from = 0usize;
    while let Some(i) = lower[from..].find("<link") {
        let start = from + i;
        let Some(end) = lower[start..].find('>').map(|j| start + j + 1) else { break };
        let tag_lower = &lower[start..end];
        let tagged = tag_lower.contains(&marker_single)
            || tag_lower.contains(&marker_double)
            || tag_lower.contains(&marker_bare);
        if tagged {
            out.push_str(&html[cursor..start]);
            out.push_str(&set_href(&html[start..end], url));
            cursor = end;
        }
        from = end;
    }
    out.push_str(&html[cursor..]);
    out
}

/// One `<link …>` tag with its `href` replaced, or added before the closing bracket.
fn set_href(tag: &str, url: &str) -> String {
    let lower = tag.to_ascii_lowercase();
    if let Some(i) = lower.find("href") {
        let after = &lower[i + 4..];
        let eq = after.find('=');
        if let Some(eq) = eq {
            let value_at = i + 4 + eq + 1;
            let rest = &tag[value_at..];
            let quote = rest.trim_start().chars().next();
            let lead = rest.len() - rest.trim_start().len();
            let (end, q) = match quote {
                Some(c @ ('"' | '\'')) => (
                    rest[lead + 1..].find(c).map(|j| value_at + lead + 1 + j + 1),
                    c.to_string(),
                ),
                _ => (
                    rest[lead..]
                        .find(|c: char| c.is_ascii_whitespace() || c == '>')
                        .map(|j| value_at + lead + j),
                    '"'.to_string(),
                ),
            };
            if let Some(end) = end {
                return format!("{}{q}{url}{q}{}", &tag[..value_at], &tag[end..]);
            }
        }
    }
    // No href at all: put one in before the tag closes.
    let close = tag.rfind('>').unwrap_or(tag.len());
    let slash = tag[..close].trim_end().ends_with('/');
    let body = if slash { tag[..close].trim_end().trim_end_matches('/').trim_end() } else { tag[..close].trim_end() };
    format!("{body} href=\"{url}\"{}{}", if slash { " /" } else { "" }, &tag[close..])
}

fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
        .body(message.as_bytes().to_vec())
        .expect("static response builds")
}

// ---- what the window loads -------------------------------------------------

pub fn fallback_url() -> String {
    format!("{}/index.html", kernel_origin())
}

pub fn selftest_url() -> String {
    format!("{}/selftest.html", kernel_origin())
}

pub fn rice_url() -> String {
    format!("{}/index.html", app_origin())
}

/// One line saying what the loader decided and why. `load_window` logs it, and so does the
/// self-test, which has a page of its own and never calls the loader at all.
pub fn decision_line(st: &AppState) -> String {
    let status = status(st);
    if status.loads() {
        return format!(
            "loading {} (from {})",
            status.dir.as_ref().map(|d| d.display().to_string()).unwrap_or_default(),
            status.source
        );
    }
    let why = if status.disabled {
        "--no-rice or Shift at launch".to_string()
    } else if let Some(why) = &status.why {
        why.clone()
    } else if status.dir.is_none() {
        "no vault".to_string()
    } else {
        "no index.html in the rice folder".to_string()
    };
    format!("the fallback page ({why})")
}

/// Sends the main window to the rice, or to the kernel's fallback page, and says in the log
/// which and why. Arms the five-second timer when it chose the rice.
pub fn load_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let st = app.state::<AppState>();
    let st = st.inner();
    let status = status(st);

    log_line(st, &format!("rice: {}", decision_line(st)));
    let url = if status.loads() { rice_url() } else { fallback_url() };

    navigate(app, window, &url);
    if status.loads() {
        arm_fallback(app.clone());
    } else {
        ARMED.store(0, Ordering::Release);
    }
}

fn navigate(app: &tauri::AppHandle, window: &tauri::WebviewWindow, url: &str) {
    match tauri::Url::parse(url) {
        Ok(u) => {
            if let Err(e) = window.navigate(u) {
                log_line(app.state::<AppState>().inner(), &format!("rice: navigate failed: {e}"));
            }
        }
        Err(e) => log_line(app.state::<AppState>().inner(), &format!("rice: bad url {url}: {e}")),
    }
}

/// A rice that throws before it boots would leave a blank window and no way back. The kernel
/// calls `riceReady` the moment `ose.ready` resolves, which disarms this; the fallback page
/// calls it too, so the fallback never bounces to itself.
fn arm_fallback(app: tauri::AppHandle) {
    let generation = NEXT.fetch_add(1, Ordering::AcqRel);
    ARMED.store(generation, Ordering::Release);
    std::thread::spawn(move || {
        std::thread::sleep(FALLBACK_AFTER);
        if ARMED
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return; // the kernel said it was up, or another navigation replaced this one
        }
        let st = app.state::<AppState>();
        log_line(
            st.inner(),
            &format!("rice: no riceReady within {}s, falling back", FALLBACK_AFTER.as_secs()),
        );
        if let Some(window) = app.get_webview_window("main") {
            navigate(&app, &window, &fallback_url());
        }
    });
}

// ---- rpc -------------------------------------------------------------------

pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    match cmd {
        "riceInfo" => Some(Ok(status(ctx.st).json())),

        // Ctrl+R. It reloads whatever page is loaded, except that a reload asked for from the
        // fallback page re-runs the decision: creating `.ose/app/index.html` and pressing
        // Ctrl+R is how a person gets from the fallback into their new rice.
        "reloadRice" => Some(reload(ctx)),

        "riceReady" => {
            ARMED.store(0, Ordering::Release);
            Some(Ok(Value::Null))
        }

        "riceFailed" => {
            ARMED.store(0, Ordering::Release);
            let reason = args.first().and_then(Value::as_str).unwrap_or("").to_string();
            log_line(ctx.st, &format!("rice: the page reported a failure: {reason}"));
            if let Some(window) = ctx.app.get_webview_window("main") {
                navigate(ctx.app, &window, &fallback_url());
            }
            Some(Ok(Value::Null))
        }

        _ => None,
    }
}

fn reload(ctx: &Ctx) -> Result<Value, String> {
    let Some(window) = ctx.app.get_webview_window("main") else {
        return Err("no window".to_string());
    };
    let on_fallback = window
        .url()
        .map(|u| u.as_str().starts_with(&kernel_origin()))
        .unwrap_or(false);
    if on_fallback {
        load_window(ctx.app, &window);
        return Ok(Value::Null);
    }
    ARMED.store(0, Ordering::Release);
    window.eval("window.location.reload()").map_err(|e| e.to_string())?;
    if status(ctx.st).loads() {
        arm_fallback(ctx.app.clone());
    }
    Ok(Value::Null)
}

// ---- Shift at launch -------------------------------------------------------

/// Shift held while the app starts means the same as `--no-rice` (docs/RICE.md step 3): the way
/// back into a working window when a rice will not boot, without editing a file or finding a
/// terminal. Read once, in `main`, before anything else has had a chance to change it.
#[cfg(windows)]
pub fn shift_held() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};
    // Safe: no pointers cross, and the call only reads the keyboard state of this thread's
    // input queue. The high bit means "down right now".
    let state = unsafe { GetAsyncKeyState(VK_SHIFT as i32) };
    (state as u16 & 0x8000) != 0
}

#[cfg(target_os = "macos")]
pub fn shift_held() -> bool {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags};
    // `modifierFlags` is a class method that reads the current state, so it needs no event and
    // no running loop; it is safe to call before the app is built.
    let flags = unsafe { NSEvent::modifierFlags_class() };
    flags.contains(NSEventModifierFlags::Shift)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn shift_held() -> bool {
    // Linux has no portable way to read a modifier before a window exists; `--no-rice` is the
    // way in, and the fallback page says so.
    false
}

// ---- options on the state --------------------------------------------------

/// The `--rice` / `--no-rice` pair, kept beside the root so the protocol handler and the
/// loader read the same thing.
pub type Slot = RwLock<Options>;

pub fn slot(options: Options) -> Slot {
    RwLock::new(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_follow_the_platform() {
        let k = kernel_origin();
        if cfg!(windows) {
            assert_eq!(k, "http://ose.localhost");
            assert_eq!(app_origin(), "http://app.localhost");
            assert_eq!(vault_origin(), "http://vault.localhost");
        } else {
            assert_eq!(k, "ose://localhost");
            assert_eq!(app_origin(), "app://localhost");
            assert_eq!(vault_origin(), "vault://localhost");
        }
        assert!(!k.ends_with('/'), "an origin has no trailing slash");
    }

    #[test]
    fn the_import_map_goes_after_head() {
        let html = "<!doctype html>\n<html>\n<head>\n<title>x</title>\n</head>\n<body></body>\n</html>\n";
        let out = rewrite_index(html);
        let head = out.find("<head>").unwrap();
        let map = out.find("importmap").unwrap();
        let title = out.find("<title>").unwrap();
        assert!(head < map && map < title, "the map sits between <head> and the first child");
        assert!(out.contains(&format!("{}/kernel.js", kernel_origin())));
        assert!(out.contains("\"ose:md\""));
        // Everything else is untouched, byte for byte.
        assert!(out.starts_with("<!doctype html>\n<html>\n<head>"));
        assert!(out.ends_with("</head>\n<body></body>\n</html>\n"));
    }

    #[test]
    fn a_head_with_attributes_still_matches_and_header_does_not() {
        let out = rewrite_index("<head lang=\"en\"><p>x</p></head>");
        assert!(out.starts_with("<head lang=\"en\"><script type=\"importmap\">"));
        let out = rewrite_index("<header>hi</header>");
        assert!(out.starts_with("<script type=\"importmap\">"), "{out}");
    }

    #[test]
    fn with_no_head_the_map_goes_after_the_doctype() {
        let out = rewrite_index("<!DOCTYPE html>\n<p>hi</p>");
        assert!(out.starts_with("<!DOCTYPE html><script type=\"importmap\">"), "{out}");
        assert!(out.ends_with("</script>\n<p>hi</p>"), "{out}");
    }

    #[test]
    fn the_two_stylesheet_links_are_rewritten() {
        let html = concat!(
            "<head>",
            "<link rel=\"stylesheet\" data-ose=\"ui\" href=\"ui.css\">",
            "<link rel=\"stylesheet\" data-ose='editor'>",
            "<link rel=\"stylesheet\" href=\"theme.css\">",
            "</head>"
        );
        let out = rewrite_index(html);
        let k = kernel_origin();
        assert!(out.contains(&format!("data-ose=\"ui\" href=\"{k}/ui.css\"")), "{out}");
        assert!(out.contains(&format!("{k}/editor.css")), "{out}");
        // A link of the rice's own is left exactly as it was.
        assert!(out.contains("<link rel=\"stylesheet\" href=\"theme.css\">"), "{out}");
    }

    #[test]
    fn a_self_closing_link_without_href_keeps_its_slash() {
        let out = set_href("<link rel=\"stylesheet\" data-ose=\"ui\" />", "X");
        assert_eq!(out, "<link rel=\"stylesheet\" data-ose=\"ui\" href=\"X\" />");
    }

    #[test]
    fn an_unquoted_href_is_replaced_too() {
        let out = set_href("<link data-ose=ui href=old.css>", "X");
        assert_eq!(out, "<link data-ose=ui href=\"X\">");
    }

    #[test]
    fn the_csp_names_the_three_origins_and_nothing_else() {
        let csp = csp_header();
        for o in [kernel_origin(), app_origin(), vault_origin()] {
            assert!(csp.contains(&o), "{csp}");
        }
        assert!(csp.starts_with("default-src 'none';"));
        assert!(csp.contains("style-src") && csp.contains("'unsafe-inline'"));
        // Nothing from the network, and no way to widen it by loading a page in a frame.
        assert!(!csp.contains("https:") && !csp.contains('*'));
        assert!(csp.contains("frame-src 'none'") && csp.contains("object-src 'none'"));
        // Inline scripts are refused; the one the host injects is named by its hash, and the
        // hash is of exactly the bytes that end up in the page.
        assert!(!csp.contains("script-src") || !csp.contains("script-src 'unsafe-inline'"));
        let hash = import_map_hash();
        assert!(hash.starts_with("sha256-") && hash.len() > 20, "{hash}");
        assert!(csp.contains(&format!("'{hash}'")), "{csp}");
        let tag = import_map();
        let body = tag
            .trim_start_matches("<script type=\"importmap\">")
            .trim_end_matches("</script>");
        assert_eq!(body, import_map_body());
    }

    /// The rewrite runs on every byte a rice author wrote, so it must not lose any of them.
    #[test]
    fn a_page_with_nothing_to_rewrite_comes_back_unchanged_but_for_the_map() {
        let html = "<!doctype html>\n<html lang=\"en\">\n<head>\n</head>\n<body>\n<p>caf\u{e9}</p>\n</body>\n</html>\n";
        let out = rewrite_index(html);
        let stripped = {
            let i = out.find("<script type=\"importmap\">").unwrap();
            let j = out.find("</script>").unwrap() + "</script>".len();
            format!("{}{}", &out[..i], &out[j..])
        };
        assert_eq!(stripped, html);
    }
}
