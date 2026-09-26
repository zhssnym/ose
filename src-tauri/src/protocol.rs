//! The `vault` URI scheme: the vault served read-only to the webview, so `<img src>` can point
//! at a file in the tree. Tauri maps it to `http://vault.localhost/<path>` on Windows and
//! `vault://localhost/<path>` elsewhere; the adapter's `assetUrl` knows which.

use std::path::Path;

use tauri::http::{header, Method, Request, Response, StatusCode};

use crate::vault;

/// The handler main.rs registers: reads the root at request time, so a vault picked after
/// startup is served from the first `<img>` on.
pub fn serve_current(st: &crate::AppState, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    match st.root() {
        Some(root) => serve(&root, request),
        None => plain(StatusCode::NOT_FOUND, crate::NO_VAULT),
    }
}

pub fn serve(root: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }

    let decoded = percent_encoding::percent_decode_str(request.uri().path())
        .decode_utf8_lossy()
        .to_string();

    let Ok(full) = vault::resolve(root, &decoded) else {
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

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_of(&ext))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-cache")
        // A file is what its extension says, never what its bytes look like (L18).
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    // A vault file that could run script when opened as a document (an HTML page, an SVG, an
    // XML file) runs none: it is shown, never executed. An `<img>` of an SVG is unaffected, and
    // the other types (a PDF above all, which the web view's own viewer draws) get no sandbox.
    if active(&ext) {
        response = response.header(header::CONTENT_SECURITY_POLICY, "sandbox");
    }
    response
        .body(bytes)
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
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
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "txt" | "md" => "text/plain; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_types() {
        assert_eq!(mime_of("png"), "image/png");
        assert_eq!(mime_of("md"), "text/plain; charset=utf-8");
        assert_eq!(mime_of("zip"), "application/octet-stream");
    }

    #[test]
    fn active_content_is_sandboxed_and_nothing_is_sniffed() {
        let dir = std::env::temp_dir().join(format!("ose-protocol-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.html"), "<script>1</script>").unwrap();
        std::fs::write(dir.join("b.pdf"), "%PDF-1.4").unwrap();
        let get = |p: &str| serve(&dir, &Request::builder().uri(p).body(Vec::new()).unwrap());
        let html = get("/a.html");
        assert_eq!(html.headers()[header::CONTENT_SECURITY_POLICY], "sandbox");
        assert_eq!(html.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        let pdf = get("/b.pdf");
        assert!(pdf.headers().get(header::CONTENT_SECURITY_POLICY).is_none());
        assert_eq!(pdf.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
