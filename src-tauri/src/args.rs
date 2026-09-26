//! Command line: `ose [--root <path>] [--log <file>] [--version] [<path>…]`.
//!
//! A positional argument is a file or folder to open (docs/HOST.md "OS opens"): Windows' "Open
//! with → ose.exe" hands the file over this way, and so does a second launch. Unknown flags are
//! ignored, exactly as the .NET host did; a macOS `-psn_…` process serial number is not a path.

use std::path::{Path, PathBuf};

#[derive(Debug, Default, Clone)]
pub struct Args {
    /// Explicit vault root. Used only when it exists on disk.
    pub root: Option<String>,
    /// Append-only log file for host and UI lines.
    pub log: Option<PathBuf>,
    /// `--shell <dir>` was given. It served the shell from a folder in the wave-2 layout and is
    /// gone with it (`npm run tauri dev` is the live loop now); its value is swallowed, so an
    /// old shortcut never opens the shell folder as a vault, and main.rs says so in the log.
    pub shell_ignored: bool,
    /// Print `ose <version> (<commit>, <date>)` and exit 0.
    pub version: bool,
    /// Files and folders to open, as given (relative ones against the launch's folder).
    pub paths: Vec<String>,
}

pub fn parse<I: IntoIterator<Item = String>>(argv: I) -> Args {
    let mut out = Args::default();
    let mut it = argv.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--root" => out.root = it.next(),
            "--log" => out.log = it.next().map(PathBuf::from),
            "--shell" => {
                it.next();
                out.shell_ignored = true;
            }
            "--version" => out.version = true,
            // A flag this build does not know is ignored. A path that is not there is dropped
            // when it is routed (windows.rs `open_path`), so a stray value costs a log line.
            a if a.starts_with('-') => {}
            a if a.trim().is_empty() => {}
            a => out.paths.push(a.to_string()),
        }
    }
    out
}

/// A positional path made absolute against `cwd` (a second launch's folder) and normalised.
pub fn absolute(p: &str, cwd: Option<&Path>) -> PathBuf {
    let path = PathBuf::from(p);
    let full = match (path.is_absolute(), cwd) {
        (false, Some(dir)) => dir.join(path),
        _ => path,
    };
    crate::vault::normalize(&full)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Args {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn reads_every_flag() {
        let a = v(&["--root", "D:/os", "--log", "out.log"]);
        assert_eq!(a.root.as_deref(), Some("D:/os"));
        assert_eq!(a.log, Some(PathBuf::from("out.log")));
        assert!(!a.version);
        assert!(a.paths.is_empty());
        assert!(v(&["--version"]).version);
    }

    #[test]
    fn a_flag_with_nothing_after_it_is_not_a_value() {
        assert_eq!(v(&["--log"]).log, None);
        assert_eq!(v(&["--root"]).root, None);
    }

    #[test]
    fn the_retired_shell_flag_swallows_its_folder() {
        // An old shortcut with `--shell D:\ose\shell` must not open the shell folder as a vault.
        let a = v(&["--shell", "D:/ose/shell", "D:/notes/a.md"]);
        assert!(a.shell_ignored);
        assert_eq!(a.paths, vec!["D:/notes/a.md".to_string()]);
    }

    #[test]
    fn positional_paths_are_opens() {
        let a = v(&["D:/notes/a.md", "--root", "D:/os", "b.txt"]);
        assert_eq!(a.paths, vec!["D:/notes/a.md".to_string(), "b.txt".to_string()]);
        assert_eq!(a.root.as_deref(), Some("D:/os"));
        // macOS hands a process serial number to an app Finder launched: not a path.
        assert!(v(&["-psn_0_12345"]).paths.is_empty());
    }

    #[test]
    fn ignores_unknown_flags() {
        // `--rice` was 0.5.0's flag for the interface folder in the vault. A shortcut that
        // still passes it has to start the app, not stop it.
        let a = v(&["--dev", "--rice"]);
        assert!(a.root.is_none() && !a.shell_ignored && !a.version && a.paths.is_empty());
    }

    #[test]
    fn a_relative_path_is_taken_against_the_launch_folder() {
        let (cwd, want) = if cfg!(windows) { (r"D:\work", r"D:\work\notes\a.md") } else { ("/work", "/work/notes/a.md") };
        assert_eq!(absolute("notes/a.md", Some(Path::new(cwd))), PathBuf::from(want));
    }
}
