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

use super::keys::Chord;
use super::room::{App, Desk, Handle, Node, MAX_DEPTH, MAX_NODES, SECURE};

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
}

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
        Some(Node { depth, role, subrole, label, value, enabled, handle: Arc::new(self) as Handle })
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

/// The bundle identifier of the app process `pid` runs, read from its `Info.plist`, or empty.
fn bundle_of(pid: i32) -> String {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
    if n <= 0 {
        return String::new();
    }
    let path = String::from_utf8_lossy(&buf[..n as usize]).into_owned();
    let Some(at) = path.rfind(".app/Contents/MacOS/") else { return String::new() };
    let plist = format!("{}.app/Contents/Info.plist", &path[..at]);
    plist::Value::from_file(plist)
        .ok()
        .and_then(|v| v.as_dictionary().and_then(|d| d.get("CFBundleIdentifier")).and_then(|b| b.as_string()).map(str::to_string))
        .unwrap_or_default()
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
            out.push(App { pid: pid as i32, name, bundle: bundle_of(pid as i32) });
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
        let get = get_window().ok_or("this macOS does not say which window it is")?;
        let mut id: u32 = 0;
        if unsafe { get(win.ptr(), &mut id) } != 0 || id == 0 {
            return Err("this window has no picture (it may be minimized)".into());
        }
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

    fn focused_window(&self, pid: i32) -> Option<String> {
        Mac::app(pid)?.element("AXFocusedWindow")?.string("AXTitle")
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

    fn key(&self, pid: i32, chord: &Chord) -> Result<(), String> {
        for down in [true, false] {
            let e = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), chord.code, down) };
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
                .find(|c| c.string("AXTitle").is_some_and(|t| t.trim() == title.trim()))
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
