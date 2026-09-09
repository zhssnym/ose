//! The proof that the update swap works on Windows: an executable can be renamed while it
//! runs, and the new one renamed into its place. A copy of this very binary is started with
//! `--hold` (a debug-only flag: sleep, no window), the swap is run on that folder, and the
//! leftovers are cleaned the way `setup` does on the next start.
#![cfg(windows)]

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use ose::update::{finish_previous, layout_for, swap_windows};

/// Appended to the "new" copy so the two builds are distinguishable on disk. Trailing bytes
/// do not change what the loader maps, and the new copy is never started here anyway.
const MARK: &[u8] = b"\n--ose-swap-test-new-build--\n";

#[test]
fn swap_while_running() {
    let src = PathBuf::from(env!("CARGO_BIN_EXE_os"));
    let dir = std::env::temp_dir().join(format!("ose-swap-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("os.exe");
    let new = dir.join("os.exe.new");
    let old = dir.join("os.exe.old");

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

    let mut child = Command::new(&exe)
        .arg("--hold")
        .arg("20")
        .spawn()
        .expect("start the copy");
    std::thread::sleep(Duration::from_millis(600));
    assert!(
        child.try_wait().unwrap().is_none(),
        "os.exe --hold exited at once: this test needs a debug build (the flag is debug-only)"
    );

    let lay = layout_for(&exe).unwrap();
    assert_eq!(lay.incoming, new);
    assert_eq!(lay.old, old);

    // The swap, with the copy still running from `os.exe`.
    let installed = swap_windows(&lay, &[], false).expect("swap");
    assert_eq!(installed, exe);
    assert!(old.is_file(), "the running build was not renamed to .old");
    assert!(!new.exists(), ".new is still there");
    assert!(fs::read(&exe).unwrap().ends_with(MARK), "os.exe is not the new bytes");
    assert!(!fs::read(&old).unwrap().ends_with(MARK), "os.exe.old is not the old bytes");
    assert!(child.try_wait().unwrap().is_none(), "the running copy died during the swap");

    // Still running from `.old`, so it cannot be removed yet; that is the case the retry in
    // finish_previous exists for, and here the process simply goes away first.
    child.kill().unwrap();
    child.wait().unwrap();
    let removed = finish_previous(&dir, "os.exe");
    assert!(removed.iter().any(|p| p == &old), "finish_previous did not remove .old: {removed:?}");
    assert!(!old.exists());
    assert!(exe.is_file());

    fs::remove_dir_all(&dir).unwrap();
}
