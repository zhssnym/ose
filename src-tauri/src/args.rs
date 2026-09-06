//! Command line: `os [--root <path>] [--log <file>] [--selftest]`.
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
}

pub fn parse<I: IntoIterator<Item = String>>(argv: I) -> Args {
    let mut out = Args::default();
    let mut it = argv.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--root" => out.root = it.next(),
            "--log" => out.log = it.next().map(PathBuf::from),
            "--selftest" => out.selftest = true,
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
    fn ignores_the_rest() {
        let a = v(&["--dev", "http://127.0.0.1:5173"]);
        assert!(a.root.is_none() && !a.selftest);
    }
}
