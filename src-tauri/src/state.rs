//! `<root>/.ose/state.json`: the UI's whole persisted state plus the two keys the host owns,
//! `window` (bounds) and `theme` (first paint colour). Writes are atomic: temp file, rename.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::Ctx;

/// Serialises read-modify-write cycles so a `setState` and a host patch cannot interleave.
static GATE: Mutex<()> = Mutex::new(());

pub fn state_path(root: &Path) -> PathBuf {
    root.join(".ose").join("state.json")
}

/// Always an object. A missing, empty or corrupt file reads as `{}` and is overwritten on the
/// next write; losing the UI's layout is better than refusing to start.
pub fn get(root: &Path) -> Value {
    let path = state_path(root);
    let Ok(text) = fs::read_to_string(&path) else {
        return json!({});
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v @ Value::Object(_)) => v,
        _ => json!({}),
    }
}

/// The whole state, as the UI holds it. `window` and `theme` are the host's own, written through
/// `patch` from the window itself, so a UI write that does not carry them keeps what is on disk:
/// otherwise a save racing the geometry patch would put the window back where it was two moves
/// ago.
pub fn set(root: &Path, value: &Value) -> Result<(), String> {
    let _guard = GATE.lock().unwrap_or_else(|p| p.into_inner());
    let mut next = value.clone();
    if let Some(map) = next.as_object_mut() {
        let on_disk = get(root);
        for key in ["window", "theme"] {
            if !map.contains_key(key) {
                if let Some(v) = on_disk.get(key) {
                    map.insert(key.to_string(), v.clone());
                }
            }
        }
    }
    write_locked(root, &next)
}

fn write_locked(root: &Path, value: &Value) -> Result<(), String> {
    let obj = if value.is_object() {
        value.clone()
    } else {
        json!({})
    };
    let path = state_path(root);
    let dir = path.parent().ok_or("no state folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    let text = serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text.as_bytes()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Read, merge one key, write. The host uses it for `window` and `theme` so it never clobbers
/// the keys the UI owns.
pub fn patch(root: &Path, key: &str, value: Value) -> Result<(), String> {
    let _guard = GATE.lock().unwrap_or_else(|p| p.into_inner());
    let mut state = get(root);
    match state.as_object_mut() {
        Some(map) => {
            map.insert(key.to_string(), value);
        }
        None => return Err("state is not an object".to_string()),
    }
    write_locked(root, &state)
}

// ---- theme -----------------------------------------------------------------

/// The UI keeps its preference in localStorage and pushes the resolved value down with
/// `winSetTheme`; the host mirrors it here so the very first paint of the next launch is
/// already the right colour. Unset means dark, which is what the kernel's theme defaults to.
pub fn theme(root: &Path) -> &'static str {
    match get(root).get("theme").and_then(Value::as_str) {
        Some("light") => "light",
        _ => "dark",
    }
}

pub const DARK_BG: (u8, u8, u8) = (0x1A, 0x19, 0x17);
pub const LIGHT_BG: (u8, u8, u8) = (0xFA, 0xF9, 0xF5);

pub fn background_of(theme: &str) -> (u8, u8, u8) {
    if theme == "dark" {
        DARK_BG
    } else {
        LIGHT_BG
    }
}

// ---- window bounds ---------------------------------------------------------

/// Physical pixels, the same unit `outer_position`, `outer_size` and `Monitor` all speak.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub maximized: bool,
}

/// A monitor rectangle: position and size, physical pixels.
pub type MonitorRect = (i32, i32, u32, u32);

pub fn read_window(root: &Path) -> Option<Bounds> {
    let state = get(root);
    let w = state.get("window")?.as_object()?;
    let num = |k: &str| w.get(k).and_then(Value::as_i64);
    Some(Bounds {
        x: num("x")? as i32,
        y: num("y")? as i32,
        w: num("w")?.max(0) as u32,
        h: num("h")?.max(0) as u32,
        maximized: w.get("maximized").and_then(Value::as_bool).unwrap_or(false),
    })
}

pub fn save_window(root: &Path, b: Bounds) -> Result<(), String> {
    patch(
        root,
        "window",
        json!({ "x": b.x, "y": b.y, "w": b.w, "h": b.h, "maximized": b.maximized }),
    )
}

/// Saved bounds are only used when they are at least the minimum size and a real corner of the
/// window still lands on a monitor that exists now (the .NET host's rule: 120x60 of overlap).
pub fn usable(b: Bounds, monitors: &[MonitorRect]) -> bool {
    if b.w < 720 || b.h < 480 {
        return false;
    }
    if monitors.is_empty() {
        return false;
    }
    let (l, t) = (b.x as i64, b.y as i64);
    let (r, bo) = (l + b.w as i64, t + b.h as i64);
    monitors.iter().any(|&(mx, my, mw, mh)| {
        let (ml, mt) = (mx as i64, my as i64);
        let (mr, mb) = (ml + mw as i64, mt + mh as i64);
        let ow = r.min(mr) - l.max(ml);
        let oh = bo.min(mb) - t.max(mt);
        ow >= 120 && oh >= 60
    })
}

// ---- dispatch --------------------------------------------------------------

pub fn handle(ctx: &Ctx, cmd: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if !matches!(cmd, "getState" | "setState") {
        return None;
    }
    // The state file lives inside the vault, so there is none to read without one.
    let root = match ctx.st.require_root() {
        Ok(r) => r,
        Err(e) => return Some(Err(e)),
    };
    match cmd {
        "getState" => Some(Ok(get(&root))),
        "setState" => {
            let value = args.first().cloned().unwrap_or_else(|| json!({}));
            Some(set(&root, &value).map(|_| Value::Null))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_need_a_monitor() {
        let b = Bounds { x: 100, y: 100, w: 1280, h: 800, maximized: false };
        assert!(usable(b, &[(0, 0, 1920, 1080)]));
        assert!(!usable(b, &[(5000, 5000, 1920, 1080)]));
        assert!(!usable(b, &[]));
        let small = Bounds { w: 300, h: 200, ..b };
        assert!(!usable(small, &[(0, 0, 1920, 1080)]));
    }

    #[test]
    fn a_window_hanging_off_the_right_edge_is_still_usable() {
        let b = Bounds { x: 1800, y: 0, w: 1280, h: 800, maximized: false };
        assert!(usable(b, &[(0, 0, 1920, 1080)]));
        let barely = Bounds { x: 1900, ..b };
        assert!(!usable(barely, &[(0, 0, 1920, 1080)]));
    }
}
