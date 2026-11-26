//! The last good read of the connected shop, kept for when the API cannot be reached (src/runtime/http/cache.ts). The
//! page serializes what its screens read of the shop and hands the text here; it is written only under manut's own
//! folder, as one file for the one signed-in shop: `<home>/.manut/shop-cache/<key>.json`, where the key is 64 lowercase
//! hex digits (a SHA-256 the page makes of the shop's origin and tenant, so the name says neither), never a path from the
//! page. A file is readable by its owner only (0600), holds at most [`MAX_BYTES`], is written to a temporary file and
//! renamed over the old one so a crash never leaves half a file, and is never followed through a link. Writing a shop's
//! file removes any other shop's, so at most one is ever kept; [`clear`] removes it (signing out, a session the API
//! ended, switching to Practice or to another origin). Nothing else is written there and nothing else is read or
//! removed. The text is not looked at here. It comes sealed: the page copies only the fields its screens read, then seals
//! them with AES-GCM (src/runtime/http/seal.ts) under a key only the keychain holds (shop_cache_key.rs), so what reaches
//! the disk cannot be read without that key, and the page alone opens it and decides what it means and whether it is too
//! old to show.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Bytes kept of one shop. What the page keeps is the decoded tasks, the actions waiting for the owner, schedules and
/// attention items, never the API's whole objects, so 8 MiB of that is far above any shop's read; a read over it is not
/// kept. The file holds the read sealed, written as base64, which is a third longer, with the seal's nonce and tag and
/// a line of JSON around it: 11 MiB holds 8 MiB of read with room to spare.
pub const MAX_BYTES: usize = 11 * 1024 * 1024;

/// Every call takes this lock, so a clear cannot run between a write's temporary file and its rename and leave the file
/// behind, and two writes never share the temporary file.
static LOCK: Mutex<()> = Mutex::new(());

/// `<home>/.manut/shop-cache`.
pub fn root(home: &Path) -> PathBuf {
    home.join(".manut").join("shop-cache")
}

/// A key as the page makes it: the 64 lowercase hex digits of a SHA-256.
pub fn valid_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn file_of(home: &Path, key: &str) -> Result<PathBuf, String> {
    if !valid_key(key) {
        return Err("bad shop key".into());
    }
    Ok(root(home).join(format!("{key}.json")))
}

fn tmp_of(home: &Path, key: &str) -> PathBuf {
    root(home).join(format!(".{key}.tmp"))
}

/// Whether `name` is a file this module makes: `<key>.json`, or the temporary file `.<key>.tmp` a crash may have left.
fn ours(name: &str) -> bool {
    if let Some(key) = name.strip_suffix(".json") {
        return valid_key(key);
    }
    name.strip_prefix('.').and_then(|n| n.strip_suffix(".tmp")).is_some_and(valid_key)
}

/// Refuse a link anywhere on the way (`.manut`, the folder, the file).
fn no_links(home: &Path, file: &Path) -> Result<(), String> {
    for p in [home.join(".manut"), root(home), file.to_path_buf()] {
        if p.is_symlink() {
            return Err(format!("{} is a link", p.display()));
        }
    }
    Ok(())
}

/// Keep `text` as shop `key`'s read, replacing what was kept, owner-only, and remove every other shop's file.
pub fn write(home: &Path, key: &str, text: &str) -> Result<(), String> {
    let file = file_of(home, key)?;
    if text.len() > MAX_BYTES {
        return Err("over the cap".into());
    }
    let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    no_links(home, &file)?;
    fs::create_dir_all(root(home)).map_err(|e| e.to_string())?;
    no_links(home, &file)?;
    let tmp = tmp_of(home, key);
    if tmp.is_symlink() {
        return Err(format!("{} is a link", tmp.display()));
    }
    let _ = fs::remove_file(&tmp);
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut f = o.open(&tmp).map_err(|e| e.to_string())?;
    let written = f.write_all(text.as_bytes()).and_then(|_| f.sync_all());
    drop(f);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    fs::rename(&tmp, &file).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    // one shop at a time: another's read, or a temporary file a crash left, goes
    if let Ok(entries) = fs::read_dir(root(home)) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if ours(&name) && name != format!("{key}.json") {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

/// Shop `key`'s kept read, or `None` when there is none (or it is over the cap, which this module never writes). A file
/// that is not text reads as far as it is.
pub fn read(home: &Path, key: &str) -> Result<Option<String>, String> {
    let file = file_of(home, key)?;
    let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    no_links(home, &file)?;
    let Ok(meta) = fs::symlink_metadata(&file) else { return Ok(None) };
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return Ok(None);
    }
    let mut buf = Vec::new();
    fs::File::open(&file).and_then(|f| f.take(MAX_BYTES as u64).read_to_end(&mut buf)).map_err(|e| e.to_string())?;
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

/// Remove every kept read (signing out, switching to Practice or to another origin). Only files this module makes are
/// touched, and a link in the way is not followed.
pub fn clear(home: &Path) -> Result<(), String> {
    let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let root = root(home);
    if home.join(".manut").is_symlink() || root.is_symlink() || !root.is_dir() {
        return Ok(());
    }
    for e in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if ours(&name) {
            match fs::remove_file(e.path()) {
                Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.to_string()),
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A key as the page makes it: a SHA-256 in hex.
    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn home(tag: &str) -> PathBuf {
        let h = std::env::temp_dir().join(format!("manut-shop-cache-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&h);
        fs::create_dir_all(&h).unwrap();
        h.canonicalize().unwrap()
    }

    fn names(h: &Path) -> Vec<String> {
        let mut out: Vec<String> = match fs::read_dir(root(h)) {
            Ok(rd) => rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
            Err(_) => vec![],
        };
        out.sort();
        out
    }

    #[test]
    fn a_key_is_sixty_four_lowercase_hex_digits_and_nothing_else() {
        assert!(valid_key(A) && valid_key(B));
        let sixty_three = &A[..63];
        let sixty_five = format!("{A}a");
        for bad in [
            "",
            "a",
            sixty_three,
            sixty_five.as_str(),
            "../aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
            "аaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(!valid_key(bad), "{bad}");
        }
    }

    #[test]
    fn saves_owner_only_inside_its_folder_and_reads_back() {
        let h = home("save");
        write(&h, A, r#"{"v":1}"#).unwrap();
        let f = h.join(format!(".manut/shop-cache/{A}.json"));
        assert_eq!(fs::read_to_string(&f).unwrap(), r#"{"v":1}"#);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(read(&h, A).unwrap().as_deref(), Some(r#"{"v":1}"#));
        assert_eq!(read(&h, B).unwrap(), None);
        // only <key>.json sits in the folder: no temporary file is left behind
        assert_eq!(names(&h), [format!("{A}.json")]);
        for bad in ["../s1", "s1/../../x", "/etc/passwd", "", "AAAA"] {
            assert!(write(&h, bad, "x").is_err(), "{bad}");
            assert!(read(&h, bad).is_err(), "{bad}");
        }
        assert!(!h.join("x.json").exists() && !h.join(".manut/x.json").exists());
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn keeps_the_one_shop_it_was_given_last() {
        let h = home("one");
        write(&h, A, "first shop").unwrap();
        write(&h, B, "second shop").unwrap();
        assert_eq!(names(&h), [format!("{B}.json")]);
        assert_eq!(read(&h, A).unwrap(), None);
        write(&h, B, "second shop again").unwrap();
        assert_eq!(read(&h, B).unwrap().as_deref(), Some("second shop again"));
        assert_eq!(names(&h), [format!("{B}.json")]);
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn leaves_what_is_not_a_kept_read_alone_and_sweeps_a_temporary_file_a_crash_left() {
        let h = home("sweep");
        write(&h, A, "x").unwrap();
        fs::write(root(&h).join("notes.md"), "keep").unwrap();
        fs::write(root(&h).join("x.json"), "keep").unwrap();
        fs::write(root(&h).join(format!(".{B}.tmp")), "half a file").unwrap();
        write(&h, A, "y").unwrap();
        assert_eq!(names(&h), [format!("{A}.json"), "notes.md".to_string(), "x.json".to_string()]);
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn refuses_text_over_the_cap_and_leaves_what_was_kept() {
        let h = home("cap");
        write(&h, A, "small").unwrap();
        let big = "x".repeat(MAX_BYTES + 1);
        assert!(write(&h, A, &big).is_err());
        assert_eq!(read(&h, A).unwrap().as_deref(), Some("small"));
        assert_eq!(names(&h), [format!("{A}.json")]);
        // the cap itself is allowed
        write(&h, A, &"y".repeat(MAX_BYTES)).unwrap();
        assert_eq!(read(&h, A).unwrap().map(|t| t.len()), Some(MAX_BYTES));
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn holds_a_read_of_eight_mib_once_the_page_has_sealed_it() {
        // What the page writes for a read of `n` bytes (src/runtime/http/seal.ts): GCM's 16-byte tag after it, all of it as
        // base64url without padding, in a line of JSON with the version and the nonce's 16 characters.
        let sealed = |n: usize| (4 * (n + 16)).div_ceil(3) + r#"{"v":6,"iv":"","sealed":""}"#.len() + 16;
        assert!(sealed(8 * 1024 * 1024) <= MAX_BYTES, "{} > {MAX_BYTES}", sealed(8 * 1024 * 1024));
        // and the cap is not far above it: a file is read whole into memory
        assert!(MAX_BYTES - sealed(8 * 1024 * 1024) < 1024 * 1024, "{MAX_BYTES}");
    }

    #[test]
    fn reads_a_file_that_is_not_text_as_far_as_it_goes_and_a_file_over_the_cap_as_nothing() {
        let h = home("odd");
        write(&h, A, "x").unwrap();
        fs::write(root(&h).join(format!("{A}.json")), [b'{', 0xff, 0xfe, b'}']).unwrap();
        let got = read(&h, A).unwrap().unwrap();
        assert!(got.starts_with('{') && got.ends_with('}'));
        fs::write(root(&h).join(format!("{A}.json")), vec![b'x'; MAX_BYTES + 1]).unwrap();
        assert_eq!(read(&h, A).unwrap(), None);
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn clear_removes_only_kept_reads_and_is_the_same_twice_and_with_nothing_kept() {
        let h = home("clear");
        clear(&h).unwrap();
        write(&h, A, "x").unwrap();
        fs::write(root(&h).join("notes.md"), "keep").unwrap();
        fs::write(root(&h).join("x.json"), "keep").unwrap();
        fs::write(root(&h).join(format!(".{B}.tmp")), "half a file").unwrap();
        clear(&h).unwrap();
        clear(&h).unwrap();
        assert_eq!(names(&h), ["notes.md".to_string(), "x.json".to_string()]);
        assert_eq!(read(&h, A).unwrap(), None);
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn calls_from_many_threads_never_collide_and_a_clear_has_the_last_word() {
        let h = home("threads");
        let writers: Vec<_> = (0..6)
            .map(|t| {
                let h = h.clone();
                std::thread::spawn(move || {
                    for i in 0..20 {
                        let key = if (t + i) % 2 == 0 { A } else { B };
                        write(&h, key, &format!("thread {t} write {i}")).unwrap();
                        if i % 7 == 0 {
                            clear(&h).unwrap();
                        }
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        // whatever the order, at most one shop's file is there, and nothing half-written
        assert!(names(&h).len() <= 1, "{:?}", names(&h));
        clear(&h).unwrap();
        assert!(names(&h).is_empty());
        let _ = fs::remove_dir_all(&h);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links() {
        let h = home("links");
        let away = h.join("away");
        fs::create_dir_all(&away).unwrap();
        fs::create_dir_all(h.join(".manut")).unwrap();
        std::os::unix::fs::symlink(&away, root(&h)).unwrap();
        assert!(write(&h, A, "x").is_err());
        assert!(read(&h, A).is_err());
        assert!(!away.join(format!("{A}.json")).exists());
        // a link in the way is not followed to remove anything either
        fs::write(away.join(format!("{A}.json")), "elsewhere").unwrap();
        clear(&h).unwrap();
        assert_eq!(fs::read_to_string(away.join(format!("{A}.json"))).unwrap(), "elsewhere");
        fs::remove_file(root(&h)).unwrap();
        fs::create_dir_all(root(&h)).unwrap();
        let target = away.join("t.json");
        fs::write(&target, "secret").unwrap();
        std::os::unix::fs::symlink(&target, root(&h).join(format!("{A}.json"))).unwrap();
        assert!(write(&h, A, "x").is_err());
        assert!(read(&h, A).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "secret");
        // the whole `.manut` as a link
        let other = home("links-other");
        std::os::unix::fs::symlink(h.join("away"), other.join(".manut")).unwrap();
        assert!(write(&other, B, "x").is_err());
        assert!(!h.join("away").join("shop-cache").exists());
        let _ = fs::remove_dir_all(&h);
        let _ = fs::remove_dir_all(&other);
    }
}
