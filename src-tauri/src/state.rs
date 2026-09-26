//! `<root>/.ose/state.json`: what belongs to the vault and travels with it (pins, the planner's
//! paths, the vault's settings). Writes are atomic: `vault::write_atomic_owned`.
//!
//! The window bounds and the theme mirror used to live here too, which put one machine's
//! screen into every synced copy of the vault (M26). They are read and written in the
//! per-machine store now (local.rs); what is below reads the old keys once, for the first
//! launch after the upgrade, and never writes them again.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};


/// Serialises read-modify-write cycles so a `setState` and a host patch cannot interleave.
static GATE: Mutex<()> = Mutex::new(());

/// How long a refused rename of the state file is tried again. Short: the close handshake
/// writes it on the main thread.
const STATE_BUDGET_MS: u64 = 100;

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
    // A vault folder that is gone is not recreated for its state file (a ghost vault).
    crate::vault::require_vault(root)?;
    let path = state_path(root);
    let dir = path.parent().ok_or("no state folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    let text = serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?;
    // The host's atomic writer (C3), no delete first, in its mode for a file the app owns: the
    // UI holds the same data, so a rename refused for longer than a moment removes the temp
    // file rather than leaving `.ose/state.unsaved-*.json` for a synced vault to carry, and the
    // window's close never waits seconds on a scanner.
    crate::vault::write_atomic_owned(&path, text.as_bytes(), STATE_BUDGET_MS)
        .map_err(|f| f.message(".ose/state.json", Some(root)))
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

/// The resolved theme a vault's state file still carries from before the per-machine store,
/// if any: `dark` or `light`. Read once, as the fallback of a first launch after the upgrade.
pub fn theme(root: &Path) -> Option<&'static str> {
    theme_of(get(root).get("theme"))
}

/// `"dark"` or `"light"` out of a stored value, anything else `None`.
pub fn theme_of(v: Option<&Value>) -> Option<&'static str> {
    match v.and_then(Value::as_str) {
        Some("light") => Some("light"),
        Some("dark") => Some("dark"),
        _ => None,
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

/// The bounds a vault's state file still carries from before the per-machine store.
pub fn read_window(root: &Path) -> Option<Bounds> {
    bounds_of(get(root).get("window")?)
}

/// Bounds out of a stored `{x, y, w, h, maximized}`.
pub fn bounds_of(v: &Value) -> Option<Bounds> {
    let w = v.as_object()?;
    let num = |k: &str| w.get(k).and_then(Value::as_i64);
    Some(Bounds {
        x: num("x")? as i32,
        y: num("y")? as i32,
        w: num("w")?.max(0) as u32,
        h: num("h")?.max(0) as u32,
        maximized: w.get("maximized").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// Bounds as they are stored.
pub fn bounds_json(b: Bounds) -> Value {
    json!({ "x": b.x, "y": b.y, "w": b.w, "h": b.h, "maximized": b.maximized })
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

    /// A vault folder that is gone is not recreated for its state file.
    #[test]
    fn a_lost_vault_gets_no_state_file() {
        let root = std::env::temp_dir().join(format!("ose-state-lost-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        assert!(set(&root, &json!({ "a": 1 })).unwrap_err().starts_with("[no_vault]"));
        assert!(patch(&root, "window", json!({})).unwrap_err().starts_with("[no_vault]"));
        assert!(!root.exists());
    }
}
