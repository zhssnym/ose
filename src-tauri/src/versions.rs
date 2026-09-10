//! Versions (batch 12, package P5): the previous content of a vault file, kept under
//! `.ose/versions/<rel path>/<timestamp>.md` before a save changes it, with a cap per file
//! and per vault. See docs/CONTRACT.md batch 12 "Versions".

use serde_json::Value;

use crate::Ctx;

/// `None` means "not mine", like every module handler.
pub fn handle(_ctx: &Ctx, _cmd: &str, _args: &[Value]) -> Option<Result<Value, String>> {
    None
}
