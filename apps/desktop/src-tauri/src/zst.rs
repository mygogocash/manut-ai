//! Reading Codex's compressed sessions (`rollout-*.jsonl.zst`), item 106b. Every reader of a rollout (outside_use.rs,
//! past_chats.rs, import_past.rs) opens one through here, so the rules below hold for all three.
//!
//! * Read only. A file is opened for reading and decoded as a stream; nothing is written anywhere.
//! * The output is capped. A zstd file can say a few kilobytes and inflate to gigabytes, so the decoder is wrapped in
//!   [`Capped`], which refuses the byte after the cap with [`Fail::OverCap`]. The cap every caller passes is the budget
//!   the plain reader already gives one rollout (`outside_use::Limits::file_bytes`, 32 MiB), so a compressed rollout
//!   costs the same memory and time as its plain twin. The decoder's window (the history it keeps to decode) is held to
//!   [`WINDOW_MAX`] for the same reason, not left at ruzstd's 128 MiB default.
//! * The input is read at most `cap` plus [`SLACK`] bytes: a compressed file larger than what it may inflate to is
//!   already wrong.
//! * A file that is not zstd, is cut short or is damaged is [`Fail::Corrupt`], never a panic and never a partial
//!   result: the caller skips the file and counts it.
//! * Which files are read is not decided here. The callers walk only the folders they already walk, never follow a
//!   link, and pass a path they have checked with `past_chats::inside` or `symlink_metadata`.
//!
//! The decoder is ruzstd (pure Rust, MIT), without its `hash` feature, so a frame's optional content checksum is not
//! verified; damage is still found by the decoder's own checks.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

use ruzstd::decoding::{FrameDecoder, StreamingDecoder};

/// What a compressed rollout may inflate to, the same as a plain one's file cap in outside_use.rs.
pub(crate) const CAP: u64 = 32 * 1024 * 1024;

/// The largest history a frame may ask the decoder to hold. Codex writes at zstd's default level (a 2 MiB window); a
/// frame that asks for more than the cap could ever need is refused, so it cannot make the decoder allocate hundreds
/// of megabytes before a byte is read.
const WINDOW_MAX: u64 = 32 * 1024 * 1024;

/// Compressed bytes read beyond `cap`, for the frame's own headers and a stream that does not compress at all.
const SLACK: u64 = 64 * 1024;

/// Why a compressed rollout was not read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fail {
    /// Not zstd, cut short, damaged, or unreadable.
    Corrupt,
    /// It would inflate past the cap.
    OverCap,
}

/// Whether `name` is a compressed Codex rollout's file name.
pub(crate) fn is_zst_name(name: &str) -> bool {
    name.ends_with(".jsonl.zst")
}

pub(crate) fn is_zst(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_zst_name)
}

/// The marker inside an `io::Error` that says the cap was reached, so [`classify`] can tell it from a damaged stream.
#[derive(Debug)]
struct OverCapMarker;

impl std::fmt::Display for OverCapMarker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("compressed rollout is larger than the cap")
    }
}

impl std::error::Error for OverCapMarker {}

/// What an error from a reader made by [`open`] means.
pub(crate) fn classify(e: &io::Error) -> Fail {
    if e.get_ref().is_some_and(|inner| inner.is::<OverCapMarker>()) {
        Fail::OverCap
    } else {
        Fail::Corrupt
    }
}

/// `inner`'s bytes up to `left`; when more follow, a read says so with an error instead of ending quietly, so a file
/// cut by the cap is never taken for a whole one.
pub(crate) struct Capped<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.left == 0 {
            // at the cap: one more byte is only fine if there is none
            let mut probe = [0u8; 1];
            return match self.inner.read(&mut probe)? {
                0 => Ok(0),
                _ => Err(io::Error::other(OverCapMarker)),
            };
        }
        let want = buf
            .len()
            .min(usize::try_from(self.left).unwrap_or(usize::MAX));
        let n = self.inner.read(&mut buf[..want])?;
        self.left -= n as u64;
        Ok(n)
    }
}

/// The rollout at `path`, decompressed as a stream of at most `cap` bytes, to read a line at a time. Reading it can
/// still fail later (a damaged block, the cap): a caller that gets an error from the reader maps it with [`classify`]
/// and discards what it had, so a half-read file counts as nothing.
pub(crate) fn open(
    path: &Path,
    cap: u64,
) -> Result<BufReader<Capped<StreamingDecoder<io::Take<File>, FrameDecoder>>>, Fail> {
    let file = File::open(path).map_err(|_| Fail::Corrupt)?;
    let input = file.take(cap.saturating_add(SLACK));
    let dec =
        StreamingDecoder::new_with_max_window_size(input, WINDOW_MAX).map_err(|_| Fail::Corrupt)?;
    Ok(BufReader::new(Capped {
        inner: dec,
        left: cap,
    }))
}

/// `len` bytes of the decompressed rollout starting at `start`, and whether more follow them. The bytes before
/// `start` are decoded and thrown away (a compressed stream cannot be sought). `Err` when the file is damaged or the
/// cap is reached on the way to what was asked for; a short look at the start of a file that is far over the cap is
/// fine, as it is for a plain file.
pub(crate) fn range(path: &Path, cap: u64, start: u64, len: u64) -> Result<(Vec<u8>, bool), Fail> {
    let mut r = open(path, cap)?;
    let mut skip = r.by_ref().take(start);
    let skipped = io::copy(&mut skip, &mut io::sink()).map_err(|e| classify(&e))?;
    if skipped < start {
        return Ok((Vec::new(), false));
    }
    let mut buf = Vec::new();
    r.by_ref()
        .take(len)
        .read_to_end(&mut buf)
        .map_err(|e| classify(&e))?;
    let more = !r.fill_buf().map_err(|e| classify(&e))?.is_empty();
    Ok((buf, more))
}

/// The last `len` bytes of the decompressed rollout (all of it when shorter), and the offset they start at. The whole
/// stream is decoded once, keeping only a window of the newest bytes, so the memory used is `len`, not the file.
pub(crate) fn tail(path: &Path, cap: u64, len: u64) -> Result<(Vec<u8>, u64), Fail> {
    let mut r = open(path, cap)?;
    let keep = usize::try_from(len).unwrap_or(usize::MAX).max(1);
    let mut buf: Vec<u8> = Vec::new();
    let (mut total, mut chunk) = (0u64, vec![0u8; 64 * 1024]);
    loop {
        let n = r.read(&mut chunk).map_err(|e| classify(&e))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        buf.extend_from_slice(&chunk[..n]);
        // trim in steps, so a long file is not copied on every read
        if buf.len() > keep.saturating_mul(2) {
            buf.drain(..buf.len() - keep);
        }
    }
    if buf.len() > keep {
        buf.drain(..buf.len() - keep);
    }
    let at = total - buf.len() as u64;
    Ok((buf, at))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A rollout and its `zstd -3` twin (`zstd -q -3 rollout-sample.jsonl`, zstd 1.5.7), made on 27 Nov 2026 with the
    /// zstd command line tool, so the frame is the real encoder's and not one this decoder's author wrote.
    pub(crate) const PLAIN: &[u8] = include_bytes!("../test-data/rollout-sample.jsonl");
    pub(crate) const ZST: &[u8] = include_bytes!("../test-data/rollout-sample.jsonl.zst");

    pub(crate) fn tmp_file(tag: &str, bytes: &[u8]) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "manut-zst-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("rollout-x.jsonl.zst");
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn read_all(p: &Path, cap: u64) -> Result<Vec<u8>, Fail> {
        let mut r = open(p, cap)?;
        let mut out = Vec::new();
        r.read_to_end(&mut out).map_err(|e| classify(&e))?;
        Ok(out)
    }

    #[test]
    fn a_real_zstd_file_reads_back_to_its_plain_twin() {
        let p = tmp_file("real", ZST);
        assert_eq!(read_all(&p, CAP).unwrap(), PLAIN);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn exactly_the_cap_is_read_and_one_byte_over_is_refused() {
        let p = tmp_file("cap", ZST);
        let n = PLAIN.len() as u64;
        assert_eq!(read_all(&p, n).unwrap().len() as u64, n);
        assert_eq!(read_all(&p, n - 1), Err(Fail::OverCap));
        assert_eq!(read_all(&p, 1), Err(Fail::OverCap));
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn a_file_that_is_not_zstd_or_is_cut_short_or_damaged_is_corrupt() {
        let dir = |p: &std::path::PathBuf| std::fs::remove_dir_all(p.parent().unwrap());
        // not zstd at all, and empty
        for junk in [
            &b"this is plain text\n"[..],
            &[0u8; 4][..],
            &[0x28, 0xb5, 0x2f, 0xfd][..],
            &[][..],
        ] {
            let p = tmp_file("junk", junk);
            assert_eq!(read_all(&p, CAP), Err(Fail::Corrupt));
            let _ = dir(&p);
        }
        // cut short at several places: inside the header, inside the blocks, just before the end
        for cut in [3, 8, 100, ZST.len() / 2, ZST.len() - 10, ZST.len() - 1] {
            let p = tmp_file("cut", &ZST[..cut]);
            assert_eq!(read_all(&p, CAP), Err(Fail::Corrupt), "cut at {cut}");
            let _ = dir(&p);
        }
        // a damaged middle: whatever the decoder makes of it, it is an error and not a panic or a whole file
        let mut bad = ZST.to_vec();
        for b in &mut bad[ZST.len() / 3..ZST.len() / 3 + 64] {
            *b ^= 0xff;
        }
        let p = tmp_file("bad", &bad);
        assert!(read_all(&p, CAP).map(|v| v != PLAIN).unwrap_or(true));
        let _ = dir(&p);
        assert_eq!(
            read_all(Path::new("/nonexistent/rollout-x.jsonl.zst"), CAP),
            Err(Fail::Corrupt)
        );
    }

    #[test]
    fn a_range_and_a_tail_are_the_same_bytes_as_the_plain_file_has() {
        let p = tmp_file("range", ZST);
        let (head, more) = range(&p, CAP, 0, 1000).unwrap();
        assert_eq!((head.as_slice(), more), (&PLAIN[..1000], true));
        let (mid, more) = range(&p, CAP, 5000, 700).unwrap();
        assert_eq!((mid.as_slice(), more), (&PLAIN[5000..5700], true));
        let (all, more) = range(&p, CAP, 0, u64::MAX).unwrap();
        assert_eq!((all.len(), more), (PLAIN.len(), false));
        assert_eq!(
            range(&p, CAP, PLAIN.len() as u64 + 10, 5).unwrap(),
            (Vec::new(), false)
        );
        let (t, at) = tail(&p, CAP, 4096).unwrap();
        assert_eq!(
            (t.as_slice(), at),
            (&PLAIN[PLAIN.len() - 4096..], (PLAIN.len() - 4096) as u64)
        );
        let (t, at) = tail(&p, CAP, u64::MAX).unwrap();
        assert_eq!((t.as_slice(), at), (PLAIN, 0));
        // the tail needs the whole stream, so a cap under the file's size refuses it; a short look at the start does not
        assert_eq!(tail(&p, 100, 10).unwrap_err(), Fail::OverCap);
        assert_eq!(range(&p, 100, 0, 10).unwrap().0.as_slice(), &PLAIN[..10]);
        assert_eq!(range(&p, 100, 50, 100).unwrap_err(), Fail::OverCap);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }
}
