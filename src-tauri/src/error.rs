//! `HostError`: the one error every command answers (docs/HOST.md "Errors").
//!
//! It goes to the page as `{ code, message }`, where `code` is one of the words below and
//! `message` says what happened in prose. The page acts on the code ("the file is gone", "the
//! disk said no", "this page belongs to the vault that was just left") and shows the message.
//!
//! The module functions under the commands still speak `Result<_, String>` with a `[code] `
//! prefix, the convention the host had before its commands were typed; `From<String>` reads the
//! code back out, and a code it does not know, or none at all, is `io`. So a module that grows a
//! new refusal never needs this file, and a typo in a code can only ever make an error vaguer,
//! never lose it.

use serde::Serialize;

/// Every refusal a command can answer. `#[serde(tag, content)]` makes each variant
/// `{ "code": "<snake_case name>", "message": "<text>" }` on the wire.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum HostError {
    /// The file or folder is not there.
    #[error("{0}")]
    NotFound(String),
    /// Something is already at the target of a create-only write.
    #[error("{0}")]
    Exists(String),
    /// The file is not valid in the encoding it was asked to be read in.
    #[error("{0}")]
    NotUtf8(String),
    /// A character of the text has no bytes in the file's encoding; nothing was written.
    #[error("{0}")]
    Unencodable(String),
    /// The file's bytes do not survive a decode and an encode: it opens read-only, and a save
    /// in its encoding is refused.
    #[error("{0}")]
    Lossy(String),
    /// The page belongs to another vault epoch than the one this window has open.
    #[error("{0}")]
    StaleVault(String),
    /// This window has no vault open.
    #[error("{0}")]
    NoVault(String),
    /// The write did not go through; the message says where the bytes are when they survived.
    #[error("{0}")]
    WriteFailed(String),
    /// An argument that is not what the command takes.
    #[error("{0}")]
    BadArg(String),
    /// A name the filesystem would refuse or silently change.
    #[error("{0}")]
    BadName(String),
    /// A path that leaves the vault, or an outside path given to a command that takes none.
    #[error("{0}")]
    EscapesVault(String),
    /// An outside (`abs:`) path this window has not opened.
    #[error("{0}")]
    NotRegistered(String),
    /// Not on this platform, not in this build, or not for an outside file.
    #[error("{0}")]
    Unsupported(String),
    /// Everything else the disk or the system said.
    #[error("{0}")]
    Io(String),
}

impl HostError {
    /// The wire code, as the page reads it (`not_found`, `io`, …).
    pub fn code(&self) -> &'static str {
        match self {
            HostError::NotFound(_) => "not_found",
            HostError::Exists(_) => "exists",
            HostError::NotUtf8(_) => "not_utf8",
            HostError::Unencodable(_) => "unencodable",
            HostError::Lossy(_) => "lossy",
            HostError::StaleVault(_) => "stale_vault",
            HostError::NoVault(_) => "no_vault",
            HostError::WriteFailed(_) => "write_failed",
            HostError::BadArg(_) => "bad_arg",
            HostError::BadName(_) => "bad_name",
            HostError::EscapesVault(_) => "escapes_vault",
            HostError::NotRegistered(_) => "not_registered",
            HostError::Unsupported(_) => "unsupported",
            HostError::Io(_) => "io",
        }
    }

    /// The prose, without the code.
    pub fn message(&self) -> &str {
        match self {
            HostError::NotFound(m)
            | HostError::Exists(m)
            | HostError::NotUtf8(m)
            | HostError::Unencodable(m)
            | HostError::Lossy(m)
            | HostError::StaleVault(m)
            | HostError::NoVault(m)
            | HostError::WriteFailed(m)
            | HostError::BadArg(m)
            | HostError::BadName(m)
            | HostError::EscapesVault(m)
            | HostError::NotRegistered(m)
            | HostError::Unsupported(m)
            | HostError::Io(m) => m,
        }
    }

    /// The error for `code`, with `message`. An unknown code is `io`.
    pub fn of(code: &str, message: impl Into<String>) -> HostError {
        let m = message.into();
        match code {
            "not_found" => HostError::NotFound(m),
            "exists" => HostError::Exists(m),
            "not_utf8" => HostError::NotUtf8(m),
            "unencodable" => HostError::Unencodable(m),
            "lossy" => HostError::Lossy(m),
            "stale_vault" => HostError::StaleVault(m),
            "no_vault" => HostError::NoVault(m),
            "write_failed" => HostError::WriteFailed(m),
            "bad_arg" => HostError::BadArg(m),
            "bad_name" => HostError::BadName(m),
            "escapes_vault" => HostError::EscapesVault(m),
            "not_registered" => HostError::NotRegistered(m),
            "unsupported" => HostError::Unsupported(m),
            _ => HostError::Io(m),
        }
    }

    /// `[code] message`, the string form the log and the dev bridge use.
    pub fn coded(&self) -> String {
        crate::coded(self.code(), self.message())
    }
}

/// `[code] message` from a module function. A string with no code, or with one this enum does
/// not know, is `io` and keeps its whole text.
impl From<String> for HostError {
    fn from(s: String) -> Self {
        let t = s.trim_start();
        if let Some(rest) = t.strip_prefix('[') {
            if let Some((code, message)) = rest.split_once(']') {
                let known = HostError::of(code, "");
                if known.code() == code {
                    return HostError::of(code, message.trim_start());
                }
            }
        }
        HostError::Io(s)
    }
}

impl From<&str> for HostError {
    fn from(s: &str) -> Self {
        HostError::from(s.to_string())
    }
}

impl From<std::io::Error> for HostError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => HostError::NotFound(e.to_string()),
            std::io::ErrorKind::AlreadyExists => HostError::Exists(e.to_string()),
            _ => HostError::Io(e.to_string()),
        }
    }
}

impl From<tauri::Error> for HostError {
    fn from(e: tauri::Error) -> Self {
        HostError::Io(e.to_string())
    }
}

/// What every command returns.
pub type HostResult<T> = Result<T, HostError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_goes_out_as_code_and_message() {
        let e = HostError::NotFound("a.md: gone".into());
        assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({ "code": "not_found", "message": "a.md: gone" }));
        let e = HostError::StaleVault("epoch 1".into());
        assert_eq!(serde_json::to_value(&e).unwrap()["code"], "stale_vault");
        assert_eq!(e.to_string(), "epoch 1");
        assert_eq!(e.coded(), "[stale_vault] epoch 1");
    }

    #[test]
    fn a_coded_string_keeps_its_code_and_anything_else_is_io() {
        assert_eq!(HostError::from("[exists] already exists: a.md".to_string()), HostError::Exists("already exists: a.md".into()));
        assert_eq!(HostError::from("[not_registered] x".to_string()).code(), "not_registered");
        assert_eq!(HostError::from("[no_such_code] x".to_string()), HostError::Io("[no_such_code] x".into()));
        assert_eq!(HostError::from("plain words".to_string()), HostError::Io("plain words".into()));
        assert_eq!(HostError::from("[io]".to_string()), HostError::Io(String::new()));
        // Every variant survives the round trip through its string form.
        for code in [
            "not_found", "exists", "not_utf8", "unencodable", "lossy", "stale_vault", "no_vault", "write_failed",
            "bad_arg", "bad_name", "escapes_vault", "not_registered", "unsupported", "io",
        ] {
            let e = HostError::of(code, "m");
            assert_eq!(e.code(), code);
            assert_eq!(HostError::from(e.coded()), e);
        }
    }
}
