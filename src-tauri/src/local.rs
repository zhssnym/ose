//! The per-machine store (docs/HOST.md "Local state", W5, M26): what belongs to this machine
//! and not to the vault, so it is never synced with it. The session, the recent files, the
//! sidebar, the per-folder sort, the reading settings, the window bounds and the theme mirror.
//!
//! Two JSON objects under the app's config folder:
//!
//! - `local/app.json`: this machine, every vault (`localGet('app')`);
//! - `local/vaults/<vaultKey>.json`: this machine, one vault, filed under the same key as the
//!   drafts (`localGet('vault')`).
//!
//! The page reads and writes whole objects, at most 1 MB each. The `window` key of a vault's
//! object is the host's (the geometry of a window other than `main`), and two keys of `app.json`
//! are the host's own, `window` (the bounds) and `theme` (the resolved theme, the first paint's
//! colour): the page never sees them and cannot overwrite them, so a page holding an old copy
//! of the object can never put the window back where it was two moves ago. Writes go through
//! `vault::write_atomic_owned`: the page still has the object, so a refused rename leaves
//! nothing behind.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::coded;

/// One read-modify-write at a time, for the page's writes and the host's own patches alike.
static GATE: Mutex<()> = Mutex::new(());

/// The most one object may weigh, serialised.
pub const MAX_BYTES: usize = 1024 * 1024;

/// The keys of `app.json` the host owns.
const HOST_KEYS: &[&str] = &["window", "theme"];
/// The keys of a vault's object the host owns: the geometry of a window other than `main`.
const VAULT_HOST_KEYS: &[&str] = &["window"];

fn host_keys(app: bool) -> &'static [&'static str] {
    if app {
        HOST_KEYS
    } else {
        VAULT_HOST_KEYS
    }
}

/// How long a refused rename is tried again: short, the page retries and still has the object.
const BUDGET_MS: u64 = 200;

pub fn app_file(config: &Path) -> PathBuf {
    config.join("local").join("app.json")
}

pub fn vault_file(config: &Path, root: &Path) -> PathBuf {
    config.join("local").join("vaults").join(format!("{}.json", crate::drafts::vault_key(root)))
}

/// Always an object: a missing, empty or corrupt file reads as `{}`.
pub fn read(file: &Path) -> Map<String, Value> {
    fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| match v {
            Value::Object(o) => Some(o),
            _ => None,
        })
        .unwrap_or_default()
}

fn write(file: &Path, value: &Map<String, Value>) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| coded("io", format!("{}: {e}", dir.display())))?;
    }
    let text = serde_json::to_string(value).map_err(|e| coded("io", e))?;
    crate::vault::write_atomic_owned(file, text.as_bytes(), BUDGET_MS).map_err(|f| f.message("local state", None))
}

/// `localGet(scope)` for a file: the object, less the host's keys.
pub fn get(file: &Path, app: bool) -> Value {
    let _gate = GATE.lock().unwrap_or_else(|p| p.into_inner());
    let mut o = read(file);
    for k in host_keys(app) {
        o.remove(*k);
    }
    Value::Object(o)
}

/// `localSet(scope, value)` for a file: the whole object replaced, at most `MAX_BYTES`. In
/// `app.json` the host's keys keep what is on disk whatever the page sent.
pub fn set(file: &Path, value: &Value, app: bool) -> Result<(), String> {
    let Value::Object(given) = value else {
        return Err(coded("bad_arg", "local state is an object"));
    };
    let size = serde_json::to_string(value).map(|t| t.len()).unwrap_or(usize::MAX);
    if size > MAX_BYTES {
        return Err(coded("bad_arg", format!("local state is {size} bytes, more than the 1 MB it may be")));
    }
    let _gate = GATE.lock().unwrap_or_else(|p| p.into_inner());
    let mut next = given.clone();
    let on_disk = read(file);
    for k in host_keys(app) {
        next.remove(*k);
        if let Some(v) = on_disk.get(*k) {
            next.insert((*k).to_string(), v.clone());
        }
    }
    write(file, &next)
}

/// One of the host's own keys of `app.json` (`window`, `theme`), or `None`.
pub fn host_get(config: &Path, key: &str) -> Option<Value> {
    let _gate = GATE.lock().unwrap_or_else(|p| p.into_inner());
    read(&app_file(config)).get(key).cloned()
}

/// Sets one of the host's own keys of `app.json`, keeping everything else.
pub fn host_set(config: &Path, key: &str, value: Value) -> Result<(), String> {
    set_key(&app_file(config), key, value)
}

/// One of the host's own keys of a vault's object (`window`), or `None`.
pub fn vault_host_get(config: &Path, root: &Path, key: &str) -> Option<Value> {
    let _gate = GATE.lock().unwrap_or_else(|p| p.into_inner());
    read(&vault_file(config, root)).get(key).cloned()
}

/// Sets one of the host's own keys of a vault's object, keeping everything else.
pub fn vault_host_set(config: &Path, root: &Path, key: &str, value: Value) -> Result<(), String> {
    set_key(&vault_file(config, root), key, value)
}

fn set_key(file: &Path, key: &str, value: Value) -> Result<(), String> {
    let _gate = GATE.lock().unwrap_or_else(|p| p.into_inner());
    let mut o = read(file);
    o.insert(key.to_string(), value);
    write(file, &o)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("ose-local-{tag}-{stamp}-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_vault_object_round_trips_under_the_drafts_key() {
        let t = Tmp::new("vault");
        let root = t.0.join("My Vault");
        let file = vault_file(&t.0, &root);
        assert_eq!(get(&file, false), json!({}), "nothing yet reads as an empty object");
        let v = json!({ "session": { "v": 1, "tabs": [] }, "recent": ["a.md"] });
        set(&file, &v, false).unwrap();
        assert_eq!(get(&file, false), v);
        assert!(file.starts_with(t.0.join("local").join("vaults")));
        assert_eq!(file.file_stem().unwrap().to_string_lossy(), crate::drafts::vault_key(&root));
    }

    #[test]
    fn the_host_keys_are_the_host_s() {
        let t = Tmp::new("app");
        host_set(&t.0, "window", json!({ "x": 1 })).unwrap();
        host_set(&t.0, "theme", json!("light")).unwrap();
        let file = app_file(&t.0);
        // The page never sees them, and cannot overwrite them.
        set(&file, &json!({ "zoom": 110, "window": { "x": 999 }, "theme": "dark" }), true).unwrap();
        assert_eq!(get(&file, true), json!({ "zoom": 110 }));
        assert_eq!(host_get(&t.0, "window"), Some(json!({ "x": 1 })));
        assert_eq!(host_get(&t.0, "theme"), Some(json!("light")));
        // And the host's patch keeps what the page wrote.
        host_set(&t.0, "theme", json!("dark")).unwrap();
        assert_eq!(get(&file, true), json!({ "zoom": 110 }));
    }

    #[test]
    fn the_size_cap_and_the_shape_are_enforced() {
        let t = Tmp::new("cap");
        let file = app_file(&t.0);
        let big = json!({ "blob": "x".repeat(MAX_BYTES) });
        assert!(set(&file, &big, true).unwrap_err().starts_with("[bad_arg]"));
        assert!(set(&file, &json!([1, 2]), true).unwrap_err().starts_with("[bad_arg]"));
        assert!(!file.exists(), "a refused write writes nothing");
        set(&file, &json!({ "blob": "x".repeat(1000) }), true).unwrap();
    }
}
