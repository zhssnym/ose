//! The two origins the app is drawn from, and what the window loads.
//!
//! - `ose` serves the kernel's embedded bundles (`dist-kernel/`, `frontendDist` in
//!   tauri.conf.json): kernel.js, editor.js, ui.js, md.js and the two stylesheets. Read-only,
//!   CORS open, never cached.
//! - `app` serves the app itself. Anything under `/plugins/` is a file of
//!   `<vault>/.ose/plugins` read from disk on every request; everything else is a file of the
//!   shell, which travels inside the executable (`dist-kernel/shell/`, put there by
//!   scripts/embed-shell.mjs) unless `--shell <dir>` names a folder to read it from instead.
//!   `index.html` is rewritten on the way out, so no file of the shell ever spells an origin:
//!   the import map and the two stylesheet links are inserted by the host.
//!
//! Tauri maps a custom scheme to `http://<scheme>.localhost/...` on Windows and to
//! `<scheme>://localhost/...` on macOS and Linux; `origin()` is the one place that knows.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde_json::Value;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{Manager as _, Runtime};

use crate::{log_line, protocol, vault, AppState, Ctx};

/// The `ose.api` this kernel implements (docs/PLUGINS.md).
pub const API: u64 = 2;

/// `--shell <dir>`, settled once at startup and read on every request.
#[derive(Clone, Debug, Default)]
pub struct Options {
    pub dir: Option<PathBuf>,
}

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
    let wanted = protocol::mime_of(&extension(&path));
    if is_the_index_fallback(&asset.mime_type, wanted) {
        return plain(StatusCode::NOT_FOUND, "not found");
    }

    let mime = if wanted == "application/octet-stream" { asset.mime_type.clone() } else { wanted.to_string() };
    file(asset.bytes, &mime, "no-store", None)
}

/// Tauri's asset resolver falls back to `index.html` for any name it does not hold, which
/// would answer a missing `kernel.js` with a page instead of a script. A name whose extension
/// says one thing and whose bytes came back as another is that fallback, and is a 404.
fn is_the_index_fallback(asset_mime: &str, wanted: &str) -> bool {
    asset_mime.starts_with("text/html") && !wanted.starts_with("text/html")
}

// ---- the `app` protocol: the shell and the vault's plugins -----------------

/// `<app origin>/plugins/<id>/<file>` is `<vault>/.ose/plugins/<id>/<file>`, and nothing else
/// on this origin comes from the vault.
const PLUGINS: &str = "plugins/";

/// One file of the shell inside the executable: its bytes and the mime the embedder recorded.
pub type Embedded = (Vec<u8>, String);

/// Where a request to the `app` origin is answered from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// A file of `<vault>/.ose/plugins`, on disk.
    Plugin(PathBuf),
    /// A file of the folder `--shell <dir>` names, on disk.
    Disk(PathBuf),
    /// A file of the shell inside the executable, by its name under `shell/`.
    Embedded(String),
    /// A plain 404: no vault for a plugin, or a path that leaves its folder.
    Nothing,
}

/// The path a request asks for (percent-decoded, no leading slash) and where it is answered
/// from. The empty path is `index.html`, so `<app origin>/` is the shell.
pub fn route(st: &AppState, path: &str) -> (String, Target) {
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html".to_string() } else { rel.to_string() };

    if let Some(name) = rel.strip_prefix(PLUGINS) {
        if name.is_empty() {
            return (rel, Target::Nothing);
        }
        // No vault, no plugins: the shell still loads and draws its own vault chooser.
        let Some(root) = st.root() else { return (rel, Target::Nothing) };
        let dir = root.join(".ose").join("plugins");
        let target = match vault::resolve(&dir, name) {
            Ok(full) => Target::Plugin(full),
            Err(_) => Target::Nothing,
        };
        return (rel, target);
    }

    match st.shell_options().dir {
        Some(dir) => {
            let target = match vault::resolve(&vault::normalize(&dir), &rel) {
                Ok(full) => Target::Disk(full),
                Err(_) => Target::Nothing,
            };
            (rel, target)
        }
        None => {
            if rel.split('/').any(|s| s == "..") {
                return (rel, Target::Nothing);
            }
            let name = format!("/shell/{rel}");
            (rel, Target::Embedded(name))
        }
    }
}

/// Serves one request on the `app` origin. GET only; a directory, a missing file and anything
/// whose path leaves its folder are all the same 404 — no listing, no redirect, no guessing.
///
/// `embedded` reads one file of the shell inside the executable: the protocol handler passes
/// Tauri's asset resolver, a test passes a map.
pub fn serve_app(
    st: &AppState,
    request: &Request<Vec<u8>>,
    embedded: impl Fn(&str) -> Option<Embedded>,
) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    let decoded = percent_encoding::percent_decode_str(request.uri().path())
        .decode_utf8_lossy()
        .to_string();
    let (rel, target) = route(st, &decoded);
    let mime = protocol::mime_of(&extension(&rel));

    match target {
        Target::Nothing => plain(StatusCode::NOT_FOUND, "not found"),

        // A plugin is the vault owner's own code, edited in place and reloaded with Ctrl+R, so
        // the web view is told to ask every time rather than trust what it already has.
        Target::Plugin(full) => match read(&full) {
            Some(bytes) => file(bytes, mime, "no-cache", None),
            None => plain(StatusCode::NOT_FOUND, "not found"),
        },

        Target::Disk(full) => match read(&full) {
            Some(bytes) => shell_file(bytes, &rel, mime),
            None => plain(StatusCode::NOT_FOUND, "not found"),
        },

        Target::Embedded(name) => match embedded(&name) {
            Some((bytes, asset_mime)) if !is_the_index_fallback(&asset_mime, mime) => {
                shell_file(bytes, &rel, mime)
            }
            _ => plain(StatusCode::NOT_FOUND, "not found"),
        },
    }
}

/// A file of the shell. `index.html` is the one file that is rewritten and the one that
/// carries the policy; every other file goes out as it is.
fn shell_file(bytes: Vec<u8>, rel: &str, mime: &str) -> Response<Vec<u8>> {
    if !rel.eq_ignore_ascii_case("index.html") {
        return file(bytes, mime, "no-store", None);
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    file(rewrite_index(&text).into_bytes(), mime, "no-store", Some(csp_header()))
}

fn read(full: &Path) -> Option<Vec<u8>> {
    if !full.is_file() {
        return None;
    }
    std::fs::read(full).ok()
}

/// The lowercase extension of the last segment of a path, or an empty string.
fn extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((head, ext)) if !head.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn file(bytes: Vec<u8>, mime: &str, cache: &str, csp: Option<String>) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, cache);
    if let Some(csp) = csp {
        builder = builder.header("Content-Security-Policy", csp);
    }
    builder
        .body(bytes)
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
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

// ---- the page's policy and its import map ----------------------------------

/// Three origins, inline styles, the one inline script the host itself injects (by its hash,
/// not by `'unsafe-inline'`), and nothing whatsoever from the network.
///
/// `frame-src` is the vault origin and only the vault origin: a `.pdf` in the tree is drawn by
/// the web view's own PDF viewer in an `<iframe>` over `vault.localhost`, which needs the frame
/// allowed and the `application/pdf` content type `protocol.rs` already sends. `object-src`
/// stays `'none'`, so `<embed>` and `<object>` are still refused, and no frame may point
/// anywhere but at a file of this vault.
///
/// The shell's own code therefore lives in files, never in an inline `<script>`, which is what
/// keeps a `<script>` smuggled into a markdown file from running even if it ever got past the
/// renderer's sanitiser.
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
         frame-src {v}; object-src 'none'; base-uri 'none'; form-action 'none'"
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

/// The shell's `index.html` on the way out:
///
/// 1. the import map goes in immediately after `<head>` — or at the very top of the document
///    when the file has no `<head>` — so every `import 'ose:kernel'` in the page resolves;
/// 2. `<link data-ose="ui">` and `<link data-ose="editor">` are given the kernel origin's
///    `ui.css` and `editor.css`, whatever href they carried.
///
/// The rewrite is textual on purpose: the shell is a folder of hand-written files, and an HTML
/// parser that reformatted them would make what the author wrote and what the browser sees two
/// different things.
pub fn rewrite_index(html: &str) -> String {
    let mut out = insert_after_head(html, &import_map());
    for (which, name) in [("ui", "ui.css"), ("editor", "editor.css")] {
        out = rewrite_link(&out, which, &format!("{}/{}", kernel_origin(), name));
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

// ---- what the window loads -------------------------------------------------

pub fn shell_url() -> String {
    format!("{}/index.html", app_origin())
}

/// One line saying where the shell the window is about to load comes from.
pub fn source_line(st: &AppState) -> String {
    match st.shell_options().dir {
        Some(dir) => format!("loading {} (--shell)", vault::normalize(&dir).display()),
        None => "loading the copy inside the executable".to_string(),
    }
}

/// Sends the main window to the shell and says in the log where the shell came from.
pub fn load_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let st = app.state::<AppState>();
    let st = st.inner();
    log_line(st, &format!("shell: {}", source_line(st)));
    navigate(app, window, &shell_url());
}

fn navigate(app: &tauri::AppHandle, window: &tauri::WebviewWindow, url: &str) {
    match tauri::Url::parse(url) {
        Ok(u) => {
            if let Err(e) = window.navigate(u) {
                log_line(app.state::<AppState>().inner(), &format!("shell: navigate failed: {e}"));
            }
        }
        Err(e) => log_line(app.state::<AppState>().inner(), &format!("shell: bad url {url}: {e}")),
    }
}

// ---- rpc -------------------------------------------------------------------

pub fn handle(ctx: &Ctx, cmd: &str, _args: &[Value]) -> Option<Result<Value, String>> {
    match cmd {
        // Ctrl+R. Back to the shell's index.html: a fresh page, and therefore every plugin
        // read from disk again. `reloadRice` is the name the 0.5.0 kernel calls it by.
        "reloadRice" | "reloadShell" => Some(reload(ctx)),
        _ => None,
    }
}

fn reload(ctx: &Ctx) -> Result<Value, String> {
    let Some(window) = ctx.app.get_webview_window("main") else {
        return Err("no window".to_string());
    };
    navigate(ctx.app, &window, &shell_url());
    Ok(Value::Null)
}

// ---- options on the state --------------------------------------------------

/// `--shell <dir>`, kept beside the root so the protocol handler and the loader read the same
/// thing.
pub type Slot = RwLock<Options>;

pub fn slot(options: Options) -> Slot {
    RwLock::new(options)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A fresh folder under the system temp dir, removed when dropped.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("ose-host-{tag}-{stamp}-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn state(root: Option<&Path>, shell: Option<&Path>) -> AppState {
        let st = AppState::new(
            root.map(|p| crate::Root { path: p.to_path_buf(), source: crate::Source::Arg }),
            None,
            None,
        );
        st.set_shell_options(Options { dir: shell.map(Path::to_path_buf) });
        st
    }

    fn get(path: &str) -> Request<Vec<u8>> {
        Request::builder()
            .method(Method::GET)
            .uri(format!("{}{path}", app_origin()))
            .body(Vec::new())
            .expect("a GET request")
    }

    /// The shell as the executable carries it: a name under `shell/` to its text.
    fn embedded(files: &[(&str, &str)]) -> impl Fn(&str) -> Option<Embedded> {
        let map: HashMap<String, String> =
            files.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name: &str| {
            map.get(name).map(|text| {
                let mime = if name.ends_with(".html") { "text/html" } else { "text/javascript" };
                (text.as_bytes().to_vec(), mime.to_string())
            })
        }
    }

    const INDEX: &str =
        "<!doctype html>\n<head>\n<link data-ose=\"ui\" rel=\"stylesheet\" href=\"\">\n</head>\n<body></body>\n";

    fn shell() -> impl Fn(&str) -> Option<Embedded> {
        embedded(&[("/shell/index.html", INDEX), ("/shell/main.js", "export const x = 1\n")])
    }

    fn body(r: &Response<Vec<u8>>) -> String {
        String::from_utf8_lossy(r.body()).to_string()
    }

    fn header_of(r: &Response<Vec<u8>>, name: &str) -> String {
        r.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
    }

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

    /// The whole point of the rebuild: the page comes out of the executable, rewritten.
    #[test]
    fn the_index_comes_from_the_embedded_shell_and_is_rewritten() {
        let st = state(None, None);
        for path in ["/index.html", "/"] {
            let r = serve_app(&st, &get(path), shell());
            assert_eq!(r.status(), StatusCode::OK, "{path}");
            let text = body(&r);
            assert!(text.contains("<script type=\"importmap\">"), "{text}");
            assert!(text.contains(&format!("{}/kernel.js", kernel_origin())), "{text}");
            assert!(text.contains(&format!("href=\"{}/ui.css\"", kernel_origin())), "{text}");
            assert_eq!(header_of(&r, "content-type"), "text/html; charset=utf-8");
            assert!(header_of(&r, "content-security-policy").starts_with("default-src 'none';"));
        }
        // Everything else of the shell goes out as it is, with no policy of its own.
        let r = serve_app(&st, &get("/main.js"), shell());
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(body(&r), "export const x = 1\n");
        assert_eq!(header_of(&r, "content-type"), "text/javascript; charset=utf-8");
        assert_eq!(header_of(&r, "content-security-policy"), "");
        // A file the shell does not hold is a 404, never the index page under another name.
        assert_eq!(serve_app(&st, &get("/nope.js"), shell()).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn a_plugin_file_comes_from_the_vault_on_disk() {
        let t = Tmp::new("plugins");
        let day = t.0.join(".ose").join("plugins").join("day");
        fs::create_dir_all(&day).unwrap();
        fs::write(day.join("index.js"), "export function activate() {}\n").unwrap();

        let st = state(Some(&t.0), None);
        let r = serve_app(&st, &get("/plugins/day/index.js"), shell());
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(body(&r), "export function activate() {}\n");
        assert_eq!(header_of(&r, "content-type"), "text/javascript; charset=utf-8");
        assert_eq!(header_of(&r, "cache-control"), "no-cache");

        // A file that is not there, a folder, and a path that leaves the plugins folder.
        for path in ["/plugins/day/nope.js", "/plugins/day", "/plugins/", "/plugins/../../secret.md"] {
            assert_eq!(serve_app(&st, &get(path), shell()).status(), StatusCode::NOT_FOUND, "{path}");
        }
        // The index is still the shell's, not the vault's.
        assert!(body(&serve_app(&st, &get("/index.html"), shell())).contains("importmap"));
    }

    #[test]
    fn with_no_vault_plugins_are_404_and_the_shell_still_loads() {
        let st = state(None, None);
        assert_eq!(
            serve_app(&st, &get("/plugins/day/index.js"), shell()).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(serve_app(&st, &get("/index.html"), shell()).status(), StatusCode::OK);
    }

    #[test]
    fn shell_from_a_folder_on_disk_replaces_the_embedded_copy() {
        let t = Tmp::new("shell");
        fs::write(t.0.join("index.html"), INDEX).unwrap();
        fs::write(t.0.join("main.js"), "// from disk\n").unwrap();

        let st = state(None, Some(&t.0));
        let r = serve_app(&st, &get("/index.html"), shell());
        assert_eq!(r.status(), StatusCode::OK);
        assert!(body(&r).contains("importmap"), "the copy on disk is rewritten too");
        assert_eq!(body(&serve_app(&st, &get("/main.js"), shell())), "// from disk\n");
        // The embedded copy is not consulted, and nothing may leave the folder.
        assert_eq!(serve_app(&st, &get("/nope.js"), shell()).status(), StatusCode::NOT_FOUND);
        assert_eq!(serve_app(&st, &get("/../secret.md"), shell()).status(), StatusCode::NOT_FOUND);
    }

    /// `--shell` says where the shell is; it never says where the plugins are.
    #[test]
    fn plugins_still_come_from_the_vault_while_the_shell_is_a_folder() {
        let vault_dir = Tmp::new("vault");
        let shell_dir = Tmp::new("shell-only");
        let week = vault_dir.0.join(".ose").join("plugins").join("week");
        fs::create_dir_all(&week).unwrap();
        fs::write(week.join("index.js"), "// week\n").unwrap();
        fs::write(shell_dir.0.join("index.html"), INDEX).unwrap();

        let st = state(Some(&vault_dir.0), Some(&shell_dir.0));
        assert_eq!(body(&serve_app(&st, &get("/plugins/week/index.js"), shell())), "// week\n");
    }

    #[test]
    fn only_get_is_answered() {
        let st = state(None, None);
        let post = Request::builder()
            .method(Method::POST)
            .uri(format!("{}/index.html", app_origin()))
            .body(Vec::new())
            .unwrap();
        assert_eq!(serve_app(&st, &post, shell()).status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[test]
    fn a_percent_encoded_name_is_decoded_once() {
        let t = Tmp::new("encoded");
        let dir = t.0.join(".ose").join("plugins").join("maths");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("corrige exercices.js"), "// spaces\n").unwrap();
        let st = state(Some(&t.0), None);
        assert_eq!(
            body(&serve_app(&st, &get("/plugins/maths/corrige%20exercices.js"), shell())),
            "// spaces\n"
        );
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
        // A link of the shell's own is left exactly as it was.
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
        // Nothing from the network, and no way to widen it by loading a page in a frame: the
        // only framable thing is a file of this vault (the PDF viewer).
        assert!(!csp.contains("https:") && !csp.contains('*'));
        assert!(
            csp.contains(&format!("frame-src {};", vault_origin())),
            "frame-src must be the vault origin and nothing else: {csp}"
        );
        assert!(csp.contains("object-src 'none'"));
        // Inline scripts are refused; the one the host injects is named by its hash, and the
        // hash is of exactly the bytes that end up in the page.
        assert!(!csp.contains("script-src") || !csp.contains("script-src 'unsafe-inline'"));
        let hash = import_map_hash();
        assert!(hash.starts_with("sha256-") && hash.len() > 20, "{hash}");
        assert!(csp.contains(&format!("'{hash}'")), "{csp}");
        let tag = import_map();
        let content = tag
            .trim_start_matches("<script type=\"importmap\">")
            .trim_end_matches("</script>");
        assert_eq!(content, import_map_body());
    }

    /// The rewrite runs on every byte a shell author wrote, so it must not lose any of them.
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

    #[test]
    fn an_extension_is_the_last_one_of_the_last_segment() {
        assert_eq!(extension("index.html"), "html");
        assert_eq!(extension("plugins/day/index.JS"), "js");
        assert_eq!(extension("plugins/day/README"), "");
        assert_eq!(extension(".keep"), "");
        assert_eq!(extension("a.b/c"), "");
    }
}
