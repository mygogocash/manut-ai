//! The real desk on macOS: the accessibility API (HIServices), CoreGraphics and ImageIO, called from the shell, whose
//! process is the one macOS gives Accessibility and Screen capture to (the app the person turned on in System
//! Settings). Nothing here asks macOS for a permission: the two checks only read whether it was given
//! (`AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`), and the functions that would prompt
//! (`AXIsProcessTrustedWithOptions` with its prompt option, `CGRequestScreenCaptureAccess`) are never named
//! (`mod.rs`'s test holds the folder to that).
//!
//! Each declaration below is copied from the macOS 26 SDK's own headers (`HIServices/AXUIElement.h`,
//! `CoreGraphics/CGWindow.h`, `CGEvent.h`, `CGSession.h`, `CGGeometry.h`, `ImageIO/CGImageDestination.h`) and the
//! constants' values from `AXAttributeConstants.h`, `AXRoleConstants.h` and `AXActionConstants.h`, so no new crate is
//! needed; the Core Foundation types are the `core-foundation` crate's, which the app already builds.
//!
//! Lifted from Orca (`native/computer-use-macos`, MIT): the lock check (`SessionLockProbe.swift`, the session
//! dictionary's `CGSSessionScreenIsLocked`), the window's number through `_AXUIElementGetWindow` looked up at run time
//! (`AccessibilityWindowIdentity.swift`), the picture through `CGWindowListCreateImage` with the window alone and its
//! frame left out (`main.swift`, `captureImage`), and which windows count (`main.swift`, `candidate`: the normal
//! level, at least 48 points each way, not see-through).

use std::ffi::{c_void, CString};
use std::sync::Arc;

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_foundation::url::CFURL;

use super::keys::{char_codes, Chord, Keyboard, Layout};
use super::room::{clean, App, Desk, Focus, Handle, Node, Place, Win, MAX_DEPTH, MAX_NODES, SECURE};

type AXUIElementRef = *const c_void;
/// `AXError`: 0 is success (`AXError.h`).
type AXError = i32;
type CGImageRef = *const c_void;
type CGEventRef = *const c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> AXError;
    fn AXUIElementSetAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: CFTypeRef) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_in_seconds: f32) -> AXError;
    fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> u8;
}

/// `kAXValueTypeCGPoint` and `kAXValueTypeCGSize` (`AXValue.h`).
const AX_POINT: u32 = 1;
const AX_SIZE: u32 = 2;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
    fn CGWindowListCreateImage(screen_bounds: CGRect, list_option: u32, window_id: u32, image_option: u32) -> CGImageRef;
    fn CGRectMakeWithDictionaryRepresentation(dict: CFDictionaryRef, rect: *mut CGRect) -> bool;
    fn CGEventCreateKeyboardEvent(source: *const c_void, virtual_key: u16, key_down: bool) -> CGEventRef;
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventPostToPid(pid: i32, event: CGEventRef);
    static CGRectNull: CGRect;
    static kCGWindowLayer: CFStringRef;
    static kCGWindowOwnerPID: CFStringRef;
    static kCGWindowOwnerName: CFStringRef;
    static kCGWindowBounds: CFStringRef;
    static kCGWindowAlpha: CFStringRef;
}

// The keyboard layout (`HIToolbox/TextInputSources.h`, `HIToolbox/Events.h`, `CarbonCore/UnicodeUtilities.h`). The
// header says: "TextInputSources API is not thread safe. If you are a UI application, you must call TextInputSources API
// on the main thread", so [`keyboard`] reads it there.
#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn TISCopyCurrentKeyboardLayoutInputSource() -> CFTypeRef;
    fn TISCreateInputSourceList(properties: CFDictionaryRef, include_all_installed: u8) -> CFArrayRef;
    fn TISGetInputSourceProperty(source: CFTypeRef, key: CFStringRef) -> CFTypeRef;
    fn LMGetKbdType() -> u8;
    static kTISPropertyUnicodeKeyLayoutData: CFStringRef;
    static kTISPropertyLocalizedName: CFStringRef;
    static kTISPropertyInputSourceType: CFStringRef;
    static kTISTypeKeyboardLayout: CFStringRef;
}

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    #[allow(clippy::too_many_arguments)]
    fn UCKeyTranslate(
        layout: *const c_void,
        virtual_key_code: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        key_translate_options: u32,
        dead_key_state: *mut u32,
        max_string_length: usize,
        actual_string_length: *mut usize,
        unicode_string: *mut u16,
    ) -> i32;
}

/// `kUCKeyActionDown` and `kUCKeyTranslateNoDeadKeysMask` (`UnicodeUtilities.h`), and the Command key's bit in
/// `UCKeyTranslate`'s modifier state: `cmdKey` (1 << `cmdKeyBit` 8, `Events.h`) shifted down 8, as the header says
/// ("modifierKeyState = ((EventRecord.modifiers) >> 8) & 0xFF").
const KEY_DOWN: u16 = 0;
const NO_DEAD_KEYS: u32 = 1;
const COMMAND_STATE: u32 = ((1 << 8) >> 8) & 0xFF;

/// libdispatch's main queue (`dispatch/queue.h`: `dispatch_get_main_queue()` is `&_dispatch_main_q`).
#[repr(C)]
struct DispatchQueue {
    _opaque: [u8; 0],
}

extern "C" {
    static _dispatch_main_q: DispatchQueue;
    fn dispatch_async_f(queue: *const DispatchQueue, context: *mut c_void, work: extern "C" fn(*mut c_void));
}

/// `work` run on the main thread, its answer waited for at most two seconds: a main thread that is busy, or not running
/// its loop (a test), gives None rather than holding the tool or deadlocking against a lock the caller holds.
fn on_main<T: Send + 'static>(work: fn() -> T) -> Option<T> {
    if unsafe { libc::pthread_main_np() } == 1 {
        return Some(work());
    }
    struct Job<T> {
        work: fn() -> T,
        tx: std::sync::mpsc::Sender<T>,
    }
    extern "C" fn run<T>(ctx: *mut c_void) {
        // SAFETY: `ctx` is the box made below, handed to this function once.
        let job = unsafe { Box::from_raw(ctx as *mut Job<T>) };
        let _ = job.tx.send((job.work)());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let ctx = Box::into_raw(Box::new(Job { work, tx })) as *mut c_void;
    // SAFETY: the main queue lives as long as the process; `run::<T>` takes back the box.
    unsafe { dispatch_async_f(&_dispatch_main_q, ctx, run::<T>) };
    rx.recv_timeout(std::time::Duration::from_secs(2)).ok()
}

/// What each key in [`char_codes`] types on input source `source`, alone and with Command held, read from its
/// `uchr` data; None for a source that is not a keyboard layout with one.
fn layout_of(source: CFTypeRef) -> Option<Layout> {
    // SAFETY: TISGetInputSourceProperty follows the get rule; the data and name are retained while used.
    let data = unsafe { TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) };
    if data.is_null() {
        return None;
    }
    let data: CFData = unsafe { CFData::wrap_under_get_rule(data as _) };
    let name = unsafe { TISGetInputSourceProperty(source, kTISPropertyLocalizedName) };
    let name = if name.is_null() { String::new() } else { unsafe { CFString::wrap_under_get_rule(name as CFStringRef) }.to_string() };
    let uchr = data.bytes().as_ptr() as *const c_void;
    let kind = unsafe { LMGetKbdType() } as u32;
    let typed = |code: u16, state: u32| -> Option<char> {
        let (mut dead, mut n, mut out) = (0u32, 0usize, [0u16; 4]);
        let err = unsafe { UCKeyTranslate(uchr, code, KEY_DOWN, state, kind, NO_DEAD_KEYS, &mut dead, out.len(), &mut n, out.as_mut_ptr()) };
        if err != 0 || n != 1 {
            return None;
        }
        char::from_u32(u32::from(out[0])).filter(|c| !c.is_control())
    };
    Some(Layout { name, keys: char_codes().map(|c| (c, typed(c, 0), typed(c, COMMAND_STATE))).collect() })
}

/// The layout in use and the other keyboard layouts the person has turned on. Called on the main thread.
fn read_keyboard() -> Option<Keyboard> {
    let current = unsafe { TISCopyCurrentKeyboardLayoutInputSource() };
    if current.is_null() {
        return None;
    }
    let current = unsafe { CFType::wrap_under_create_rule(current) };
    let current = layout_of(current.as_CFTypeRef())?;
    let filter = CFDictionary::from_CFType_pairs(&[(unsafe { CFString::wrap_under_get_rule(kTISPropertyInputSourceType) }, unsafe { CFString::wrap_under_get_rule(kTISTypeKeyboardLayout) }.as_CFType())]);
    let list = unsafe { TISCreateInputSourceList(filter.as_concrete_TypeRef(), 0) };
    let others = if list.is_null() {
        Vec::new()
    } else {
        let list: CFArray = unsafe { CFArray::wrap_under_create_rule(list) };
        list.iter().filter(|p| !p.is_null()).filter_map(|p| layout_of(*p)).filter(|l| *l != current).collect()
    };
    Some(Keyboard { current, others })
}

#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    fn CGImageDestinationCreateWithData(data: *mut c_void, kind: CFStringRef, count: usize, options: CFDictionaryRef) -> *const c_void;
    fn CGImageDestinationAddImage(dest: *const c_void, image: CGImageRef, properties: CFDictionaryRef);
    fn CGImageDestinationFinalize(dest: *const c_void) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDataCreateMutable(allocator: *const c_void, capacity: isize) -> *mut c_void;
    fn CFRelease(cf: *const c_void);
}

/// `kCGWindowListOptionAll` (0) with `kCGWindowListExcludeDesktopElements` (1 << 4): every window, the desktop's aside.
const LIST_ALL: u32 = 1 << 4;
/// `kCGWindowListOptionIncludingWindow`: the one window named.
const LIST_ONE: u32 = 1 << 3;
/// `kCGWindowImageBoundsIgnoreFraming` with `kCGWindowImageNominalResolution`: the window without its shadow, one pixel
/// a point, which keeps a picture small enough for the agent.
const IMAGE_OPTIONS: u32 = 1 | (1 << 4);
/// The largest picture sent.
const PICTURE_BYTES: usize = 6 * 1024 * 1024;

/// An accessibility element, retained, used from whichever thread runs the tool: the accessibility API is a set of
/// messages to the other app, and a Core Foundation object's retain and release are thread-safe.
struct Ax(CFType);
// SAFETY: see above; the element is never mutated through this handle, only sent messages.
unsafe impl Send for Ax {}
unsafe impl Sync for Ax {}

impl Ax {
    /// Takes an element the API created (the create rule); None for a null one.
    fn created(ptr: AXUIElementRef) -> Option<Ax> {
        (!ptr.is_null()).then(|| Ax(unsafe { CFType::wrap_under_create_rule(ptr) }))
    }

    fn ptr(&self) -> AXUIElementRef {
        self.0.as_CFTypeRef()
    }

    fn attr(&self, name: &str) -> Option<CFType> {
        let key = CFString::new(name);
        let mut v: CFTypeRef = std::ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(self.ptr(), key.as_concrete_TypeRef(), &mut v) };
        if err != 0 || v.is_null() {
            return None;
        }
        Some(unsafe { CFType::wrap_under_create_rule(v) })
    }

    fn string(&self, name: &str) -> Option<String> {
        self.attr(name)?.downcast::<CFString>().map(|s| s.to_string())
    }

    fn boolean(&self, name: &str) -> Option<bool> {
        self.attr(name)?.downcast::<CFBoolean>().map(bool::from)
    }

    fn elements(&self, name: &str) -> Vec<Ax> {
        let Some(arr) = self.attr(name).and_then(|v| v.downcast::<CFArray>()) else { return Vec::new() };
        arr.iter().filter(|p| !p.is_null()).map(|p| Ax(unsafe { CFType::wrap_under_get_rule(*p) })).collect()
    }

    fn element(&self, name: &str) -> Option<Ax> {
        let v = self.attr(name)?;
        Some(Ax(v))
    }

    /// An `AXValue` attribute (`AXPosition`, `AXSize`) as the structure it wraps.
    fn value<T: Copy>(&self, name: &str, kind: u32, empty: T) -> Option<T> {
        let v = self.attr(name)?;
        let mut out = empty;
        let ok = unsafe { AXValueGetValue(v.as_CFTypeRef(), kind, &mut out as *mut T as *mut c_void) };
        (ok != 0).then_some(out)
    }

    /// Its position and size on screen in whole points: `AXPosition` is global, from the top-left of the screen with the
    /// menu bar, as the window list's bounds are.
    fn frame(&self) -> Option<[i64; 4]> {
        let p = self.value("AXPosition", AX_POINT, CGPoint { x: 0.0, y: 0.0 })?;
        let s = self.value("AXSize", AX_SIZE, CGSize { width: 0.0, height: 0.0 })?;
        Some([p.x.round() as i64, p.y.round() as i64, s.width.round() as i64, s.height.round() as i64])
    }

    /// An address attribute (`AXURL`, `AXDocument`) as text, whether the app gives a URL or a string.
    fn address(&self, name: &str) -> Option<String> {
        let v = self.attr(name)?;
        if let Some(u) = v.downcast::<CFURL>() {
            return Some(u.get_string().to_string());
        }
        v.downcast::<CFString>().map(|s| s.to_string())
    }

    /// The window this element is in, its title, and the addresses it shows there: the window's document and the page
    /// of every web area the element is in, read up its parents to the window.
    fn window_facts(&self) -> Option<Win> {
        let win = if self.string("AXRole")? == "AXWindow" { Ax(self.0.clone()) } else { self.element("AXWindow")? };
        let mut addresses: Vec<String> = win.address("AXDocument").into_iter().collect();
        let mut here = Ax(self.0.clone());
        for _ in 0..=MAX_DEPTH + 1 {
            if here.0 == win.0 {
                break;
            }
            if here.string("AXRole").as_deref() == Some("AXWebArea") {
                addresses.extend(here.address("AXURL"));
            }
            let Some(parent) = here.element("AXParent") else { break };
            here = parent;
        }
        Some(Win { number: window_number(&win), title: win.string("AXTitle").unwrap_or_default(), addresses })
    }

    /// What the element holds, as text, when it is text, a number or a check box's state. Never called for a
    /// password field.
    fn value_text(&self) -> Option<String> {
        let v = self.attr("AXValue")?;
        if let Some(s) = v.downcast::<CFString>() {
            return Some(s.to_string());
        }
        if let Some(b) = v.downcast::<CFBoolean>() {
            return Some(bool::from(b).to_string());
        }
        v.downcast::<CFNumber>().and_then(|n| n.to_f64()).map(|f| if f.fract() == 0.0 { format!("{}", f as i64) } else { f.to_string() })
    }

    /// The element as a node: its role first, so a password field's value is never asked for.
    fn node(self, depth: usize) -> Option<Node> {
        let role = self.string("AXRole")?;
        let subrole = self.string("AXSubrole").unwrap_or_default();
        let secure = role == SECURE || subrole == SECURE;
        let label = ["AXTitle", "AXDescription", "AXPlaceholderValue"]
            .iter()
            .filter_map(|k| self.string(k))
            .find(|t| !t.trim().is_empty())
            .unwrap_or_default();
        let value = if secure { None } else { self.value_text() };
        let enabled = self.boolean("AXEnabled").unwrap_or(true);
        // the page a web area shows, and the document a window shows: what tells one of Manut AI's own pages
        let address = match role.as_str() {
            "AXWebArea" => self.address("AXURL"),
            "AXWindow" => self.address("AXDocument"),
            _ => None,
        };
        Some(Node { depth, role, subrole, label, value, enabled, address, handle: Arc::new(self) as Handle })
    }
}

fn ax_error(err: AXError, what: &str) -> String {
    match err {
        -25211 => "macOS has not given Manut AI Accessibility.".into(),
        -25202 => format!("The control is gone, so {what} did not happen."),
        -25204 => format!("The app did not answer in time, so {what} may not have happened."),
        -25206 | -25205 => format!("That control does not take {what}."),
        _ => format!("{what} failed (accessibility error {err})."),
    }
}

/// The element a handle holds, when it is one of this desk's.
fn ax(handle: &Handle) -> Option<&Ax> {
    handle.downcast_ref::<Ax>()
}

/// The window number of a window element.
fn window_number(win: &Ax) -> Option<u32> {
    let get = get_window()?;
    let mut id: u32 = 0;
    (unsafe { get(win.ptr(), &mut id) } == 0 && id != 0).then_some(id)
}

/// The program file process `pid` runs, or empty when it cannot be read.
fn path_of(pid: i32) -> String {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf8_lossy(&buf[..n as usize]).into_owned()
}

/// Whether process `pid` runs as this user, both its real and its effective user (`proc_pidinfo`'s `pbi_ruid` and
/// `pbi_uid`); false when that cannot be read.
fn runs_as_me(pid: i32) -> bool {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut c_void, size) };
    let me = unsafe { libc::getuid() };
    n == size && info.pbi_uid == me && info.pbi_ruid == me
}

/// The bundle identifier of process `pid` as the system knows it (`NSRunningApplication`'s `bundleIdentifier`, which
/// AppKit's header says is the `CFBundleIdentifier` of the app's `Info.plist`, for any kind of bundle), else read from the
/// `Info.plist` of whatever bundle its program `path` is in, else empty. AppKit tracks only "user applications", so the
/// second read is what finds macOS's own prompts that run from a `.bundle`.
fn bundle_of(pid: i32, path: &str) -> String {
    let known = objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid).and_then(|a| a.bundleIdentifier()).map(|b| b.to_string());
    known.filter(|b| !b.trim().is_empty()).unwrap_or_else(|| bundle_in(path))
}

/// The bundle identifier of the bundle whose program is at `path` (`<name>.<kind>/Contents/MacOS/<program>`, any kind:
/// `.app`, `.bundle`, `.xpc`, `.appex`), from its `Info.plist`, or empty.
fn bundle_in(path: &str) -> String {
    let Some(at) = path.rfind("/Contents/MacOS/") else { return String::new() };
    let root = &path[..at];
    if !root.rsplit('/').next().is_some_and(|name| name.len() > 1 && name[1..].contains('.')) {
        return String::new();
    }
    let plist = format!("{root}/Contents/Info.plist");
    plist::Value::from_file(plist)
        .ok()
        .and_then(|v| v.as_dictionary().and_then(|d| d.get("CFBundleIdentifier")).and_then(|b| b.as_string()).map(str::to_string))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// macOS's own prompts are not all apps: SecurityAgent (a password prompt) and the Touch ID and password prompt
    /// (`coreautha`) are `.bundle`s, and their bundle identifiers are what the refused list names.
    #[test]
    fn a_prompt_in_any_kind_of_bundle_reads_its_bundle_identifier() {
        let d = std::env::temp_dir().join(format!("mc-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        for (bundle, exe, id) in [("SecurityAgent.bundle", "SecurityAgent", "com.apple.SecurityAgent"), ("coreautha.bundle", "coreautha", "com.apple.LocalAuthentication.UIAgent"), ("TextEdit.app", "TextEdit", "com.apple.TextEdit"), ("Helper.xpc", "Helper", "com.example.helper")] {
            let root = d.join(bundle).join("Contents");
            std::fs::create_dir_all(root.join("MacOS")).unwrap();
            std::fs::write(root.join("Info.plist"), format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{id}</string></dict></plist>")).unwrap();
            assert_eq!(bundle_in(&root.join("MacOS").join(exe).to_string_lossy()), id, "{bundle}");
        }
        // a program in no bundle has none
        assert_eq!(bundle_in("/usr/bin/python3"), "");
        let _ = std::fs::remove_dir_all(&d);
        // and on this Mac, the two prompts' own bundles, as macOS ships them (read from their Info.plist, nothing run)
        for (path, id) in [
            ("/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent", "com.apple.SecurityAgent"),
            ("/System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle/Contents/MacOS/coreautha", "com.apple.LocalAuthentication.UIAgent"),
        ] {
            if std::path::Path::new(path).exists() {
                assert_eq!(bundle_in(path), id);
            }
        }
    }

    /// The stand-in layouts are this Mac's own: each is read again here through the calls the desk uses, from the
    /// layouts macOS ships (read only: nothing is typed, posted or switched), and the layout in use reads whole. A test
    /// is not a UI application, so the header lets it call these off the main thread, one thread at a time.
    #[test]
    fn the_stand_in_layouts_are_the_ones_this_mac_reads() {
        use crate::computer::stand::{DVORAK, DVORAK_QWERTY_CMD, FRENCH, THAI, US};
        extern "C" {
            static kTISPropertyInputSourceID: CFStringRef;
        }
        let tables: [(&str, &[(u16, Option<char>, Option<char>)]); 5] = [
            ("com.apple.keylayout.US", &US),
            ("com.apple.keylayout.French", &FRENCH),
            ("com.apple.keylayout.Dvorak", &DVORAK),
            ("com.apple.keylayout.DVORAK-QWERTYCMD", &DVORAK_QWERTY_CMD),
            ("com.apple.keylayout.Thai", &THAI),
        ];
        for (id, table) in tables {
            let key = unsafe { CFString::wrap_under_get_rule(kTISPropertyInputSourceID) };
            let filter = CFDictionary::from_CFType_pairs(&[(key, CFString::new(id).as_CFType())]);
            let list = unsafe { TISCreateInputSourceList(filter.as_concrete_TypeRef(), 1) };
            assert!(!list.is_null(), "{id}");
            let list: CFArray = unsafe { CFArray::wrap_under_create_rule(list) };
            let source = *list.iter().next().unwrap_or_else(|| panic!("{id} is not installed"));
            assert_eq!(layout_of(source).unwrap().keys, table, "{id}");
        }
        let kb = read_keyboard().expect("the layout in use");
        assert_eq!(kb.current.keys.len(), char_codes().count());
        assert!(!kb.current.name.is_empty());
    }
}

/// `_AXUIElementGetWindow`, which HIServices exports without declaring: the window number of a window element, found
/// at run time as Orca does, so a macOS without it only loses pictures.
type GetWindow = unsafe extern "C" fn(AXUIElementRef, *mut u32) -> AXError;

fn get_window() -> Option<GetWindow> {
    let name = CString::new("_AXUIElementGetWindow").ok()?;
    let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    // SAFETY: HIServices exports `AXError _AXUIElementGetWindow(AXUIElementRef, CGWindowID *)` under this name.
    (!sym.is_null()).then(|| unsafe { std::mem::transmute::<*mut c_void, GetWindow>(sym) })
}

/// A PNG of `image`, through ImageIO.
fn png(image: CGImageRef) -> Result<Vec<u8>, String> {
    unsafe {
        let data = CFDataCreateMutable(std::ptr::null(), 0);
        if data.is_null() {
            return Err("no memory for the picture".into());
        }
        let data = CFData::wrap_under_create_rule(data as *const _);
        let kind = CFString::new("public.png");
        let dest = CGImageDestinationCreateWithData(data.as_concrete_TypeRef() as *mut c_void, kind.as_concrete_TypeRef(), 1, std::ptr::null());
        if dest.is_null() {
            return Err("the picture could not be made".into());
        }
        CGImageDestinationAddImage(dest, image, std::ptr::null());
        let done = CGImageDestinationFinalize(dest);
        CFRelease(dest);
        if !done {
            return Err("the picture could not be made".into());
        }
        Ok(data.bytes().to_vec())
    }
}

/// The Mac.
pub struct Mac;

impl Mac {
    /// The desk, with the accessibility API's wait for another app's answer set for this process (two seconds), so an
    /// app that hangs cannot hold a tool for long.
    pub fn new() -> Mac {
        if let Some(sys) = Ax::created(unsafe { AXUIElementCreateSystemWide() }) {
            unsafe { AXUIElementSetMessagingTimeout(sys.ptr(), 2.0) };
        }
        Mac
    }

    fn app(pid: i32) -> Option<Ax> {
        Ax::created(unsafe { AXUIElementCreateApplication(pid) })
    }

    fn window(pid: i32, window: usize) -> Result<Ax, String> {
        let app = Mac::app(pid).ok_or("the app cannot be reached")?;
        app.elements("AXWindows").into_iter().nth(window).ok_or_else(|| "that window is no longer open".to_string())
    }
}

/// Whether the screen is locked or asleep, read fresh each time (Orca's `SessionLockProbe`), or another person's
/// session is in front (`kCGSessionOnConsoleKey`, which `CGSession.h` spells `kCGSSessionOnConsoleKey`). With no
/// session dictionary at all nothing can be told, and that counts as locked.
pub fn session_locked() -> bool {
    let d = unsafe { CGSessionCopyCurrentDictionary() };
    if d.is_null() {
        return true;
    }
    let d: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(d) };
    let flag = |k: &str| d.find(CFString::new(k)).and_then(|v| v.downcast::<CFBoolean>()).map(bool::from);
    flag("CGSSessionScreenIsLocked") == Some(true) || flag("kCGSSessionOnConsoleKey") == Some(false)
}

/// Whether macOS lets this app use accessibility, read without asking.
pub fn accessibility_granted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Whether macOS lets this app capture the screen, read without asking.
pub fn screen_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

impl Desk for Mac {
    fn accessibility(&self) -> bool {
        accessibility_granted()
    }

    fn screen(&self) -> bool {
        screen_granted()
    }

    fn locked(&self) -> bool {
        session_locked()
    }

    fn own_pid(&self) -> i32 {
        std::process::id() as i32
    }

    fn apps(&self) -> Vec<App> {
        let list = unsafe { CGWindowListCopyWindowInfo(LIST_ALL, 0) };
        if list.is_null() {
            return Vec::new();
        }
        let list: CFArray = unsafe { CFArray::wrap_under_create_rule(list) };
        let mut out: Vec<App> = Vec::new();
        for p in list.iter() {
            if p.is_null() {
                continue;
            }
            let d: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(*p as CFDictionaryRef) };
            let num = |k: CFStringRef| d.find(unsafe { CFString::wrap_under_get_rule(k) }).and_then(|v| v.downcast::<CFNumber>());
            let layer = num(unsafe { kCGWindowLayer }).and_then(|n| n.to_i64());
            let alpha = num(unsafe { kCGWindowAlpha }).and_then(|n| n.to_f64()).unwrap_or(1.0);
            let Some(pid) = num(unsafe { kCGWindowOwnerPID }).and_then(|n| n.to_i64()) else { continue };
            let big = d
                .find(unsafe { CFString::wrap_under_get_rule(kCGWindowBounds) })
                .and_then(|v| v.downcast::<CFDictionary>())
                .map(|b| {
                    let mut r = CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: 0.0, height: 0.0 } };
                    let read = unsafe { CGRectMakeWithDictionaryRepresentation(b.as_concrete_TypeRef(), &mut r) };
                    read && r.size.width >= 48.0 && r.size.height >= 48.0
                })
                .unwrap_or(false);
            if layer != Some(0) || alpha <= 0.01 || !big || out.iter().any(|a| a.pid == pid as i32) {
                continue;
            }
            let name = d
                .find(unsafe { CFString::wrap_under_get_rule(kCGWindowOwnerName) })
                .and_then(|v| v.downcast::<CFString>())
                .map(|s| s.to_string())
                .unwrap_or_default();
            let path = path_of(pid as i32);
            out.push(App { pid: pid as i32, name, bundle: bundle_of(pid as i32, &path), path, mine: runs_as_me(pid as i32) });
        }
        out
    }

    fn windows(&self, pid: i32) -> Result<Vec<String>, String> {
        let app = Mac::app(pid).ok_or("the app cannot be reached")?;
        Ok(app.elements("AXWindows").iter().map(|w| w.string("AXTitle").unwrap_or_default()).collect())
    }

    fn tree(&self, pid: i32, window: usize) -> Result<Vec<Node>, String> {
        let root = Mac::window(pid, window)?;
        let mut out = Vec::new();
        let mut stack = vec![(root, 0usize)];
        while let Some((el, depth)) = stack.pop() {
            if out.len() >= MAX_NODES {
                break;
            }
            let children = if depth < MAX_DEPTH { el.elements("AXChildren") } else { Vec::new() };
            if let Some(n) = el.node(depth) {
                out.push(n);
            }
            for c in children.into_iter().rev() {
                stack.push((c, depth + 1));
            }
        }
        Ok(out)
    }

    fn picture(&self, pid: i32, window: usize) -> Result<Vec<u8>, String> {
        let win = Mac::window(pid, window)?;
        get_window().ok_or("this macOS does not say which window it is")?;
        let id = window_number(&win).ok_or("this window has no picture (it may be minimized)")?;
        let image = unsafe { CGWindowListCreateImage(CGRectNull, LIST_ONE, id, IMAGE_OPTIONS) };
        if image.is_null() {
            return Err("macOS gave no picture of this window".into());
        }
        let out = png(image);
        unsafe { CFRelease(image) };
        let out = out?;
        if out.len() > PICTURE_BYTES {
            return Err("the picture is too large to send".into());
        }
        Ok(out)
    }

    fn again(&self, handle: &Handle) -> Option<Node> {
        let el = ax(handle)?;
        Ax(el.0.clone()).node(0)
    }

    fn place(&self, handle: &Handle) -> Option<Place> {
        let el = Ax(ax(handle)?.0.clone());
        let role = el.string("AXRole")?;
        let win = if role == "AXWindow" { Ax(el.0.clone()) } else { el.element("AXWindow")? };
        // the control's index among its parent's children at each level, up to the window
        let mut path = Vec::new();
        let mut here = el;
        for _ in 0..=MAX_DEPTH + 1 {
            if here.0 == win.0 {
                path.reverse();
                return Some(Place { window: window_number(&win), path, frame: Ax(ax(handle)?.0.clone()).frame() });
            }
            let parent = here.element("AXParent")?;
            path.push(parent.elements("AXChildren").iter().position(|c| c.0 == here.0)?);
            here = parent;
        }
        None
    }

    fn window_of(&self, handle: &Handle) -> Option<Win> {
        ax(handle)?.window_facts()
    }

    fn snapshot(&self, place: &Place) -> Result<Vec<u8>, String> {
        let id = place.window.ok_or("the window has no number")?;
        let [x, y, w, h] = place.frame.ok_or("the control has no frame")?;
        let rect = CGRect { origin: CGPoint { x: x as f64, y: y as f64 }, size: CGSize { width: w as f64, height: h as f64 } };
        let image = unsafe { CGWindowListCreateImage(rect, LIST_ONE, id, IMAGE_OPTIONS) };
        if image.is_null() {
            return Err("macOS gave no picture of the control".into());
        }
        let out = png(image);
        unsafe { CFRelease(image) };
        out
    }

    fn focus(&self, pid: i32) -> Option<Focus> {
        let app = Mac::app(pid)?;
        let front = app.element("AXFocusedWindow");
        // the control that has the keyboard, unless the window itself (or nothing in it) does
        let el = app.element("AXFocusedUIElement").filter(|e| e.string("AXRole").is_some_and(|r| r != "AXWindow" && r != "AXApplication"));
        let Some(el) = el else {
            return Some(Focus { window: front?.window_facts()?, control: None });
        };
        let window = el.window_facts()?;
        let number = window.number;
        // the control's window must be the one macOS says has the keyboard; when the two disagree, where the key
        // would go cannot be told
        if front.is_some_and(|f| window_number(&f) != number) {
            return None;
        }
        let node = Ax(el.0.clone()).node(0)?;
        let place = self.place(&node.handle)?;
        Some(Focus { window, control: Some((node, place)) })
    }

    fn press(&self, handle: &Handle) -> Result<(), String> {
        let el = ax(handle).ok_or("not a control of this Mac")?;
        let err = unsafe { AXUIElementPerformAction(el.ptr(), CFString::new("AXPress").as_concrete_TypeRef()) };
        if err == 0 { Ok(()) } else { Err(ax_error(err, "the click")) }
    }

    fn set_value(&self, handle: &Handle, text: &str) -> Result<(), String> {
        let el = ax(handle).ok_or("not a control of this Mac")?;
        let v = CFString::new(text);
        let err = unsafe { AXUIElementSetAttributeValue(el.ptr(), CFString::new("AXValue").as_concrete_TypeRef(), v.as_CFTypeRef()) };
        if err == 0 { Ok(()) } else { Err(ax_error(err, "the typing")) }
    }

    fn keyboard(&self) -> Result<Keyboard, String> {
        on_main(read_keyboard).flatten().ok_or_else(|| "macOS did not say which keyboard layout is in use, so no key is pressed.".into())
    }

    fn key(&self, pid: i32, chord: &Chord, code: u16) -> Result<(), String> {
        for down in [true, false] {
            let e = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), code, down) };
            if e.is_null() {
                return Err("macOS could not make the key press".into());
            }
            unsafe {
                CGEventSetFlags(e, chord.flags());
                CGEventPostToPid(pid, e);
                CFRelease(e);
            }
        }
        Ok(())
    }

    fn menu(&self, pid: i32, path: &[String]) -> Result<(), String> {
        let app = Mac::app(pid).ok_or("the app cannot be reached")?;
        let mut here = app.element("AXMenuBar").ok_or("the app has no menu bar")?;
        for (i, title) in path.iter().enumerate() {
            let item = here
                .elements("AXChildren")
                .into_iter()
                // a menu's title as the card showed it: without invisible format characters
                .find(|c| c.string("AXTitle").is_some_and(|t| clean(&t).trim() == title.trim()))
                .ok_or_else(|| format!("There is no menu item “{title}” there, so nothing was chosen."))?;
            if i + 1 == path.len() {
                if item.boolean("AXEnabled") == Some(false) {
                    return Err(format!("“{title}” is greyed out, so nothing was chosen."));
                }
                let err = unsafe { AXUIElementPerformAction(item.ptr(), CFString::new("AXPress").as_concrete_TypeRef()) };
                return if err == 0 { Ok(()) } else { Err(ax_error(err, "choosing the menu item")) };
            }
            // a menu bar item or a submenu's item holds its menu as its one child
            here = item.elements("AXChildren").into_iter().next().ok_or_else(|| format!("“{title}” has no menu under it."))?;
        }
        Err("No menu item was named.".into())
    }
}
