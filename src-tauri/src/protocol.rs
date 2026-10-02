//! The `vault` URI scheme: the vault served read-only to the webview, so `<img src>` can point
//! at a file in the tree. Tauri maps it to `http://vault.localhost/<path>` on Windows and
//! `vault://localhost/<path>` elsewhere; the adapter's `assetUrl` knows which.
//!
//! Each window is served its own vault: the handler is told which webview asked. Two more
//! things (wave 3):
//!
//! - **Ranges.** `Range: bytes=…` is answered with a 206 and `Content-Range`, reading only the
//!   slice, so a video seeks. No answer is longer than `CHUNK` (4 MB): an open range (`bytes=0-`,
//!   which is how Chromium's media and PDF readers start, and every seek) or a wide one is
//!   answered with its first `CHUNK` bytes, which HTTP allows, and the reader asks for the rest.
//!   A GET with no range reads the whole file only up to `WHOLE` (64 MB); a bigger file is
//!   answered as a 206 of its first chunk. A range past the end is a 416. Every answer says
//!   `Accept-Ranges: bytes`.
//! - **Off the UI thread.** main.rs registers the handler as asynchronous and runs it on a
//!   blocking worker: no file is read inside WebView2's callback.
//! - **Outside files.** `/~abs/<percent-encoded absolute path>` serves a file under the folder of
//!   an outside file the window opened (outside.rs), so the images of an outside note show.
//!   Anything else under `/~abs/` is a 404.
//!
//! Tauri's own asset protocol is not used for vault files: it knows neither the confinement to
//! one root nor the outside registrations.

use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::{header, Method, Request, Response, StatusCode};

use crate::vault;

/// The prefix of an outside file's media path.
const ABS_PREFIX: &str = "/~abs/";

/// The most bytes one ranged answer carries.
pub const CHUNK: u64 = 4 * 1024 * 1024;

/// The biggest file a GET with no range is answered with whole; past it, the first `CHUNK` as a
/// 206, so an `<img>` of a huge file cannot pull it all into memory at once.
pub const WHOLE: u64 = 64 * 1024 * 1024;

/// The handler main.rs registers: finds the window that asked, and reads its root at request
/// time, so a vault picked after startup is served from the first `<img>` on.
pub fn serve_for(win: Option<&crate::Win>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(win) = win else {
        return plain(StatusCode::NOT_FOUND, "no such window");
    };
    let raw = request.uri().path();
    if let Some(rest) = raw.strip_prefix(ABS_PREFIX) {
        let decoded = percent_encoding::percent_decode_str(rest).decode_utf8_lossy().to_string();
        let decoded = if cfg!(windows) { decoded } else { format!("/{}", decoded.trim_start_matches('/')) };
        return match crate::outside::native(&decoded) {
            Ok(full) if win.outside.media_allowed(&full) => serve_file(&full, request),
            _ => plain(StatusCode::NOT_FOUND, "not found"),
        };
    }
    match win.root() {
        Some(root) => serve(&root, request),
        None => plain(StatusCode::NOT_FOUND, crate::NO_VAULT),
    }
}

/// One file of `root`, by the request's path.
pub fn serve(root: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let decoded = percent_encoding::percent_decode_str(request.uri().path())
        .decode_utf8_lossy()
        .to_string();
    let Ok(full) = vault::resolve(root, &decoded) else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };
    serve_file(&full, request)
}

/// One file on disk: the whole of it, or the range asked for.
fn serve_file(full: &PathBuf, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    let Ok(meta) = std::fs::metadata(full) else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };
    if !meta.is_file() {
        return plain(StatusCode::NOT_FOUND, "not found");
    }
    let len = meta.len();
    let ext = full
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| parse_range(v, len));

    let (status, slice) = match range {
        None | Some(Range::Ignored) if len > WHOLE && request.method() == Method::GET => {
            (StatusCode::PARTIAL_CONTENT, Some((0, CHUNK - 1)))
        }
        None | Some(Range::Ignored) => (StatusCode::OK, None),
        Some(Range::Unsatisfiable) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Vec::new())
                .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "response failed"));
        }
        Some(Range::Bytes(start, end)) => (StatusCode::PARTIAL_CONTENT, Some((start, capped(start, end)))),
    };

    let body = if request.method() == Method::HEAD {
        Vec::new()
    } else {
        let read = match slice {
            Some((start, end)) => read_slice(full, start, end),
            None => std::fs::read(full),
        };
        match read {
            Ok(b) => b,
            Err(_) => return plain(StatusCode::NOT_FOUND, "not found"),
        }
    };

    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime_of(&ext))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ACCEPT_RANGES, "bytes")
        // A script that asked for a range may read which one it got.
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Accept-Ranges, Content-Length")
        // A file is what its extension says, never what its bytes look like (L18).
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    match slice {
        Some((start, end)) => {
            response = response
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, end - start + 1);
        }
        None => response = response.header(header::CONTENT_LENGTH, len),
    }
    // A vault file that could run script when opened as a document (an HTML page, an SVG, an
    // XML file) runs none: it is shown, never executed. An `<img>` of an SVG is unaffected, and
    // the other types (a PDF above all, which the web view's own viewer draws) get no sandbox.
    if active(&ext) {
        response = response.header(header::CONTENT_SECURITY_POLICY, "sandbox");
    }
    response
        .body(body)
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
}

/// The end of a range that starts at `start`, at most `CHUNK` bytes on.
fn capped(start: u64, end: u64) -> u64 {
    end.min(start.saturating_add(CHUNK - 1))
}

/// Bytes `start..=end` of the file, and nothing else of it.
fn read_slice(full: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let mut f = std::fs::File::open(full)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(usize::try_from(end - start + 1).unwrap_or(0));
    f.take(end - start + 1).read_to_end(&mut buf)?;
    Ok(buf)
}

/// What a `Range` header asks of a file of `len` bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum Range {
    /// `start..=end`, inside the file.
    Bytes(u64, u64),
    /// A range that starts past the end, or an empty file: 416.
    Unsatisfiable,
    /// Not a single byte range we answer (another unit, several ranges, nonsense): the whole
    /// file, as if nothing had been asked.
    Ignored,
}

/// `bytes=a-b`, `bytes=a-` and `bytes=-n` (the last n bytes). An end past the file is the file's
/// last byte, as HTTP says.
pub fn parse_range(value: &str, len: u64) -> Range {
    let Some(spec) = value.trim().strip_prefix("bytes=") else { return Range::Ignored };
    if spec.contains(',') {
        return Range::Ignored;
    }
    let Some((a, b)) = spec.trim().split_once('-') else { return Range::Ignored };
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        // The last `n` bytes.
        let Ok(n) = b.parse::<u64>() else { return Range::Ignored };
        if n == 0 || len == 0 {
            return Range::Unsatisfiable;
        }
        return Range::Bytes(len.saturating_sub(n), len - 1);
    }
    let Ok(start) = a.parse::<u64>() else { return Range::Ignored };
    if start >= len {
        return Range::Unsatisfiable;
    }
    let end = if b.is_empty() {
        len - 1
    } else {
        match b.parse::<u64>() {
            Ok(e) if e >= start => e.min(len - 1),
            _ => return Range::Ignored,
        }
    };
    Range::Bytes(start, end)
}

/// The types a browser would run script in when loaded as a document.
fn active(ext: &str) -> bool {
    matches!(ext, "html" | "htm" | "xhtml" | "svg" | "xml" | "xsl")
}

fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(message.as_bytes().to_vec())
        .expect("static response builds")
}

/// The .NET host's table, kept in step so both hosts serve the same bytes with the same type.
pub fn mime_of(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "jsonl" => "application/x-ndjson; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogg" | "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "opus" | "oga" => "audio/ogg",
        "txt" | "md" => "text/plain; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("ose-protocol-{tag}-{stamp}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn get(p: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut b = Request::builder().uri(p);
        if let Some(r) = range {
            b = b.header(header::RANGE, r);
        }
        b.body(Vec::new()).unwrap()
    }

    #[test]
    fn known_types() {
        assert_eq!(mime_of("png"), "image/png");
        assert_eq!(mime_of("md"), "text/plain; charset=utf-8");
        assert_eq!(mime_of("zip"), "application/octet-stream");
    }

    #[test]
    fn active_content_is_sandboxed_and_nothing_is_sniffed() {
        let t = Tmp::new("active");
        std::fs::write(t.0.join("a.html"), "<script>1</script>").unwrap();
        std::fs::write(t.0.join("b.pdf"), "%PDF-1.4").unwrap();
        let html = serve(&t.0, &get("/a.html", None));
        assert_eq!(html.headers()[header::CONTENT_SECURITY_POLICY], "sandbox");
        assert_eq!(html.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        let pdf = serve(&t.0, &get("/b.pdf", None));
        assert!(pdf.headers().get(header::CONTENT_SECURITY_POLICY).is_none());
        assert_eq!(pdf.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(pdf.headers()[header::ACCEPT_RANGES], "bytes");
    }

    #[test]
    fn a_range_is_a_206_with_only_the_slice() {
        let t = Tmp::new("range");
        let data: Vec<u8> = (0u8..=99).collect();
        std::fs::write(t.0.join("v.mp4"), &data).unwrap();

        let r = serve(&t.0, &get("/v.mp4", Some("bytes=10-19")));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body(), &data[10..20]);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 10-19/100");
        assert_eq!(r.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "10");

        // An open end runs to the last byte; an end past the file is the last byte.
        let r = serve(&t.0, &get("/v.mp4", Some("bytes=95-")));
        assert_eq!(r.body(), &data[95..]);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 95-99/100");
        let r = serve(&t.0, &get("/v.mp4", Some("bytes=90-500")));
        assert_eq!(r.body(), &data[90..]);
        // The last n bytes.
        let r = serve(&t.0, &get("/v.mp4", Some("bytes=-5")));
        assert_eq!(r.body(), &data[95..]);

        // A range that starts past the end is a 416 that names the length.
        let r = serve(&t.0, &get("/v.mp4", Some("bytes=100-")));
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes */100");
        assert!(r.body().is_empty());

        // No range, or one we do not answer: the whole file.
        let r = serve(&t.0, &get("/v.mp4", None));
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), &data);
        let r = serve(&t.0, &get("/v.mp4", Some("bytes=0-1,5-6")));
        assert_eq!(r.status(), StatusCode::OK);
    }

    /// No answer carries more than `CHUNK` bytes: an open range, a wide one, and a GET of a
    /// file bigger than `WHOLE` all answer the first chunk, and say how long the file is.
    #[test]
    fn a_big_file_is_answered_one_chunk_at_a_time() {
        let t = Tmp::new("chunk");
        let len = WHOLE + 3;
        let f = std::fs::File::create(t.0.join("big.mp4")).unwrap();
        f.set_len(len).unwrap();
        drop(f);
        let chunk = usize::try_from(CHUNK).unwrap();
        for range in [Some("bytes=0-"), Some("bytes=0-99999999999"), None] {
            let r = serve(&t.0, &get("/big.mp4", range));
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT, "{range:?}");
            assert_eq!(r.body().len(), chunk, "{range:?}");
            assert_eq!(r.headers()[header::CONTENT_RANGE], format!("bytes 0-{}/{len}", CHUNK - 1));
            assert_eq!(r.headers()[header::CONTENT_LENGTH], CHUNK.to_string());
        }
        // A seek: from there, one chunk or the rest, whichever is shorter.
        let r = serve(&t.0, &get("/big.mp4", Some(&format!("bytes={}-", len - 10))));
        assert_eq!(r.body().len(), 10);
        let r = serve(&t.0, &get("/big.mp4", Some("bytes=1000-")));
        assert_eq!(r.headers()[header::CONTENT_RANGE], format!("bytes 1000-{}/{len}", 1000 + CHUNK - 1));
        // HEAD reads nothing and says the whole length.
        let head = Request::builder().method(Method::HEAD).uri("/big.mp4").body(Vec::new()).unwrap();
        let r = serve(&t.0, &head);
        assert_eq!(r.status(), StatusCode::OK);
        assert!(r.body().is_empty());
        assert_eq!(r.headers()[header::CONTENT_LENGTH], len.to_string());
    }

    #[test]
    fn ranges_parse_as_http_says() {
        assert_eq!(parse_range("bytes=0-0", 10), Range::Bytes(0, 0));
        assert_eq!(parse_range("bytes=3-", 10), Range::Bytes(3, 9));
        assert_eq!(parse_range("bytes=-3", 10), Range::Bytes(7, 9));
        assert_eq!(parse_range("bytes=-30", 10), Range::Bytes(0, 9));
        assert_eq!(parse_range("bytes=10-", 10), Range::Unsatisfiable);
        assert_eq!(parse_range("bytes=0-", 0), Range::Unsatisfiable);
        assert_eq!(parse_range("bytes=5-2", 10), Range::Ignored);
        assert_eq!(parse_range("items=0-1", 10), Range::Ignored);
        assert_eq!(parse_range("bytes=x-1", 10), Range::Ignored);
    }

    #[test]
    fn outside_media_is_served_only_under_a_registered_folder() {
        let t = Tmp::new("abs");
        std::fs::create_dir_all(t.0.join("notes/img")).unwrap();
        std::fs::write(t.0.join("notes/a.md"), "# a\n![](img/x.png)\n").unwrap();
        std::fs::write(t.0.join("notes/img/x.png"), [1u8, 2, 3]).unwrap();
        std::fs::write(t.0.join("secret.txt"), "no").unwrap();
        let win = crate::Win::new("main", None);
        let url = |p: &Path| {
            let js = crate::outside::js_path(p);
            let raw = js.trim_start_matches("abs:").trim_start_matches('/');
            let enc: String = raw.split('/').map(|s| percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()).collect::<Vec<_>>().join("/");
            format!("/~abs/{enc}")
        };
        let img = t.0.join("notes/img/x.png");
        assert_eq!(serve_for(Some(&win), &get(&url(&img), None)).status(), StatusCode::NOT_FOUND, "nothing registered yet");
        win.outside.register_quiet(&t.0.join("notes/a.md"));
        let r = serve_for(Some(&win), &get(&url(&img), None));
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), &vec![1u8, 2, 3]);
        assert_eq!(serve_for(Some(&win), &get(&url(&t.0.join("secret.txt")), None)).status(), StatusCode::NOT_FOUND);
        // A window with no vault serves no vault file.
        assert_eq!(serve_for(Some(&win), &get("/a.md", None)).status(), StatusCode::NOT_FOUND);
    }
}
