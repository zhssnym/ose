//! Command line: `ose [--root <path>] [--log <file>] [--shell <dir>] [--version]`.
//! Unknown arguments are ignored, exactly as the .NET host did.

use std::path::PathBuf;

#[derive(Debug, Default, Clone)]
pub struct Args {
    /// Explicit vault root. Used only when it exists on disk.
    pub root: Option<String>,
    /// Append-only log file for host and UI lines.
    pub log: Option<PathBuf>,
    /// Serve the shell from this folder instead of the copy inside the executable.
    /// Development: the repository's own `shell/`, edited in place and reloaded with Ctrl+R.
    /// It works with no vault at all, and it never changes where the plugins come from.
    pub shell: Option<PathBuf>,
    /// Print `ose <version> (<commit>, <date>)` and exit 0.
    pub version: bool,
}

pub fn parse<I: IntoIterator<Item = String>>(argv: I) -> Args {
    let mut out = Args::default();
    let mut it = argv.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--root" => out.root = it.next(),
            "--log" => out.log = it.next().map(PathBuf::from),
            "--shell" => out.shell = it.next().map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()),
            "--version" => out.version = true,
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
        let a = v(&["--root", "D:/os", "--log", "out.log", "--shell", "D:/ose/shell"]);
        assert_eq!(a.root.as_deref(), Some("D:/os"));
        assert_eq!(a.log, Some(PathBuf::from("out.log")));
        assert_eq!(a.shell, Some(PathBuf::from("D:/ose/shell")));
        assert!(!a.version);
        assert!(v(&["--version"]).version);
    }

    #[test]
    fn a_flag_with_nothing_after_it_is_not_a_value() {
        // `--shell` alone is not a shell folder called "".
        assert_eq!(v(&["--shell"]).shell, None);
        assert_eq!(v(&["--log"]).log, None);
    }

    #[test]
    fn ignores_the_rest() {
        // `--rice` was 0.5.0's flag for the interface folder in the vault. A shortcut that
        // still passes it has to start the app, not stop it.
        let a = v(&["--dev", "http://127.0.0.1:5173", "--rice", "D:/ose/cockpit"]);
        assert!(a.root.is_none() && a.shell.is_none() && !a.version);
    }
}
