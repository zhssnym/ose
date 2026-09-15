//! The proof that the update swap works on Windows: an executable can be renamed while it
//! runs, and the new one renamed into its place. A copy of this very binary is started with
//! `--hold` (a debug-only flag: sleep, no window), the swap is run on that folder, and the
//! leftovers are cleaned the way `setup` does on the next start.
//!
//! **Windows only, and debug only.** `--hold` is `#[cfg(debug_assertions)]` in `src/main.rs`,
//! because a flag whose whole job is to keep a windowless copy of the app alive has no place
//! in a shipped binary. Under `cargo test --release` the copy would therefore ignore the flag
//! and start as a normal app: the asserts would fail, and the copy would stay running — with
//! no window, holding the single-instance lock, so the next real launch hands itself over to a
//! ghost. So in release this file compiles to nothing on purpose, and `cargo test --release`
//! reports `running 0 tests` here. Run the swap proof with `cargo test --test swap`.
#![cfg(all(windows, debug_assertions))]

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;

use ose::update::{finish_previous, layout_for, swap_windows};

/// Appended to the "new" copy so the two builds are distinguishable on disk. Trailing bytes
/// do not change what the loader maps, and the new copy is never started here anyway.
const MARK: &[u8] = b"\n--ose-swap-test-new-build--\n";

/// A spawned copy that is killed and reaped however this test ends. Nothing else in the tree
/// starts a host, and nothing may leave one behind: a panic between the spawn and the kill
/// below unwinds past both, and `Child`'s own `Drop` does not touch the process — the copy
/// would sit out its twenty seconds holding the single-instance lock, invisible.
struct Held(Child);

impl Drop for Held {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The app is `ose.exe` from 0.4.0 on, but a copy already on disk keeps whatever name it has:
/// a swap renames the file it found and never the app. Both names are proved, in the same way.
#[test]
fn swap_while_running_as_ose_exe() {
    swap_while_running("ose.exe");
}

#[test]
fn swap_while_running_under_the_old_name() {
    swap_while_running("os.exe");
}

fn swap_while_running(name: &str) {
    let src = PathBuf::from(env!("CARGO_BIN_EXE_ose"));
    let dir = std::env::temp_dir().join(format!("ose-swap-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let exe = dir.join(name);
    let new = dir.join(format!("{name}.new"));
    let old = dir.join(format!("{name}.old"));

    fs::copy(&src, &exe).unwrap();
    // A MinGW build loads WebView2Loader.dll from beside the exe at start; the MSVC build
    // links it in. Carry it when it is there so the copy starts either way.
    let dll = src.with_file_name("WebView2Loader.dll");
    if dll.is_file() {
        fs::copy(&dll, dir.join("WebView2Loader.dll")).unwrap();
    }
    let mut bytes = fs::read(&src).unwrap();
    bytes.extend_from_slice(MARK);
    fs::write(&new, &bytes).unwrap();

    let mut child = Held(
        Command::new(&exe)
            .arg("--hold")
            .arg("20")
            .spawn()
            .expect("start the copy"),
    );
    std::thread::sleep(Duration::from_millis(600));
    assert!(
        child.0.try_wait().unwrap().is_none(),
        "{name} --hold exited at once: `--hold` is compiled in only with debug_assertions"
    );

    let lay = layout_for(&exe).unwrap();
    assert_eq!(lay.incoming, new);
    assert_eq!(lay.old, old);

    // The swap, with the copy still running from the name it was given.
    let installed = swap_windows(&lay, &[], false).expect("swap");
    assert_eq!(installed, exe);
    assert!(old.is_file(), "the running build was not renamed to .old");
    assert!(!new.exists(), ".new is still there");
    assert!(fs::read(&exe).unwrap().ends_with(MARK), "{name} is not the new bytes");
    assert!(!fs::read(&old).unwrap().ends_with(MARK), "{name}.old is not the old bytes");
    assert!(child.0.try_wait().unwrap().is_none(), "the running copy died during the swap");

    // Still running from `.old`, so it cannot be removed yet; that is the case the retry in
    // finish_previous exists for, and here the process simply goes away first.
    drop(child);
    let removed = finish_previous(&dir, name);
    assert!(removed.iter().any(|p| p == &old), "finish_previous did not remove .old: {removed:?}");
    assert!(!old.exists());
    assert!(exe.is_file());

    fs::remove_dir_all(&dir).unwrap();
}
