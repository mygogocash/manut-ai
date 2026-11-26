//! Settings › Report a problem (item 105): the three facts about this computer the report names and the page cannot read
//! itself: Manut AI's own version, the macOS version and the chip. Only reads; only short digits and a chip name cross to the
//! page, and nothing here names a person, a folder or a machine (no host name, no serial number, no user).

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::tasks;

/// How long either read may take: both are instant, so a slow one is not waited for.
const LIMIT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SystemFacts {
    /// Manut AI's version, from the build.
    pub app: String,
    /// `26.1` style digits, "" when it could not be read.
    pub macos: String,
    /// `Apple M2`, or the architecture (`arm64`) when the chip's name could not be read; "" when neither could.
    pub chip: String,
}

/// `s` kept only when it is made of `allowed` characters and at most `max` long, else "": what crosses to the page is a
/// version or a chip name and never free text.
fn clean(s: &str, max: usize, allowed: impl Fn(char) -> bool) -> String {
    let t = s.trim();
    if t.is_empty() || t.len() > max || !t.chars().all(allowed) {
        return String::new();
    }
    t.to_string()
}

/// `sw_vers -productVersion` output as digits and dots.
pub fn macos_of(out: &str) -> String {
    clean(out.lines().next().unwrap_or(""), 16, |c| c.is_ascii_digit() || c == '.')
}

/// `sysctl -n machdep.cpu.brand_string` output (`Apple M2 Pro`): letters, digits, spaces, `-` and `.` only.
pub fn chip_of(out: &str) -> String {
    clean(out.lines().next().unwrap_or(""), 48, |c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '.'))
}

fn read(exe: &str, argv: &[&str]) -> String {
    let path = Path::new(exe);
    if !path.exists() {
        return String::new();
    }
    let argv: Vec<String> = argv.iter().map(|a| a.to_string()).collect();
    match tasks::run_env_for(path, &argv, true, &[], &[], LIMIT) {
        Ok(r) if r.code == Some(0) => r.out,
        _ => String::new(),
    }
}

pub fn facts() -> SystemFacts {
    let chip = chip_of(&read("/usr/sbin/sysctl", &["-n", "machdep.cpu.brand_string"]));
    let chip = if chip.is_empty() { clean(std::env::consts::ARCH, 16, |c| c.is_ascii_alphanumeric() || c == '_') } else { chip };
    SystemFacts { app: env!("CARGO_PKG_VERSION").to_string(), macos: macos_of(&read("/usr/bin/sw_vers", &["-productVersion"])), chip }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_digits_and_dots_only() {
        assert_eq!(macos_of("26.1\n"), "26.1");
        assert_eq!(macos_of("15.6.1"), "15.6.1");
        assert_eq!(macos_of("ana@example.com"), "");
        assert_eq!(macos_of(""), "");
        assert_eq!(macos_of("1.2.3.4.5.6.7.8.9.10.11.12"), "");
    }

    #[test]
    fn a_chip_is_a_short_plain_name() {
        assert_eq!(chip_of("Apple M2 Pro\n"), "Apple M2 Pro");
        assert_eq!(chip_of("/Users/ana/secret"), "");
        assert_eq!(chip_of(&"A".repeat(60)), "");
    }

    #[test]
    fn the_app_version_is_the_builds() {
        let f = facts();
        assert_eq!(f.app, env!("CARGO_PKG_VERSION"));
        assert!(f.macos.chars().all(|c| c.is_ascii_digit() || c == '.'));
    }
}
