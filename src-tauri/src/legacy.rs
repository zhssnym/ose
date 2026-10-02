//! The one-time rescue of what the page kept under its old origin (docs/HOST.md "The old
//! origin").
//!
//! Up to wave 2 the page was served from the `app` origin (`http://app.localhost` on Windows,
//! `app://localhost` elsewhere); since the standard layout it is Tauri's own
//! (`http://tauri.localhost`). `localStorage` belongs to an origin, so two things the old page
//! kept there would be out of reach after the upgrade, with no message:
//!
//! - `os.journal.draft`: the unsent composer text of the 1.0.0 journal plugin, which the
//!   planner's `recoverOldDraft` exists to rescue;
//! - `os.theme`: the theme the person chose (`light`, `dark`, `system`).
//!
//! So on the first launch after the upgrade, once, the host opens a hidden window on the old
//! origin. Its page (served here, a few lines, no IPC) reads those two keys and posts them back
//! to this origin. The host keeps them in `local/app.json` under `legacyOrigin` (a host key the
//! page can neither read nor overwrite), and writes each into the new origin's `localStorage`
//! where that key is still empty, by evaluating a line in a window whose page has loaded. From
//! there the planner and the theme find them exactly where they always looked. Nothing already
//! set under the new origin is ever overwritten.
//!
//! The attempt is made once: `legacyOrigin.tried` is written before the window opens, so a
//! launch where the old store cannot be read (a fresh machine, a platform where it never
//! existed) costs one hidden window once and never again. The window closes itself when the
//! answer comes, and after `WAIT` in any case.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::Manager as _;

use crate::{local, log_line, Host};

/// The hidden window's label.
pub const LABEL: &str = "legacy";
/// The scheme of the old origin.
pub const SCHEME: &str = "app";
/// The key of `local/app.json` that holds what was rescued.
pub const KEY: &str = "legacyOrigin";
/// The `localStorage` keys the old page kept that are worth carrying over.
pub const KEYS: [&str; 2] = ["os.journal.draft", "os.theme"];
/// How long the hidden window may take before it is closed anyway.
const WAIT: Duration = Duration::from_secs(10);

/// Set once a page of a normal window has finished loading: from then on the rescued values can
/// be written into the new origin at once.
static LOADED: AtomicBool = AtomicBool::new(false);

/// The old origin, as the old host spelled it.
fn origin() -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost")
    } else {
        format!("{SCHEME}://localhost")
    }
}

const PAGE: &str = "<!doctype html><meta charset=\"utf-8\"><title>ose</title><script src=\"/legacy.js\"></script>\n";

/// Reads the keys and posts them back. Every key is sent, `null` when absent, so the host can
/// tell "nothing there" from "could not read".
const SCRIPT: &str = r#"(function () {
  var out = {};
  var keys = ["os.journal.draft", "os.theme"];
  try {
    for (var i = 0; i < keys.length; i++) out[keys[i]] = window.localStorage.getItem(keys[i]);
  } catch (e) {
    out = { error: String(e) };
  }
  fetch("/legacy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) })
    .catch(function () {});
})();
"#;

/// Opens the hidden window, once per machine (per app identifier).
pub fn start(app: &tauri::AppHandle) {
    let host = app.state::<Host>();
    let host = host.inner();
    let Some(config) = host.config_dir() else { return };
    if local::host_get(&config, KEY).is_some() {
        return;
    }
    if let Err(e) = local::host_set(&config, KEY, json!({ "tried": crate::versions::now_ms() })) {
        log_line(host, &format!("old origin: not tried, the local store cannot be written: {e}"));
        return;
    }
    let url = match format!("{}/legacy.html", origin()).parse() {
        Ok(u) => u,
        Err(e) => {
            log_line(host, &format!("old origin: {e}"));
            return;
        }
    };
    let built = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::External(url))
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .title("ose")
        .build();
    match built {
        Ok(window) => {
            log_line(host, "old origin: reading what the previous version kept in this machine's page store");
            std::thread::spawn(move || {
                std::thread::sleep(WAIT);
                let _ = window.destroy();
            });
        }
        Err(e) => log_line(host, &format!("old origin: the hidden window did not open: {e}")),
    }
}

/// The `app` scheme: the page, its script, and the one post, for the hidden window only.
/// Answers the response and whether the hidden window is done (main.rs closes it after the
/// response is sent, never from inside the request).
pub fn serve(app: &tauri::AppHandle, label: &str, request: &Request<Vec<u8>>) -> (Response<Vec<u8>>, bool) {
    let not_found = || answer(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"not found".to_vec());
    if label != LABEL {
        return (not_found(), false);
    }
    match (request.method(), request.uri().path()) {
        (&Method::GET, "/legacy.html") => (answer(StatusCode::OK, "text/html; charset=utf-8", PAGE.as_bytes().to_vec()), false),
        (&Method::GET, "/legacy.js") => (answer(StatusCode::OK, "text/javascript; charset=utf-8", SCRIPT.as_bytes().to_vec()), false),
        (&Method::POST, "/legacy") => {
            received(app, request.body());
            (answer(StatusCode::NO_CONTENT, "text/plain; charset=utf-8", Vec::new()), true)
        }
        _ => (not_found(), false),
    }
}

/// Closes the hidden window.
pub fn close(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
}

fn answer(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; script-src 'self'; connect-src 'self'")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .expect("static response builds")
}

/// The values the old page posted: only the known keys, only strings.
pub fn values_of(body: &[u8]) -> Result<Map<String, Value>, String> {
    let v: Value = serde_json::from_slice(body).map_err(|e| format!("not JSON: {e}"))?;
    if let Some(e) = v.get("error").and_then(Value::as_str) {
        return Err(format!("the old store could not be read: {e}"));
    }
    let mut out = Map::new();
    for k in KEYS {
        if let Some(Value::String(s)) = v.get(k) {
            out.insert(k.to_string(), Value::String(s.clone()));
        }
    }
    Ok(out)
}

fn received(app: &tauri::AppHandle, body: &[u8]) {
    let host = app.state::<Host>();
    let host = host.inner();
    let Some(config) = host.config_dir() else { return };
    let mut record = local::host_get(&config, KEY).and_then(|v| v.as_object().cloned()).unwrap_or_default();
    if record.contains_key("done") {
        return;
    }
    record.insert("done".into(), json!(crate::versions::now_ms()));
    match values_of(body) {
        Ok(values) => {
            let names: Vec<&str> = values.keys().map(String::as_str).collect();
            log_line(
                host,
                &if names.is_empty() {
                    "old origin: nothing to carry over".to_string()
                } else {
                    format!("old origin: carried over {}", names.join(", "))
                },
            );
            if !values.is_empty() {
                record.insert("values".into(), Value::Object(values));
            }
        }
        Err(e) => {
            log_line(host, &format!("old origin: {e}"));
            record.insert("error".into(), json!(e));
        }
    }
    if let Err(e) = local::host_set(&config, KEY, Value::Object(record)) {
        log_line(host, &format!("old origin: not kept: {e}"));
        return;
    }
    if LOADED.load(Ordering::SeqCst) {
        apply(app);
    }
}

/// A normal window's page finished loading: the values go into the new origin now, if they are
/// waiting. Called from main.rs's page-load hook.
pub fn page_loaded(app: &tauri::AppHandle) {
    LOADED.store(true, Ordering::SeqCst);
    apply(app);
}

/// The line that writes each rescued value where the new origin's key is still empty.
pub fn script_for(values: &Map<String, Value>) -> String {
    let json = serde_json::to_string(values).unwrap_or_else(|_| "{}".into());
    format!(
        "(function(){{try{{var v={json};for(var k in v){{if(typeof v[k]==='string'&&localStorage.getItem(k)===null)localStorage.setItem(k,v[k]);}}}}catch(e){{}}}})();"
    )
}

/// Writes the waiting values into the new origin, through the first normal window, once.
fn apply(app: &tauri::AppHandle) {
    let host = app.state::<Host>();
    let host = host.inner();
    let Some(config) = host.config_dir() else { return };
    let Some(mut record) = local::host_get(&config, KEY).and_then(|v| v.as_object().cloned()) else { return };
    if record.contains_key("applied") {
        return;
    }
    let Some(values) = record.get("values").and_then(Value::as_object).cloned() else { return };
    let Some(window) = app.webview_windows().into_iter().find(|(l, _)| l != LABEL).map(|(_, w)| w) else { return };
    match window.eval(script_for(&values)) {
        Ok(()) => {
            record.insert("applied".into(), json!(crate::versions::now_ms()));
            if let Err(e) = local::host_set(&config, KEY, Value::Object(record)) {
                log_line(host, &format!("old origin: {e}"));
            }
            log_line(host, "old origin: written into the page store where it was empty");
        }
        Err(e) => log_line(host, &format!("old origin: not written into the page store: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_known_string_keys_are_kept() {
        let v = values_of(br#"{"os.journal.draft":"typed, not sent","os.theme":"light","other":"x"}"#).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v["os.journal.draft"], "typed, not sent");
        let v = values_of(br#"{"os.journal.draft":null,"os.theme":null}"#).unwrap();
        assert!(v.is_empty());
        assert!(values_of(br#"{"error":"SecurityError"}"#).is_err());
        assert!(values_of(b"nope").is_err());
    }

    #[test]
    fn the_script_carries_any_text_as_a_string_and_never_overwrites() {
        let mut v = Map::new();
        v.insert("os.journal.draft".into(), json!("a \"quote\", a </script> and a\nline"));
        let s = script_for(&v);
        assert!(s.contains(r#""a \"quote\", a </script> and a\nline""#), "{s}");
        assert!(s.contains("localStorage.getItem(k)===null"), "{s}");
    }
}
