//! How much memory this computer has (item 102h; docs/several-agents.md, rule R7). Helper lanes and Ask several's lanes run at
//! most 2 at once on a Mac with 8 GB or less, 3 up to 16 GB and 4 above (`agentsAtOnce` in `src/jobs/rules.ts`), because each is a
//! whole agent CLI plus what it runs. The page asks once for the number and decides there; the shell only reads it.
//!
//! The read runs no program: on macOS it is the kernel's `hw.memsize` through `sysctlbyname`, as `fg.rs` reads the kernel's
//! process table with `sysctl`, and on Linux the kernel's own count through `sysinfo`. It is read once a run of the app and kept,
//! since a computer's memory does not change while the app runs. Anything that could not be read is `None`, which the page counts
//! as the smallest Mac the app runs on, so a failed read never lets more agents run than an 8 GB Mac can hold.

use std::sync::OnceLock;

/// This computer's memory in bytes, read once and kept; `None` when it could not be read.
pub fn memory_bytes() -> Option<u64> {
    static READ: OnceLock<Option<u64>> = OnceLock::new();
    *READ.get_or_init(read)
}

/// `hw.memsize`: the bytes of memory installed, a 64-bit number on every Mac.
#[cfg(target_os = "macos")]
fn read() -> Option<u64> {
    let mut bytes: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: the name is a NUL-terminated string, the buffer is a u64 that lives for the call and `size` holds its length, so
    // the kernel writes at most that many bytes into it; no new value is given (null, 0).
    let ok = unsafe { libc::sysctlbyname(c"hw.memsize".as_ptr(), (&mut bytes as *mut u64).cast(), &mut size, std::ptr::null_mut(), 0) };
    (ok == 0 && size == std::mem::size_of::<u64>() && bytes > 0).then_some(bytes)
}

/// The kernel's total of usable memory, in units of `mem_unit` bytes.
#[cfg(target_os = "linux")]
fn read() -> Option<u64> {
    // SAFETY: `sysinfo` only fills the struct it is given, which is plain data and may start zeroed.
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    if unsafe { libc::sysinfo(&mut info) } != 0 {
        return None;
    }
    let total = u64::from(info.totalram).checked_mul(u64::from(info.mem_unit))?;
    (total > 0).then_some(total)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn reads_this_computers_memory_once_and_keeps_it() {
        let first = memory_bytes().expect("the memory is read without a program");
        // every computer this app or its tests run on has at least a gigabyte
        assert!(first >= 1 << 30, "{first} bytes");
        assert_eq!(memory_bytes(), Some(first));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn is_what_sysctl_says_on_a_mac() {
        // the test alone runs the program, to check the read against the kernel's own answer
        let out = std::process::Command::new("/usr/sbin/sysctl").args(["-n", "hw.memsize"]).output().expect("sysctl runs");
        let said: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().expect("a number");
        assert_eq!(memory_bytes(), Some(said));
    }
}
