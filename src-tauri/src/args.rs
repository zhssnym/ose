//! Command line: `os [--root <path>] [--log <file>] [--selftest] [--version] [--update] [--hold <secs>]`.
//! Unknown arguments are ignored, exactly as the .NET host did.

use std::path::PathBuf;

#[derive(Debug, Default, Clone)]
pub struct Args {
    /// Explicit vault root. Used only when it exists on disk.
    pub root: Option<String>,
    /// Append-only log file for host and UI lines.
    pub log: Option<PathBuf>,
    /// Load `selftest.html` instead of `index.html`.
    pub selftest: bool,
    /// Print `os <version> (<commit>, <date>)` and exit 0.
    pub version: bool,
    /// No window: check for a newer build, download and swap it in, relaunch, exit. The
    /// relaunched build runs the same argv, finds itself up to date and exits 0 — so a script
    /// (or a terminal on a Mac) can update in place without the UI.
    pub update: bool,
    /// Debug builds only: sleep this many seconds with no window, then exit 0. A test uses it
    /// to hold a copy of the executable running while the update swap is exercised on it.
    pub hold: Option<u64>,
}

pub fn parse<I: IntoIterator<Item = String>>(argv: I) -> Args {
    let mut out = Args::default();
    let mut it = argv.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--root" => out.root = it.next(),
            "--log" => out.log = it.next().map(PathBuf::from),
            "--selftest" => out.selftest = true,
            "--version" => out.version = true,
            "--update" => out.update = true,
            "--hold" => out.hold = it.next().and_then(|s| s.parse().ok()),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Args {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn reads_every_flag() {
        let a = v(&["--root", "D:/os", "--log", "out.log", "--selftest"]);
        assert_eq!(a.root.as_deref(), Some("D:/os"));
        assert_eq!(a.log, Some(PathBuf::from("out.log")));
        assert!(a.selftest);
    }

    #[test]
    fn version_and_hold() {
        let a = v(&["--version"]);
        assert!(a.version && a.hold.is_none());
        assert_eq!(v(&["--hold", "20"]).hold, Some(20));
        assert_eq!(v(&["--hold", "soon"]).hold, None);
        assert!(v(&["--update"]).update);
    }

    #[test]
    fn ignores_the_rest() {
        let a = v(&["--dev", "http://127.0.0.1:5173"]);
        assert!(a.root.is_none() && !a.selftest);
    }
}
