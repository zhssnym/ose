//! Print: the PDF the host writes, and the system print dialog.
//!
//! Both are WebView2's own, so both are Windows only. The page never calls `window.print()`:
//! in WebView2 that blocks the renderer and the app stops answering (the sheet the owner saw
//! render a tenth of a page and jam). Instead:
//!
//!   `printToPdf(path, { name, folder })`  `ICoreWebView2_7::PrintToPdf` writes the file and
//!                                          the command returns `{path, bytes}` when it is on
//!                                          disk. With no `path` the host asks where through
//!                                          the native save dialog, and answers
//!                                          `{cancelled:true}` when that is cancelled.
//!   `showPrintUI()`                        `ICoreWebView2_16::ShowPrintUI` with
//!                                          `COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM`, which is
//!                                          the Windows dialog and therefore also the way to
//!                                          "Microsoft Print to PDF". It returns as soon as the
//!                                          dialog is up; nothing waits on the user.
//!
//! The sheet itself is CSS, not settings: `src/editor/print.css` holds `@page` (A4, 2cm) and
//! every `@media print` rule. The settings below say A4 portrait with margins of zero, so the
//! CSS margin is the only one and one file decides the geometry; measured, a `--print-margin`
//! of 0cm puts the fixture on one page and 2cm on two, so it is the stylesheet that governs.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::{log_line, opt_field_str, vault, Ctx};

/// A4 in inches, which is the unit `ICoreWebView2PrintSettings` counts in: 210mm by 297mm.
#[cfg(windows)]
const A4_WIDTH_IN: f64 = 8.267_716_5;
#[cfg(windows)]
const A4_HEIGHT_IN: f64 = 11.692_913_4;

/// The synchronous half of the pair. `printToPdf` waits on a dialog and on the webview, so it
/// is awaited in `lib.rs` beside `pickVault` instead of being answered here.
pub fn handle(ctx: &Ctx, cmd: &str, _args: &[Value]) -> Option<Result<Value, String>> {
    match cmd {
        "showPrintUI" => Some(show_print_ui(ctx)),
        _ => None,
    }
}

/// `printToPdf(path, { name, folder })`. Answers `{ path }` with the file written, or `null`
/// when the user cancelled the save dialog.
pub async fn to_pdf(ctx: &Ctx<'_>, args: &[Value]) -> Result<Value, String> {
    let given = args
        .first()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let path = match given {
        Some(p) => p,
        None => match ask_where(ctx, args).await? {
            Some(p) => p,
            None => {
                log_line(ctx.st, "printToPdf: cancelled");
                // Not `null`: a host that has no such command answers `null` (`gone`), and the
                // page has to be able to tell "the user said no" from "this host cannot".
                return Ok(json!({ "cancelled": true }));
            }
        },
    };

    write_pdf(ctx, &path).await?;
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    log_line(ctx.st, &format!("printToPdf: wrote {} ({bytes} bytes)", path.display()));
    Ok(json!({ "path": path.to_string_lossy(), "bytes": bytes }))
}

/// The native save dialog: the page's own folder in the vault, and the page's title with a
/// `.pdf` on it. The dialog itself belongs to the binary (see `AppState::saver`), because the
/// dialog plugin needs the application manifest that only a bin target carries.
async fn ask_where(ctx: &Ctx<'_>, args: &[Value]) -> Result<Option<PathBuf>, String> {
    let saver = ctx
        .st
        .saver
        .ok_or_else(|| "this build has no save dialog".to_string())?;

    let name = file_name(&opt_field_str(args, 1, "name").unwrap_or_default());
    let folder = match (ctx.st.root(), opt_field_str(args, 1, "folder")) {
        (Some(root), Some(rel)) => vault::resolve(&root, &rel).ok().filter(|p| p.is_dir()).or(Some(root)),
        (root, _) => root,
    };

    log_line(
        ctx.st,
        &format!("printToPdf: asking where to save {name} (in {})", folder.as_deref().unwrap_or(Path::new("-")).display()),
    );

    let (tx, mut rx) = tauri::async_runtime::channel::<Option<PathBuf>>(1);
    saver(
        ctx.app,
        folder,
        name,
        Box::new(move |chosen| {
            let _ = tx.try_send(chosen);
        }),
    );
    Ok(rx.recv().await.flatten())
}

/// A page title is prose and may hold anything; a file name may not. Everything Windows
/// forbids becomes a space, the result is trimmed and capped, and an empty one falls back.
fn file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 { ' ' } else { c })
        .collect();
    let mut stem: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(rest) = stem.strip_suffix(".pdf") {
        stem = rest.trim_end().to_string();
    }
    if stem.chars().count() > 120 {
        stem = stem.chars().take(120).collect();
    }
    let stem = stem.trim_matches('.').trim();
    format!("{}.pdf", if stem.is_empty() { "page" } else { stem })
}

// ---- the webview ------------------------------------------------------------

#[cfg(windows)]
async fn write_pdf(ctx: &Ctx<'_>, path: &Path) -> Result<(), String> {
    use tauri::Manager as _;

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
    }

    let window = ctx
        .app
        .get_webview_window("main")
        .ok_or_else(|| "no window to print".to_string())?;

    // The COM calls below must run on the thread that owns the webview; `with_webview` hands
    // the closure to it and returns at once. The answer comes back over the channel, either
    // from the failing call or from WebView2's completion handler.
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<(), String>>(1);
    let target: Vec<u16> = path.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    window
        .with_webview(move |webview| {
            let done = tx.clone();
            if let Err(e) = unsafe { start_print_to_pdf(&webview, &target, move |r| { let _ = done.try_send(r); }) } {
                let _ = tx.try_send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;

    rx.recv().await.unwrap_or_else(|| Err("the webview never answered the print".to_string()))
}

/// The WebView2 side of `printToPdf`, on the UI thread. `done` is called once, either here with
/// the failure or from WebView2's completion handler.
#[cfg(windows)]
unsafe fn start_print_to_pdf(
    webview: &tauri::webview::PlatformWebview,
    target: &[u16],
    done: impl FnOnce(Result<(), String>) + 'static,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, PCWSTR};

    let fail = |what: &str, e: windows_core::Error| format!("{what}: {e}");

    let core = webview
        .controller()
        .CoreWebView2()
        .map_err(|e| fail("CoreWebView2", e))?;

    // The print settings come from the environment, which is reached through the webview
    // itself: ICoreWebView2_2 has the environment, ICoreWebView2Environment6 the factory.
    let environment = core
        .cast::<ICoreWebView2_2>()
        .map_err(|e| fail("ICoreWebView2_2", e))?
        .Environment()
        .map_err(|e| fail("Environment", e))?;
    let settings = environment
        .cast::<ICoreWebView2Environment6>()
        .map_err(|e| fail("ICoreWebView2Environment6", e))?
        .CreatePrintSettings()
        .map_err(|e| fail("CreatePrintSettings", e))?;

    settings
        .SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)
        .and_then(|_| settings.SetPageWidth(A4_WIDTH_IN))
        .and_then(|_| settings.SetPageHeight(A4_HEIGHT_IN))
        // Zero here, 2cm in the stylesheet's `@page`: one file decides the geometry.
        .and_then(|_| settings.SetMarginTop(0.0))
        .and_then(|_| settings.SetMarginBottom(0.0))
        .and_then(|_| settings.SetMarginLeft(0.0))
        .and_then(|_| settings.SetMarginRight(0.0))
        // Backgrounds OFF, which is not what it sounds like. With them on, WebView2 paints the
        // whole page box — margins included — with the webview's own default background colour,
        // and the host sets that from the theme: a sheet exported from the dark theme came out
        // as a dark grey page with a white text block inside it (measured in the PDF's content
        // stream: `.102 .098 .0902 ... 0 0 794 1123 re f`). No stylesheet can reach that fill;
        // `html { background: red }` under `@media print` colours the text block and leaves the
        // page box alone. With them off the fill is gone and the paper is paper. Nothing is lost
        // by it: under `@media print` every background in the palette is white already. The one
        // exception, the black fill of a done task's checkbox, print.css draws as a ticked
        // outline instead. Rules, frames and borders are not backgrounds and print either way.
        .and_then(|_| settings.SetShouldPrintBackgrounds(false))
        .and_then(|_| settings.SetShouldPrintHeaderAndFooter(false))
        .and_then(|_| settings.SetShouldPrintSelectionOnly(false))
        .and_then(|_| settings.SetScaleFactor(1.0))
        .map_err(|e| fail("PrintSettings", e))?;

    let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, written| {
        done(match result {
            Err(e) => Err(format!("PrintToPdf: {e}")),
            Ok(()) if !written => Err("PrintToPdf could not write the file".to_string()),
            Ok(()) => Ok(()),
        });
        Ok(())
    }));

    core.cast::<ICoreWebView2_7>()
        .map_err(|e| fail("ICoreWebView2_7", e))?
        .PrintToPdf(PCWSTR(target.as_ptr()), &settings, &handler)
        .map_err(|e| fail("PrintToPdf", e))
}

/// `showPrintUI()`: the Windows print dialog, which is also how "Microsoft Print to PDF" is
/// reached. It returns as soon as the dialog is asked for; the user is not waited on.
#[cfg(windows)]
fn show_print_ui(ctx: &Ctx) -> Result<Value, String> {
    use tauri::Manager as _;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows_core::Interface;

    let window = ctx
        .app
        .get_webview_window("main")
        .ok_or_else(|| "no window to print".to_string())?;

    window
        .with_webview(|webview| unsafe {
            let shown = webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.cast::<ICoreWebView2_16>())
                .and_then(|w| w.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM));
            if let Err(e) = shown {
                eprintln!("showPrintUI: {e}");
            }
        })
        .map_err(|e| e.to_string())?;

    log_line(ctx.st, "showPrintUI: the system print dialog");
    Ok(json!({ "shown": true }))
}

// ---- everywhere else --------------------------------------------------------

/// The macOS sources stay in the tree, unbuilt (docs/HOST.md "CI"). Printing is the one thing
/// with no cross-platform half at all, so it says so rather than pretending.
#[cfg(not(windows))]
async fn write_pdf(_ctx: &Ctx<'_>, _path: &Path) -> Result<(), String> {
    Err("printing to PDF is WebView2's own and exists on Windows only".to_string())
}

#[cfg(not(windows))]
fn show_print_ui(_ctx: &Ctx) -> Result<Value, String> {
    Err("the system print dialog is WebView2's own and exists on Windows only".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_becomes_a_file_name() {
        assert_eq!(file_name("Suites arithmétiques"), "Suites arithmétiques.pdf");
        // A slash, a colon and a run of spaces are all a file name cannot carry.
        assert_eq!(file_name("school/1-math: ch1"), "school 1-math ch1.pdf");
        assert_eq!(file_name("  "), "page.pdf");
        assert_eq!(file_name(""), "page.pdf");
        // The caller may have added the extension already; it is not doubled.
        assert_eq!(file_name("Todo.pdf"), "Todo.pdf");
        // A name that is only dots is no name.
        assert_eq!(file_name("..."), "page.pdf");
    }
}
