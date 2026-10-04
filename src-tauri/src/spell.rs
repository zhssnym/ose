//! Spellcheck as plain underlines and nothing more: what the host has to say to the web view
//! before the first window exists.
//!
//! - **macOS.** The system's checker works out the language of a sentence by itself, so French
//!   and English are both checked. But a web view in an app underlines nothing until "Check
//!   Spelling While Typing" is on, which is a default of the app's own domain
//!   (`WebContinuousSpellCheckingEnabled`), and it rewrites words as they are typed when the
//!   system's "Correct spelling automatically" is on (`WebAutomaticSpellingCorrectionEnabled`).
//!   The first is turned on and the second off, for this app only.
//! - **Windows.** Nothing to say. WebView2 checks one language, the system's first, and puts
//!   its list (`spellcheck.dictionaries` in the profile's `Preferences`) back to that one
//!   language every time it starts: adding the system's other languages to the file before the
//!   web view reads it was tried and does not survive a launch, and WebView2 has no API for it.
//!
//! Nothing here can stop the app from starting: a failure is a line in the log.

/// macOS: underline while typing, and never rewrite a word, in this app's own defaults.
/// Answers what it did, for the log.
#[cfg(target_os = "macos")]
pub fn prepare(identifier: &str) -> Result<&'static str, String> {
    for (key, value) in [("WebContinuousSpellCheckingEnabled", "true"), ("WebAutomaticSpellingCorrectionEnabled", "false")] {
        let status = std::process::Command::new("/usr/bin/defaults")
            .args(["write", identifier, key, "-bool", value])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("defaults write {key}: {status}"));
        }
    }
    Ok("underlines on, autocorrect off")
}

#[cfg(not(target_os = "macos"))]
pub fn prepare(_identifier: &str) -> Result<&'static str, String> {
    Ok("the web view's own")
}
