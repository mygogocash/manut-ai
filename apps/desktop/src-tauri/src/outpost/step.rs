//! One browser step, run in the outpost's browser (docs/browser-control.md, "The step channel"). Three read: `open`
//! goes to a page, `read` reads the text of the page that is open (or of the part a selector names), and `sign_in`
//! redeems a grant and types the sign-in into the page that is open, then submits that form, since signing in is how
//! reading a shop's own site starts. One writes: `submit` makes a write the owner approved through approval-core,
//! exactly as approved ("Submitting through a browser"). Any other kind is not run at all (`not_run`), and neither is a
//! step missing what its kind needs: nothing is opened, read, typed or pressed for it.
//!
//! The browser is a seam (`Browser`): browser.rs is the real one, a Tauri webview window of its own; tests stand a fake
//! in for it. Everything that reads the page runs in the page's main frame in a JavaScript world of the outpost's own
//! (WKWebView's content worlds), so nothing the site's own scripts change about the page's built-ins changes what these
//! scripts see. The scripts only ever answer small JSON, never a field's value.
//!
//! The password's path: the redeem answers it into a buffer that is wiped when dropped (api.rs); it is checked again
//! here that the page is on one of the sign-in's own origins; it moves, without a copy, into the call that types it,
//! where the browser hands it to the page as an argument (never inside a script's text) and the Rust copy is wiped as
//! soon as the page has it. The script checks the page's origin again in the same evaluation, and types nothing if it
//! moved. Nothing here logs, reports or returns it: an outcome is a code from the fixed list, or what a read read.
//!
//! A write's values take the same road. They come only from the step the API handed out, which the begin gate filled
//! from the approved copy; they go to the page only, as arguments of the scripts that type and check them, in a buffer
//! wiped once WebKit has its own copy; and nothing is told what they were: not a report, not a note, not a log.

use super::api::{Failure, OutpostApi, OutpostStep, Outcome, Redeemed, SubmitValue, MAX_READ_TEXT_BYTES};
use super::origin::{self, Blocked};
use serde::Deserialize;
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

/// When a step's waiting ends: its own time, or the outpost stopping.
pub struct Until<'a> {
    pub deadline: Instant,
    pub stop: &'a AtomicBool,
}

impl Until<'_> {
    pub fn over(&self) -> bool {
        self.stopped() || Instant::now() >= self.deadline
    }

    /// The outpost is stopping under the step.
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// What a step whose waiting ended is reported as: it ran out of time, or the outpost stopped under it.
    pub fn failure(&self) -> Failure {
        if self.stop.load(Ordering::SeqCst) {
            Failure::BrowserError
        } else {
            Failure::TimedOut
        }
    }
}

/// The outpost's browser, as a step uses it.
pub trait Browser: Send + Sync {
    /// Goes to `url`, the guard on `origins` from now on, and waits until the page has loaded.
    fn open(&self, url: &str, origins: &[String], until: &Until) -> Result<(), Failure>;
    /// Leaves the page for an empty one (`about:blank`) and waits until it is there, so that the next `open` loads its
    /// page anew: never the page as it was left, and never a reload, which would send a form that page came from again.
    fn blank(&self, until: &Until) -> Result<(), Failure>;
    /// The address of the page that is open, or None when no page is.
    fn address(&self) -> Option<String>;
    /// Whether the page is still loading.
    fn loading(&self) -> bool;
    /// Keeps the guard on `origins` from now on.
    fn keep_on(&self, origins: &[String]);
    /// Runs `body` as an async function in the page's main frame, in a world of the outpost's own, with `args` as its
    /// string arguments, and answers the string it returned. The arguments are wiped once the page has them.
    fn call(&self, body: &'static str, args: Vec<(&'static str, Zeroizing<String>)>, until: &Until) -> Result<String, Failure>;
    /// What the guard refused since this was last asked: nothing, a frame of the page, or the page itself.
    fn take_blocked(&self) -> Blocked;
}

/// What the guard refused while a step ran, taken from the browser as the step goes and kept, so that a check part way
/// through and the check at its end see the same.
pub struct Watch<'a> {
    browser: &'a dyn Browser,
    seen: Cell<Blocked>,
}

impl<'a> Watch<'a> {
    pub fn new(browser: &'a dyn Browser) -> Self {
        Watch { browser, seen: Cell::new(Blocked::Nothing) }
    }

    /// Everything refused since the step began, the page outweighing a frame.
    pub fn now(&self) -> Blocked {
        let seen = self.seen.get().max(self.browser.take_blocked());
        self.seen.set(seen);
        seen
    }

    /// Whether anything at all was refused since the step began.
    pub fn any(&self) -> bool {
        self.now() != Blocked::Nothing
    }
}

/// How long each kind may take, and how often a wait looks again. Every budget is well inside a step's two minutes,
/// and a sign-in's inside its grant's minute.
pub struct Pace {
    pub open: Duration,
    pub read: Duration,
    pub sign_in: Duration,
    /// A write: loading its page, typing, pressing once and the site's answer, with loading the page again to read it
    /// back when the site kept its form and said nothing.
    pub submit: Duration,
    /// How long a write waits, once its page has loaded, for the form and every field to be on it: a page that draws
    /// its form with its own script after it loads, as most sellers' centres do, has none at first.
    pub appear: Duration,
    /// How long a write waits, once the values are in, for the page to turn its button on and for every field to read
    /// back as approved and be marked wrong by nothing (an editor may take a moment to take in its text).
    pub press: Duration,
    /// How often a wait looks at the page again.
    pub poll: Duration,
    /// How long the site's answer to a sign-in or a write must stay the same before it is taken as its answer.
    pub settled: Duration,
    /// How long a site must keep a write's form, every value as typed and nothing said, before the outpost loads the
    /// page again to read what it saved: longer than an answer's `settled`, so a page that is still saving, or about to
    /// empty its form or move, is given the time to.
    pub kept: Duration,
}

pub const PACE: Pace = Pace {
    open: Duration::from_secs(30),
    read: Duration::from_secs(15),
    sign_in: Duration::from_secs(40),
    submit: Duration::from_secs(60),
    appear: Duration::from_secs(10),
    press: Duration::from_secs(10),
    poll: Duration::from_millis(400),
    settled: Duration::from_secs(3),
    kept: Duration::from_secs(6),
};

/// Whether something can be seen: an input a person could type into, or a button they could press.
const VISIBLE: &str = r#"const visible = (el) => {
  if (!el || el.disabled || el.type === "hidden" || el.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
};"#;

/// Finding what a selector names, in the page and in every open shadow root inside it (a part of a page whose script
/// keeps its elements apart, as web components do). `find` answers the first match: the page's own first, then each
/// shadow root's in the order the page holds them, nested ones after; null for a selector that names nothing or is not
/// one. `all` answers every match in that order. A closed shadow root cannot be reached from a script at all, so what is
/// inside one is never found: a step naming it ends as if it were not on the page (`selector_not_found`), with nothing
/// typed.
const FIND: &str = r#"const roots = () => {
  const found = [document];
  for (let i = 0; i < found.length; i++) {
    for (const el of found[i].querySelectorAll("*")) if (el.shadowRoot) found.push(el.shadowRoot);
  }
  return found;
};
const find = (s) => {
  try { document.querySelector(s); } catch (_) { return null; }
  for (const root of roots()) {
    const el = root.querySelector(s);
    if (el !== null) return el;
  }
  return null;
};
const all = (s) => roots().flatMap((root) => Array.from(root.querySelectorAll(s)));"#;

/// `read`: the text of the page (`s` empty) or of the first element selector `s` names (in the page or an open shadow
/// root), at most `m` UTF-16 units, with any half of a surrogate pair made whole, so the answer is always valid JSON.
/// `{ t }`, or `{ e: "origin" }` for a page off the origins `o`, or `{ e: "selector" }` for a selector that names nothing
/// or is not one.
pub const READ: &str = r#"const origins = JSON.parse(o);
if (!origins.includes(location.origin)) return JSON.stringify({ e: "origin" });
FIND
let node = document.body ?? document.documentElement;
if (s !== "") {
  node = find(s);
  if (node === null) return JSON.stringify({ e: "selector" });
}
const text = node === null ? "" : String(node.innerText ?? node.textContent ?? "").slice(0, Number(m));
let well = "";
for (let i = 0; i < text.length; i++) {
  const c = text.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = text.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) { well += text[i] + text[i + 1]; i++; } else { well += "�"; }
  } else if (c >= 0xdc00 && c <= 0xdfff) {
    well += "�";
  } else {
    well += text[i];
  }
}
return JSON.stringify({ t: well });"#;

/// `sign_in`, before the redeem: whether the page has a visible password field to type into, and where the page is
/// (`a`, its origin and path). `{ e: "origin" }` for a page off the origins `o`.
pub const FORM: &str = r#"const origins = JSON.parse(o);
if (!origins.includes(location.origin)) return JSON.stringify({ e: "origin" });
VISIBLE
const field = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
return JSON.stringify({ f: field !== undefined, a: location.origin + location.pathname });"#;

/// `sign_in`: types username `u` and password `p` into the page's sign-in form and submits it. The page's origin is
/// checked against the sign-in's origins `o` first, in this same evaluation: off them, nothing is typed
/// (`{ r: "origin" }`). `{ r: "form" }` when there is no visible password field; `{ r: "typed" }` once it is done. The
/// values go in through the input's own setter and the events a person's typing fires, so a site's scripts see them as
/// typed. It answers nothing about what it typed.
pub const TYPE: &str = r#"const origins = JSON.parse(o);
if (!origins.includes(location.origin)) return JSON.stringify({ r: "origin" });
VISIBLE
const password = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
if (password === undefined) return JSON.stringify({ r: "form" });
const scope = password.form ?? document;
const texts = Array.from(scope.querySelectorAll("input")).filter((el) => visible(el) && !el.readOnly &&
  ["", "text", "email", "tel"].includes((el.getAttribute("type") ?? "").toLowerCase()));
let user = texts.find((el) => (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).includes("username"));
if (user === undefined) {
  const before = texts.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
  user = before[before.length - 1];
}
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
const put = (el, value) => {
  el.focus();
  setValue.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
if (user !== undefined) put(user, u);
put(password, p);
const form = password.form;
const button = form === null ? undefined :
  Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')).find(visible);
if (button !== undefined) button.click();
else if (form !== null && typeof form.requestSubmit === "function") form.requestSubmit();
else for (const type of ["keydown", "keypress", "keyup"]) {
  password.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
}
return JSON.stringify({ r: "typed" });"#;

/// `sign_in`, after the submit: how the site answered. `in` when no visible password field is left; `refused` when
/// the page is still where the form was (`a`) and every visible password field is empty, as a site leaves it when it
/// refused the password; otherwise `pending` (still loading, a captcha, a site that keeps what was typed). `away` for
/// a page off the step's origins `o`.
pub const CHECK: &str = r#"const origins = JSON.parse(o);
if (!origins.includes(location.origin)) return JSON.stringify({ s: "away" });
if (document.readyState !== "complete") return JSON.stringify({ s: "pending" });
VISIBLE
const fields = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
if (fields.length === 0) return JSON.stringify({ s: "in" });
if (location.origin + location.pathname === a && fields.every((f) => f.value === "")) return JSON.stringify({ s: "refused" });
return JSON.stringify({ s: "pending" });"#;

/// What a write's scripts share (with `VISIBLE` and `FIND` before them): what kind of field an element is to a write,
/// what a field holds as a write compares it, whether a value can go into a field, setting it as a person would, and
/// whether the page marks a field as wrong, or its form holds a field the browser itself would refuse to send.
///
/// A write fills what a person types text into, chooses from, or ticks: an input of a text kind, a text area or an
/// editor that is not a form field (`contenteditable`, the element that is the editor itself) takes text; a list takes
/// one of its items by value; a check box takes "checked" or "unchecked"; a radio button takes the value of one of the
/// buttons of its group (the buttons of its form with its name), which is then chosen. Never a password field
/// (passwords come only from the vault, through a sign-in step), a hidden one, a file, or anything that cannot be seen.
///
/// Each is set the way a person's input sets it, so the page's own handlers run: text through the field's own setter
/// with the events typing fires; an editor's text by selecting what it holds and typing over it through the browser's
/// own editing (`insertText`, and `insertLineBreak` for a line break, as Shift and Return make one, so a chat's editor
/// never takes a line break as Send); a check box or a radio button by clicking it, only when it is not already as asked.
///
/// A text area reads a line break as one "\n". An editor's text is read as a person reads it: each line break and each
/// line of its own as "\n", a no-break space as a space, the invisible marks editors keep for the caret left out, and the
/// empty line an editor keeps at its end for the caret not counted.
const FIELDS: &str = r#"const TYPED = ["text", "search", "email", "tel", "url", "number", "date", "time", "datetime-local", "month", "week"];
const toggle = (el) => el !== null && el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
const editor = (el) => el.isContentEditable === true && !(el.parentElement !== null && el.parentElement.isContentEditable);
const kindOf = (el) => {
  if (!visible(el)) return null;
  if (el.tagName === "INPUT" && el.type === "checkbox") return "check";
  if (el.tagName === "INPUT" && el.type === "radio") return "radio";
  if (el.readOnly) return null;
  if (el.tagName === "TEXTAREA") return "text";
  if (el.tagName === "INPUT") return TYPED.includes(el.type) ? "text" : null;
  if (el.tagName === "SELECT") return el.multiple ? null : "choice";
  return editor(el) ? "editor" : null;
};
const group = (el) => el.name === "" ? [el] :
  Array.from(el.getRootNode().querySelectorAll('input[type="radio"]')).filter((r) => r.name === el.name && r.form === el.form);
const plain = (text) => text.replace(/\r\n?/g, "\n").replace(/ /g, " ").replace(/[​﻿]/g, "");
const editorText = (el) => {
  let out = "";
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { out += child.data; continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const display = getComputedStyle(child).display;
      if (display === "none") continue;
      if (child.tagName === "BR") { out += "\n"; continue; }
      const line = !display.startsWith("inline") && display !== "contents";
      if (line && out !== "" && !out.endsWith("\n")) out += "\n";
      walk(child);
      if (line && !out.endsWith("\n")) out += "\n";
    }
  };
  walk(el);
  const text = plain(out);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
};
const read = (el) => {
  if (el.tagName === "INPUT" && el.type === "checkbox") return el.checked ? "checked" : "unchecked";
  if (el.tagName === "INPUT" && el.type === "radio") { const on = group(el).find((r) => r.checked); return on === undefined ? "" : on.value; }
  if (el.tagName === "TEXTAREA") return el.value.replace(/\r\n?/g, "\n");
  if (el.tagName === "INPUT" || el.tagName === "SELECT") return el.value;
  return editor(el) ? editorText(el) : null;
};
const wanted = (el, value) => el.tagName === "TEXTAREA" ? value.replace(/\r\n?/g, "\n") : editor(el) ? plain(value) : value;
const holds = (el, value) => el !== null && read(el) === wanted(el, value);
const fits = (el, kind, value) =>
  kind === "check" ? value === "checked" || value === "unchecked" :
  kind === "radio" ? group(el).some((r) => r.value === value && visible(r)) :
  kind === "choice" ? Array.from(el.options).some((x) => x.value === value && !x.disabled) :
  true;
const SETTERS = { INPUT: HTMLInputElement, TEXTAREA: HTMLTextAreaElement, SELECT: HTMLSelectElement };
const put = (el, kind, value) => {
  if (kind === "check") { if (el.checked !== (value === "checked")) el.click(); return; }
  if (kind === "radio") { const r = group(el).find((x) => x.value === value && visible(x)); if (!r.checked) r.click(); return; }
  el.focus();
  if (kind === "editor") {
    // Only into the editor itself: one that did not take the focus is typed into not at all, so nothing goes anywhere
    // else, and reading it back stops the press.
    if (el.getRootNode().activeElement !== el) return;
    document.execCommand("selectAll");
    if (value === "") document.execCommand("delete");
    value.replace(/\r\n?/g, "\n").split("\n").forEach((line, i) => {
      if (i > 0) document.execCommand("insertLineBreak");
      if (line !== "") document.execCommand("insertText", false, line);
    });
  } else {
    Object.getOwnPropertyDescriptor(SETTERS[el.tagName].prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  el.blur();
};
const flagged = (el) => el.getAttribute("aria-invalid") === "true" ||
  (el.form instanceof HTMLFormElement && !el.form.noValidate && el.matches(":invalid"));
const blocks = (target) => {
  const form = target.tagName === "FORM" ? target : target.form ?? null;
  return form !== null && !form.noValidate && !target.formNoValidate && form.matches(":invalid");
};"#;

/// `submit`: checks that the form `f` (or the button it names) and every field of `v` (`[[field, value], ...]`, in order)
/// are on the page or in one of its open shadow roots, and that each value can go into its field, before anything is
/// typed; then sets each value in order, as a person's input does (`FIELDS`), each field found again first, since a value
/// set may change the page. `{ r: "set" }`; `{ r: "form" }` for no form or button to press; `{ r: "field" }` for a field
/// that is missing or takes no value of a write (a list without that item, a radio group without that button, a check box
/// asked for anything but "checked" or "unchecked"); `{ r: "moved" }` for a field that went while typing; `{ r: "origin" }`
/// for a page off the origins `o`, where nothing is typed. It answers nothing about the values.
pub const SET: &str = r#"const origins = JSON.parse(o);
if (!origins.includes(location.origin)) return JSON.stringify({ r: "origin" });
VISIBLE
FIND
FIELDS
const pairs = JSON.parse(v);
const target = find(f);
const pressable = target !== null && target.getClientRects().length > 0 && (
  target.tagName === "FORM" ? typeof target.requestSubmit === "function" :
  target.tagName === "BUTTON" ? target.type !== "reset" :
  target.tagName === "INPUT" ? ["submit", "button", "image"].includes(target.type) :
  target.getAttribute("role") === "button");
if (!pressable) return JSON.stringify({ r: "form" });
for (const [s, value] of pairs) {
  const el = find(s);
  const kind = el === null ? null : kindOf(el);
  if (kind === null || !fits(el, kind, value)) return JSON.stringify({ r: "field" });
}
for (const [s, value] of pairs) {
  const el = find(s);
  const kind = el === null ? null : kindOf(el);
  if (kind === null || !fits(el, kind, value)) return JSON.stringify({ r: "moved" });
  put(el, kind, value);
}
return JSON.stringify({ r: "set" });"#;

/// `submit`, once the values are in: reads every field back, and presses once only while each holds exactly its approved
/// value (a check box ticked or not as asked, the radio button asked for chosen, an editor's text as asked) and the page
/// marks none of them as wrong. A form is submitted as its own submit does (`requestSubmit`, which runs the page's
/// checks); a button is clicked once the page has turned it on. `{ r: "pressed", a }` with the address just before the
/// press; `{ r: "wait" }` for a button not on yet (nothing pressed); `{ r: "changed" }` when a field does not hold its
/// value and `{ r: "flagged" }` when the page marks one as wrong or the browser would refuse the form (nothing pressed);
/// `{ r: "gone" }` when the form or button went; `{ r: "origin" }` off the origins `o`.
pub const PRESS: &str = r#"const origins = JSON.parse(o);
if (!origins.includes(location.origin)) return JSON.stringify({ r: "origin" });
VISIBLE
FIND
FIELDS
const pairs = JSON.parse(v);
const fields = pairs.map(([s, value]) => [find(s), value]);
if (!fields.every(([el, value]) => holds(el, value))) return JSON.stringify({ r: "changed" });
const target = find(f);
if (target === null) return JSON.stringify({ r: "gone" });
if (fields.some(([el]) => flagged(el)) || blocks(target)) return JSON.stringify({ r: "flagged" });
const a = location.href;
if (target.tagName === "FORM") {
  target.requestSubmit();
  return JSON.stringify({ r: "pressed", a });
}
if (!visible(target) || target.getAttribute("aria-disabled") === "true") return JSON.stringify({ r: "wait" });
target.click();
return JSON.stringify({ r: "pressed", a });"#;

/// `submit`, after the press: how the site answered. `sent` when the page moved from `a`, the form or button `f` went,
/// or every field given words is gone or emptied (a list back on its empty choice too; a check box or radio button is
/// given no words), as a chat empties its box once it has sent, or a form clears itself once taken. `refused` when the
/// page is where it was with the form, every value still as typed, and a field marked as wrong (or a form the browser
/// refuses): the site kept the form with an error. `kept` when it is where it was with the form, every value as typed and
/// nothing marked wrong: a settings page that saved and kept its form, or a site that has not answered yet, which only a
/// fresh look at the page can tell apart (`SAVED`). Otherwise `pending`: still loading, or between answers. `away` off
/// the step's origins `o`.
pub const SENT: &str = r#"const origins = JSON.parse(o);
if (!origins.includes(location.origin)) return JSON.stringify({ s: "away" });
if (document.readyState !== "complete") return JSON.stringify({ s: "pending" });
VISIBLE
FIND
FIELDS
const pairs = JSON.parse(v);
if (location.href !== a || find(f) === null) return JSON.stringify({ s: "sent" });
const given = pairs.filter(([s, value]) => value !== "" && !toggle(find(s)));
if (given.length > 0 && given.every(([s]) => { const el = find(s); return el === null || read(el) === ""; })) {
  return JSON.stringify({ s: "sent" });
}
const fields = pairs.map(([s, value]) => [find(s), value]);
if (fields.every(([el, value]) => holds(el, value))) {
  return JSON.stringify({ s: fields.some(([el]) => flagged(el)) || blocks(find(f)) ? "refused" : "kept" });
}
return JSON.stringify({ s: "pending" });"#;

/// `submit`, for a site that kept the form as typed and said nothing: the approved page loaded anew, read back. `saved`
/// when every field of `v` is on it and holds exactly its approved value, and at least one of those values is one a form
/// not yet filled in would not show (some text, a ticked box, a chosen button or item): the site keeps what was approved.
/// `blank` when every field holds its value but each is one an empty form shows too, which proves nothing. `other` when
/// a field is missing or holds anything else (a page still drawing its form, or one that did not keep the change).
/// `pending` while loading; `away` off the step's origins `o`. It never types or presses anything.
pub const SAVED: &str = r#"const origins = JSON.parse(o);
if (!origins.includes(location.origin)) return JSON.stringify({ s: "away" });
if (document.readyState !== "complete") return JSON.stringify({ s: "pending" });
VISIBLE
FIND
FIELDS
const pairs = JSON.parse(v);
const fields = pairs.map(([s, value]) => [find(s), value]);
if (!fields.every(([el, value]) => holds(el, value))) return JSON.stringify({ s: "other" });
const shows = ([el, value]) => toggle(el) ? value !== "" && value !== "unchecked" : wanted(el, value) !== "";
return JSON.stringify({ s: fields.some(shows) ? "saved" : "blank" });"#;

/// The scripts as they are run: `VISIBLE`, `FIND` and `FIELDS` written into each one that uses them. None of the three
/// holds another's name, so the order they are written in changes nothing.
pub fn script(body: &'static str) -> String {
    body.replace("FIELDS", FIELDS).replace("FIND", FIND).replace("VISIBLE", VISIBLE)
}

/// The kinds this outpost runs. Any other is not run at all.
pub const KINDS: [&str; 4] = ["open", "read", "sign_in", "submit"];

/// Runs one step and answers how it went. A step it cannot run (a kind it does not know, or one missing what its kind
/// needs) is `not_run`, which the API reads as nothing submitted: before, such a step was a browser error, which
/// settles a write as not known.
///
/// What a navigation the guard refused means depends on whose it was. For `open`, `read` and `sign_in`, the page
/// going, or trying to go, off the step's origins fails the step whatever else happened (`origin_not_allowed`); a frame
/// of the page the guard refused does not, since the frame stays empty and what the step read or typed was the page's
/// own (a site's sign-in page may well hold a frame of a widget from elsewhere). A write says for itself what either
/// means, since that turns on whether it had pressed yet (`submit`).
pub fn run_step(step: &OutpostStep, browser: &dyn Browser, api: &dyn OutpostApi, stop: &AtomicBool, pace: &Pace) -> Outcome {
    if !KINDS.contains(&step.kind.as_str()) {
        return Outcome::Failed(Failure::NotRun);
    }
    // With no origin its browser may be on, a step can run nowhere.
    let origins = origin::clean(&step.origins);
    if origins.is_empty() {
        return Outcome::Failed(Failure::NotRun);
    }
    // What the guard refused before this step began (between steps, say) is not this step's.
    browser.take_blocked();
    let watch = Watch::new(browser);
    let now = Instant::now();
    let result = match step.kind.as_str() {
        "open" => open(step, &origins, browser, &Until { deadline: now + pace.open, stop }),
        "read" => read(step, &origins, browser, &Until { deadline: now + pace.read, stop }, pace),
        "sign_in" => sign_in(step, &origins, browser, api, &Until { deadline: now + pace.sign_in, stop }, pace),
        _ => submit(step, &origins, browser, &watch, &Until { deadline: now + pace.submit, stop }, pace),
    };
    if step.kind != "submit" && watch.now() == Blocked::Page {
        return Outcome::Failed(Failure::OriginNotAllowed);
    }
    match result {
        Ok(text) => Outcome::Done(text),
        Err(failure) => Outcome::Failed(failure),
    }
}

fn open(step: &OutpostStep, origins: &[String], browser: &dyn Browser, until: &Until) -> Result<Option<String>, Failure> {
    let url = step.url.as_deref().ok_or(Failure::NotRun)?;
    if !origin::allowed(url, origins) {
        return Err(Failure::OriginNotAllowed);
    }
    browser.open(url, origins, until)?;
    Ok(None)
}

#[derive(Deserialize)]
struct ReadWire {
    t: Option<String>,
    e: Option<String>,
}

fn read(step: &OutpostStep, origins: &[String], browser: &dyn Browser, until: &Until, pace: &Pace) -> Result<Option<String>, Failure> {
    on_page(origins, browser, until, pace)?;
    browser.keep_on(origins);
    let args = vec![
        ("o", Zeroizing::new(origins_json(origins))),
        ("s", Zeroizing::new(step.selector.clone().unwrap_or_default())),
        // Twice what can be reported, in UTF-16 units, so the cut below has text to cut from without the page sending
        // megabytes.
        ("m", Zeroizing::new((MAX_READ_TEXT_BYTES * 2).to_string())),
    ];
    let wire: ReadWire = serde_json::from_str(&browser.call(READ, args, until)?).map_err(|_| Failure::BrowserError)?;
    match (wire.t, wire.e.as_deref()) {
        (Some(text), None) => Ok(Some(cut(&text))),
        (None, Some("origin")) => Err(Failure::OriginNotAllowed),
        (None, Some("selector")) => Err(Failure::SelectorNotFound),
        _ => Err(Failure::BrowserError),
    }
}

#[derive(Deserialize)]
struct FormWire {
    f: Option<bool>,
    a: Option<String>,
    e: Option<String>,
}

#[derive(Deserialize)]
struct TypedWire {
    r: String,
}

#[derive(Deserialize)]
struct CheckWire {
    s: String,
}

fn sign_in(step: &OutpostStep, origins: &[String], browser: &dyn Browser, api: &dyn OutpostApi, until: &Until, pace: &Pace)
    -> Result<Option<String>, Failure> {
    let grant = step.grant_id.as_deref().ok_or(Failure::NotRun)?;
    on_page(origins, browser, until, pace)?;
    browser.keep_on(origins);
    // Is there a form to type into? Asked before the redeem, so a password is never fetched for a page it cannot go into.
    let form: FormWire = serde_json::from_str(&browser.call(FORM, vec![("o", Zeroizing::new(origins_json(origins)))], until)?)
        .map_err(|_| Failure::BrowserError)?;
    let at = match (form.f, form.a, form.e.as_deref()) {
        (_, _, Some("origin")) => return Err(Failure::OriginNotAllowed),
        (Some(false), _, None) => return Err(Failure::SelectorNotFound),
        (Some(true), Some(at), None) => at,
        _ => return Err(Failure::BrowserError),
    };
    let Redeemed { origins: theirs, username, password } = api.redeem(grant).map_err(|_| Failure::GrantRefused)?;
    // It is typed only on the sign-in's own origins as the vault answered them, which are also this step's.
    let typing: Vec<String> = origin::clean(&theirs).into_iter().filter(|o| origins.contains(o)).collect();
    match browser.address() {
        Some(address) if origin::allowed(&address, &typing) => {}
        // Dropping the username and password here wipes them.
        _ => return Err(Failure::OriginNotAllowed),
    }
    let typed = browser.call(TYPE, vec![("o", Zeroizing::new(origins_json(&typing))), ("u", username), ("p", password)], until)?;
    match serde_json::from_str::<TypedWire>(&typed).map_err(|_| Failure::BrowserError)?.r.as_str() {
        "typed" => {}
        "origin" => return Err(Failure::OriginNotAllowed),
        "form" => return Err(Failure::SelectorNotFound),
        _ => return Err(Failure::BrowserError),
    }
    settle(origins, &at, browser, until, pace)
}

/// Waits for the site's answer to a sign-in: the same answer seen for `pace.settled` while nothing loads. A site that
/// signed in leaves no password field (done); one that refused the password leaves its form, emptied, where it was
/// (`sign_in_refused`). Anything still undecided when the step's time is up is `timed_out`, never a refusal: a
/// refusal marks the sign-in broken for everyone until the owner types a new password.
fn settle(origins: &[String], at: &str, browser: &dyn Browser, until: &Until, pace: &Pace) -> Result<Option<String>, Failure> {
    let mut seen: Option<(String, Instant)> = None;
    loop {
        if until.over() {
            return Err(until.failure());
        }
        std::thread::sleep(pace.poll);
        if browser.loading() {
            seen = None;
            continue;
        }
        let args = vec![("o", Zeroizing::new(origins_json(origins))), ("a", Zeroizing::new(at.to_owned()))];
        // A page between two loads cannot be read; it is looked at again.
        let Some(state) = browser.call(CHECK, args, until).ok().and_then(|s| serde_json::from_str::<CheckWire>(&s).ok()) else {
            seen = None;
            continue;
        };
        let now = Instant::now();
        let since = match &seen {
            Some((last, since)) if *last == state.s => *since,
            _ => {
                seen = Some((state.s.clone(), now));
                now
            }
        };
        if now.duration_since(since) < pace.settled {
            continue;
        }
        match state.s.as_str() {
            "in" => return Ok(None),
            "refused" => return Err(Failure::SignInRefused),
            "away" => return Err(Failure::OriginNotAllowed),
            _ => {}
        }
    }
}

#[derive(Deserialize)]
struct SetWire {
    r: String,
}

#[derive(Deserialize)]
struct PressWire {
    r: String,
    a: Option<String>,
}

/// `submit`: makes the write the owner approved, exactly as approved, once. Nothing is typed until the approved page is
/// open (loaded fresh, so the form holds only what the site put there), on the step's origin, with nothing refused on
/// the way, and the form and every field are found on it; then each value is set in order, the form is submitted or its
/// button pressed once, and the site's answer must hold before it is taken: `done` when it took the write,
/// `submit_refused` when it kept the form with an error. Anything still undecided at the end of the step's time is
/// `timed_out`, never a guess either way: the API then settles the write as not known.
///
/// A navigation the guard refused, of the page or of any of its frames, is read by when it happened. Before the press,
/// it stops the write with nothing sent (`navigation_refused`, which the API settles as failed): what was approved was a
/// form on that page alone, and a frame from elsewhere (a payment box, a check that you are a person) may be part of what
/// the page would submit. After the press, it leaves it not known whether the site took the write (`origin_not_allowed`),
/// since the site may have needed what was refused to finish it.
fn submit(step: &OutpostStep, origins: &[String], browser: &dyn Browser, watch: &Watch, until: &Until, pace: &Pace)
    -> Result<Option<String>, Failure> {
    let (Some(url), Some(form), Some(values)) = (step.url.as_deref(), step.form.as_deref(), step.values.as_deref()) else {
        return Err(Failure::NotRun);
    };
    if !origin::allowed(url, origins) {
        return Err(Failure::OriginNotAllowed);
    }
    // Everything up to the press. Whatever ends it, nothing was pressed, so a refusal seen by then is the reason given.
    let typed = (|| {
        browser.open(url, origins, until).map_err(|failure| before_typing(failure, until))?;
        // A page that went, or tried to go, off the step's origin on the way, or a frame of it that did, is not the page
        // the owner approved.
        if watch.any() {
            return Err(Failure::NavigationRefused);
        }
        browser.keep_on(origins);
        // The values as the scripts take them, written once; each script is handed a copy, wiped once WebKit has it.
        // Without them nothing may be typed or pressed: a form pressed with none would be a write nobody approved.
        let v = values_json(values).ok_or(Failure::NotRun)?;
        // A form or a field not there yet is looked for again until `pace.appear` is over, since many pages draw their
        // form with their own script once they have loaded. Nothing is typed before all of it is there, so looking
        // again never types anything twice.
        let appear = Instant::now() + pace.appear;
        loop {
            if until.over() {
                return Err(before_typing(until.failure(), until));
            }
            let set: SetWire = serde_json::from_str(&browser.call(SET, write_args(origins, form, &v, None), until)?)
                .map_err(|_| Failure::BrowserError)?;
            match set.r.as_str() {
                "set" => return Ok(v),
                "form" | "field" if Instant::now() < appear && !watch.any() => std::thread::sleep(pace.poll),
                "origin" => return Err(Failure::OriginNotAllowed),
                "form" | "field" | "moved" => return Err(Failure::SelectorNotFound),
                _ => return Err(Failure::BrowserError),
            }
        }
    })();
    let v = typed.map_err(|failure| if watch.any() { Failure::NavigationRefused } else { failure })?;
    let args = |extra: Option<&str>| write_args(origins, form, &v, extra);
    let at = press(browser, watch, &args, until, pace)?;
    let answer = sent(browser, watch, &args, &at, url, origins, until, pace);
    if watch.any() {
        return Err(Failure::OriginNotAllowed);
    }
    answer
}

/// The arguments of a write's scripts: the step's origins `o`, the form or button `f`, the values `v`, and for the
/// site's answer the address `a` just before the press. Each is a copy, wiped once WebKit has its own.
fn write_args(origins: &[String], form: &str, v: &str, at: Option<&str>) -> Vec<(&'static str, Zeroizing<String>)> {
    let mut args = vec![("o", Zeroizing::new(origins_json(origins))), ("f", Zeroizing::new(form.to_owned())),
        ("v", Zeroizing::new(v.to_owned()))];
    if let Some(at) = at {
        args.push(("a", Zeroizing::new(at.to_owned())));
    }
    args
}

/// A failure found before anything was typed, as a write step reports it: nothing was submitted, so it is said with a
/// code the API reads that way wherever one is true. A page that did not load, in time or at all, is `page_unavailable`;
/// the outpost stopping is `not_run`; a page that ended up off the step's origin with nothing refused on the way stays
/// `origin_not_allowed`.
fn before_typing(failure: Failure, until: &Until) -> Failure {
    if until.stopped() {
        return Failure::NotRun;
    }
    match failure {
        Failure::TimedOut | Failure::BrowserError => Failure::PageUnavailable,
        other => other,
    }
}

/// Presses once, and answers the address the page was at just before. A button the page has not turned on yet, a field
/// that does not read back as approved yet (an editor taking in its text) or one the page still marks as wrong is looked
/// at again until `pace.press` is over: still so then means the site would not take what was approved, so nothing was
/// submitted (`submit_refused`). Only an answer that nothing was pressed is ever asked again; a press whose answer did
/// not come back may have been made, so it fails the step, as not known, and is never made twice. Nothing is pressed
/// once the guard has refused a navigation of the page or a frame since the page opened (`navigation_refused`).
fn press(browser: &dyn Browser, watch: &Watch, args: &dyn Fn(Option<&str>) -> Vec<(&'static str, Zeroizing<String>)>, until: &Until,
    pace: &Pace) -> Result<String, Failure> {
    let waited = Instant::now() + pace.press;
    // Why nothing was pressed: a refusal seen by now outweighs what the page answered.
    let unpressed = |failure: Failure| if watch.any() { Failure::NavigationRefused } else { failure };
    loop {
        // The page has a moment to take in what was typed, or to turn its button on.
        std::thread::sleep(pace.poll);
        if until.over() {
            return Err(unpressed(until.failure()));
        }
        if watch.any() {
            return Err(Failure::NavigationRefused);
        }
        let wire: PressWire = serde_json::from_str(&browser.call(PRESS, args(None), until)?).map_err(|_| Failure::BrowserError)?;
        match (wire.r.as_str(), wire.a) {
            ("pressed", Some(at)) => return Ok(at),
            ("wait" | "changed" | "flagged", _) if Instant::now() < waited => {}
            ("wait" | "changed" | "flagged", _) => return Err(unpressed(Failure::SubmitRefused)),
            ("gone", _) => return Err(unpressed(Failure::SelectorNotFound)),
            ("origin", _) => return Err(unpressed(Failure::OriginNotAllowed)),
            _ => return Err(Failure::BrowserError),
        }
    }
}

/// Looks at the page until one of its answers has held: `script` answering the same (its `s`) for as long as `hold` says
/// that answer must hold, while nothing loads. An answer `hold` gives no time to decides nothing, and the step's time
/// running out ends the wait as it ended (`timed_out`, or a browser error when the outpost stopped). The guard refusing
/// a navigation at least as weighty as `stops` ends it at once (`origin_not_allowed`).
fn answered(browser: &dyn Browser, watch: &Watch, stops: Blocked, script: &'static str,
    args: &dyn Fn() -> Vec<(&'static str, Zeroizing<String>)>, until: &Until, pace: &Pace, hold: &dyn Fn(&str) -> Option<Duration>)
    -> Result<String, Failure> {
    let mut seen: Option<(String, Instant)> = None;
    loop {
        if until.over() {
            return Err(until.failure());
        }
        std::thread::sleep(pace.poll);
        if watch.now() >= stops {
            return Err(Failure::OriginNotAllowed);
        }
        if browser.loading() {
            seen = None;
            continue;
        }
        // A page between two loads cannot be read; it is looked at again.
        let Some(state) = browser.call(script, args(), until).ok().and_then(|s| serde_json::from_str::<CheckWire>(&s).ok()) else {
            seen = None;
            continue;
        };
        let now = Instant::now();
        let since = match &seen {
            Some((last, since)) if *last == state.s => *since,
            _ => {
                seen = Some((state.s.clone(), now));
                now
            }
        };
        if hold(&state.s).is_some_and(|hold| now.duration_since(since) >= hold) {
            return Ok(state.s);
        }
    }
}

/// Waits for the site's answer to a write: the same answer seen for `pace.settled` while nothing loads, as for a sign-in.
/// A navigation the guard refused since the press ends the wait at once: the write is then not known, whatever the page
/// goes on to show. A site that kept the form as typed and said nothing for `pace.kept` is looked at again, fresh
/// (`saved`): the only way to tell a settings page that saved and kept its form from one that never answered.
fn sent(browser: &dyn Browser, watch: &Watch, args: &dyn Fn(Option<&str>) -> Vec<(&'static str, Zeroizing<String>)>, at: &str,
    url: &str, origins: &[String], until: &Until, pace: &Pace) -> Result<Option<String>, Failure> {
    let answer = answered(browser, watch, Blocked::Frame, SENT, &|| args(Some(at)), until, pace, &|answer| match answer {
        "sent" | "refused" | "away" => Some(pace.settled),
        "kept" => Some(pace.kept),
        _ => None,
    })?;
    match answer.as_str() {
        "sent" => Ok(None),
        "refused" => Err(Failure::SubmitRefused),
        "away" => Err(Failure::OriginNotAllowed),
        _ => saved(browser, watch, &|| args(None), url, origins, until, pace),
    }
}

/// How a write that kept its form ends: the approved page loaded anew, after an empty one, so it is neither the page as
/// it was left nor a reload (which would send the form again), and read back. Every field holding exactly its approved
/// value, at least one of them one a form not yet filled in would not show, for `pace.settled`, is `done`: the site keeps
/// what was approved. Anything else by the end of the step's time is not known (`timed_out`), never a failure: the form
/// was pressed, so nobody can say that nothing was sent. Nothing is typed or pressed again.
fn saved(browser: &dyn Browser, watch: &Watch, args: &dyn Fn() -> Vec<(&'static str, Zeroizing<String>)>, url: &str,
    origins: &[String], until: &Until, pace: &Pace) -> Result<Option<String>, Failure> {
    browser.blank(until).map_err(after_press)?;
    browser.open(url, origins, until).map_err(after_press)?;
    browser.keep_on(origins);
    let answer = answered(browser, watch, Blocked::Frame, SAVED, args, until, pace, &|answer| match answer {
        "saved" | "away" => Some(pace.settled),
        _ => None,
    })?;
    match answer.as_str() {
        "saved" => Ok(None),
        _ => Err(Failure::OriginNotAllowed),
    }
}

/// A failure once a write was pressed, as it is reported: never with a code that says nothing was submitted, since the
/// press may have sent it. The page not loading again to be read back, say, is a browser error, which settles not known.
fn after_press(failure: Failure) -> Failure {
    match failure {
        Failure::PageUnavailable | Failure::SelectorNotFound | Failure::SignInRefused | Failure::GrantRefused | Failure::SubmitRefused
        | Failure::NotRun | Failure::NavigationRefused => Failure::BrowserError,
        other => other,
    }
}

/// A write's values as its scripts take them, `[[field, value], ...]` in order, written once into a buffer sized up
/// front, so no copy of a value is left behind that is not wiped. JSON writes no character as more than six bytes. None
/// if they could not be written, which never leaves anything to be typed.
fn values_json(values: &[SubmitValue]) -> Option<Zeroizing<String>> {
    let pairs: Vec<(&str, &str)> = values.iter().map(|v| (v.field.as_str(), v.value.as_str())).collect();
    let most = 2 + pairs.iter().map(|(field, value)| 6 * (field.len() + value.len()) + 8).sum::<usize>();
    let mut out = Zeroizing::new(Vec::with_capacity(most));
    serde_json::to_writer(&mut *out, &pairs).ok()?;
    // serde_json writes UTF-8, so this moves the buffer into the String without copying it.
    String::from_utf8(std::mem::take(&mut *out)).ok().map(Zeroizing::new)
}

/// The page is there to read and on the step's origins, once it has finished loading.
fn on_page(origins: &[String], browser: &dyn Browser, until: &Until, pace: &Pace) -> Result<(), Failure> {
    while browser.loading() {
        if until.over() {
            return Err(until.failure());
        }
        std::thread::sleep(pace.poll);
    }
    let address = browser.address().ok_or(Failure::PageUnavailable)?;
    if origin::origin_of(&address).is_none() {
        // about:blank, or nothing loaded: there is no page of any site to read or type into.
        return Err(Failure::PageUnavailable);
    }
    if !origin::allowed(&address, origins) {
        return Err(Failure::OriginNotAllowed);
    }
    Ok(())
}

fn origins_json(origins: &[String]) -> String {
    serde_json::to_string(origins).unwrap_or_else(|_| "[]".into())
}

/// `text` cut to at most `MAX_READ_TEXT_BYTES` once written as JSON in UTF-8, as the API measures it
/// (`JSON.stringify`, which writes the same escapes serde_json does), at a character's edge.
pub fn cut(text: &str) -> String {
    let mut size = 2;
    let mut end = 0;
    for (at, c) in text.char_indices() {
        let add = match c {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            c if (c as u32) < 0x20 => 6,
            c => c.len_utf8(),
        };
        if size + add > MAX_READ_TEXT_BYTES {
            break;
        }
        size += add;
        end = at + c.len_utf8();
    }
    text[..end].to_owned()
}

#[cfg(test)]
pub mod fake {
    //! A browser for tests: a page at an address, scripts answered by the test, and a record of everything asked of it.
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    pub type Answer = Box<dyn Fn(&'static str, &HashMap<&'static str, String>) -> Result<String, Failure> + Send + Sync>;

    pub struct FakeBrowser {
        pub page: Arc<Mutex<Option<String>>>,
        pub answer: Answer,
        /// What `open` does: the address it leaves the page at, what the guard refused on the way, and what it answers.
        pub on_open: Box<dyn Fn(&str) -> (Option<String>, Blocked, Result<(), Failure>) + Send + Sync>,
        /// What the guard refused and nobody has asked about yet; a test's answer may add to it, as a page's own
        /// scripts would while a script runs.
        pub blocked: Arc<Mutex<Blocked>>,
        pub opened: Mutex<Vec<String>>,
        pub kept: Mutex<Vec<Vec<String>>>,
        /// Each script run, by name, with its arguments.
        pub calls: Mutex<Vec<(&'static str, HashMap<&'static str, String>)>>,
    }

    pub fn name(body: &'static str) -> &'static str {
        if body == READ {
            "read"
        } else if body == FORM {
            "form"
        } else if body == TYPE {
            "type"
        } else if body == CHECK {
            "check"
        } else if body == SET {
            "set"
        } else if body == PRESS {
            "press"
        } else if body == SENT {
            "sent"
        } else if body == SAVED {
            "saved"
        } else {
            "other"
        }
    }

    impl FakeBrowser {
        pub fn at(page: Option<&str>, answer: Answer) -> Self {
            FakeBrowser {
                page: Arc::new(Mutex::new(page.map(str::to_owned))),
                answer,
                on_open: Box::new(|url| (Some(url.to_owned()), Blocked::Nothing, Ok(()))),
                blocked: Arc::new(Mutex::new(Blocked::Nothing)),
                opened: Mutex::new(Vec::new()),
                kept: Mutex::new(Vec::new()),
                calls: Mutex::new(Vec::new()),
            }
        }

        /// A page whose answers may note what the guard refused while a script ran: `make` is handed the browser's own
        /// record of it.
        pub fn refusing(page: Option<&str>, make: impl FnOnce(Arc<Mutex<Blocked>>) -> Answer) -> Self {
            let blocked = Arc::new(Mutex::new(Blocked::Nothing));
            FakeBrowser { blocked: blocked.clone(), ..FakeBrowser::at(page, make(blocked)) }
        }

        pub fn names(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().iter().map(|(n, _)| *n).collect()
        }
    }

    /// Notes that the guard refused `what`, as the hook does: the page outweighs a frame until someone asks.
    pub fn refuse(blocked: &Mutex<Blocked>, what: Blocked) {
        let mut held = blocked.lock().unwrap();
        *held = (*held).max(what);
    }

    impl Browser for FakeBrowser {
        fn open(&self, url: &str, origins: &[String], _until: &Until) -> Result<(), Failure> {
            self.opened.lock().unwrap().push(url.to_owned());
            self.kept.lock().unwrap().push(origins.to_vec());
            let (page, blocked, answer) = (self.on_open)(url);
            *self.page.lock().unwrap() = page;
            refuse(&self.blocked, blocked);
            answer
        }
        fn blank(&self, _until: &Until) -> Result<(), Failure> {
            self.opened.lock().unwrap().push("about:blank".into());
            *self.page.lock().unwrap() = Some("about:blank".into());
            Ok(())
        }
        fn address(&self) -> Option<String> {
            self.page.lock().unwrap().clone()
        }
        fn loading(&self) -> bool {
            false
        }
        fn keep_on(&self, origins: &[String]) {
            self.kept.lock().unwrap().push(origins.to_vec());
        }
        fn call(&self, body: &'static str, args: Vec<(&'static str, Zeroizing<String>)>, _until: &Until) -> Result<String, Failure> {
            let args: HashMap<&'static str, String> = args.into_iter().map(|(k, v)| (k, v.as_str().to_owned())).collect();
            let answer = (self.answer)(name(body), &args);
            self.calls.lock().unwrap().push((name(body), args));
            answer
        }
        fn take_blocked(&self) -> Blocked {
            std::mem::take(&mut *self.blocked.lock().unwrap())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{refuse, FakeBrowser};
    use super::*;
    use crate::outpost::api::ApiError;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    const SHOP: &str = "https://seller.shopee.co.th";
    const ACCOUNTS: &str = "https://accounts.shopee.co.th";

    const QUICK: Pace = Pace {
        open: Duration::from_millis(500),
        read: Duration::from_millis(500),
        sign_in: Duration::from_millis(500),
        submit: Duration::from_millis(500),
        appear: Duration::from_millis(40),
        press: Duration::from_millis(40),
        poll: Duration::from_millis(1),
        settled: Duration::from_millis(5),
        kept: Duration::from_millis(10),
    };

    /// QUICK, with waits long enough that a test which counts on looking again more than once still does on a machine
    /// so busy that one look takes most of QUICK's whole wait. Only tests that end as soon as the page answers use it.
    const PATIENT: Pace = Pace { submit: Duration::from_secs(20), appear: Duration::from_secs(5), press: Duration::from_secs(5), ..QUICK };

    /// An API whose redeem answers what the test says, and which counts redeems.
    struct Vault {
        redeem: Box<dyn Fn() -> Result<Redeemed, ApiError> + Send + Sync>,
        redeemed: Mutex<Vec<String>>,
    }

    impl OutpostApi for Vault {
        fn heartbeat(&self) -> Result<(), ApiError> {
            unreachable!()
        }
        fn steps(&self) -> Result<Vec<OutpostStep>, ApiError> {
            unreachable!()
        }
        fn redeem(&self, grant_id: &str) -> Result<Redeemed, ApiError> {
            self.redeemed.lock().unwrap().push(grant_id.to_owned());
            (self.redeem)()
        }
        fn report(&self, _: &str, _: &Outcome) -> Result<(), ApiError> {
            unreachable!()
        }
    }

    fn vault(origins: &'static [&'static str]) -> Vault {
        Vault {
            redeem: Box::new(move || Ok(Redeemed { origins: origins.iter().map(|o| o.to_string()).collect(),
                username: Zeroizing::new("fon@baanmali".into()), password: Zeroizing::new("Pa55-known".into()) })),
            redeemed: Mutex::new(Vec::new()),
        }
    }

    fn step(kind: &str, origins: &[&str]) -> OutpostStep {
        OutpostStep { step_id: "s-1".into(), kind: kind.into(), origins: origins.iter().map(|o| o.to_string()).collect(), ..Default::default() }
    }

    fn run(step: &OutpostStep, browser: &FakeBrowser, api: &Vault) -> Outcome {
        run_step(step, browser, api, &AtomicBool::new(false), &QUICK)
    }

    fn json_answer(value: serde_json::Value) -> Result<String, Failure> {
        Ok(value.to_string())
    }

    #[test]
    fn opens_a_page_only_on_the_steps_origins() {
        let browser = FakeBrowser::at(None, Box::new(|_, _| unreachable!()));
        let mut open = step("open", &[SHOP]);
        open.url = Some(format!("{SHOP}/portal/sale/order"));
        assert_eq!(run(&open, &browser, &vault(&[])), Outcome::Done(None));
        assert_eq!(*browser.opened.lock().unwrap(), [format!("{SHOP}/portal/sale/order")]);
        assert_eq!(browser.kept.lock().unwrap()[0], [SHOP.to_string()]);

        // An address off the step's origins is never opened.
        for away in ["https://evil.example/", "http://seller.shopee.co.th/", "https://user@seller.shopee.co.th/"] {
            open.url = Some(away.into());
            assert_eq!(run(&open, &browser, &vault(&[])), Outcome::Failed(Failure::OriginNotAllowed), "{away}");
        }
        assert_eq!(browser.opened.lock().unwrap().len(), 1);
        // A step with no origin the outpost can read can run nowhere: it is not run.
        let mut none = step("open", &["https://Seller.shopee.co.th", "*"]);
        none.url = Some(format!("{SHOP}/"));
        assert_eq!(run(&none, &browser, &vault(&[])), Outcome::Failed(Failure::NotRun));
        assert_eq!(browser.opened.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_page_that_goes_off_the_origins_on_the_way_fails_the_step() {
        let mut browser = FakeBrowser::at(None, Box::new(|_, _| unreachable!()));
        // The site redirected elsewhere: the guard refused it, and the page stayed where it was.
        browser.on_open = Box::new(|_| (None, Blocked::Page, Err(Failure::PageUnavailable)));
        let mut open = step("open", &[SHOP]);
        open.url = Some(format!("{SHOP}/"));
        assert_eq!(run(&open, &browser, &vault(&[])), Outcome::Failed(Failure::OriginNotAllowed));
        // A load that simply failed says so.
        browser.on_open = Box::new(|_| (None, Blocked::Nothing, Err(Failure::PageUnavailable)));
        assert_eq!(run(&open, &browser, &vault(&[])), Outcome::Failed(Failure::PageUnavailable));
        // Something refused between steps is not the next step's.
        browser.on_open = Box::new(|url| (Some(url.into()), Blocked::Nothing, Ok(())));
        *browser.blocked.lock().unwrap() = Blocked::Page;
        assert_eq!(run(&open, &browser, &vault(&[])), Outcome::Done(None));
    }

    #[test]
    fn a_frame_the_guard_refused_stays_empty_and_fails_no_step_that_reads() {
        let api = vault(&[ACCOUNTS]);
        // The page loaded with a frame from elsewhere in it, which the guard kept out: the page is still the step's.
        let mut browser = FakeBrowser::at(None, Box::new(|_, _| json_answer(serde_json::json!({ "t": "Shipped" }))));
        browser.on_open = Box::new(|url| (Some(url.into()), Blocked::Frame, Ok(())));
        let mut open = step("open", &[SHOP]);
        open.url = Some(format!("{SHOP}/portal"));
        assert_eq!(run(&open, &browser, &api), Outcome::Done(None));
        // A frame refused while a read runs leaves what it read, the page's own text.
        let reading = |what: Blocked| FakeBrowser::refusing(Some(&format!("{SHOP}/portal")), move |blocked| Box::new(move |_, _| {
            refuse(&blocked, what);
            json_answer(serde_json::json!({ "t": "Shipped" }))
        }));
        assert_eq!(run(&step("read", &[SHOP]), &reading(Blocked::Frame), &api), Outcome::Done(Some("Shipped".into())));
        // A sign-in whose page holds a frame from elsewhere still signs in: the password went into the page's own form,
        // which no frame from another origin can read.
        let signing = FakeBrowser::refusing(Some(&format!("{ACCOUNTS}/seller/login")), |blocked| Box::new(move |name, _| match name {
            "form" => json_answer(serde_json::json!({ "f": true, "a": format!("{ACCOUNTS}/seller/login") })),
            "type" => json_answer(serde_json::json!({ "r": "typed" })),
            _ => {
                refuse(&blocked, Blocked::Frame);
                json_answer(serde_json::json!({ "s": "in" }))
            }
        }));
        assert_eq!(run(&sign_in_step(), &signing, &api), Outcome::Done(None));
        // The page itself going elsewhere still fails each of them.
        browser.on_open = Box::new(|url| (Some(url.into()), Blocked::Page, Ok(())));
        assert_eq!(run(&open, &browser, &api), Outcome::Failed(Failure::OriginNotAllowed));
        assert_eq!(run(&step("read", &[SHOP]), &reading(Blocked::Page), &api), Outcome::Failed(Failure::OriginNotAllowed));
    }

    #[test]
    fn reads_the_page_or_a_part_of_it_cut_to_what_the_api_takes() {
        let long = "ร้าน \"มะลิ\"\n".repeat(400);
        let text = long.clone();
        let browser = FakeBrowser::at(Some(&format!("{SHOP}/portal")), Box::new(move |name, args| {
            assert_eq!(name, "read");
            match args["s"].as_str() {
                "" => json_answer(serde_json::json!({ "t": text })),
                ".status" => json_answer(serde_json::json!({ "t": "Shipped" })),
                "#gone" => json_answer(serde_json::json!({ "e": "selector" })),
                _ => json_answer(serde_json::json!({ "e": "origin" })),
            }
        }));
        let mut read = step("read", &[SHOP, ACCOUNTS]);
        let Outcome::Done(Some(whole)) = run(&read, &browser, &vault(&[])) else { panic!("not read") };
        assert!(serde_json::to_string(&whole).unwrap().len() <= MAX_READ_TEXT_BYTES);
        assert!(long.starts_with(&whole) && whole.len() > 2000);
        read.selector = Some(".status".into());
        assert_eq!(run(&read, &browser, &vault(&[])), Outcome::Done(Some("Shipped".into())));
        read.selector = Some("#gone".into());
        assert_eq!(run(&read, &browser, &vault(&[])), Outcome::Failed(Failure::SelectorNotFound));
        // The script found the page off the origins in the same evaluation.
        read.selector = Some("#moved".into());
        assert_eq!(run(&read, &browser, &vault(&[])), Outcome::Failed(Failure::OriginNotAllowed));
        // It was told the step's origins, and the guard was kept on them.
        let calls = browser.calls.lock().unwrap();
        assert_eq!(calls[0].1["o"], format!(r#"["{SHOP}","{ACCOUNTS}"]"#));
        assert_eq!(browser.kept.lock().unwrap()[0], [SHOP.to_string(), ACCOUNTS.to_string()]);
    }

    #[test]
    fn reads_nothing_with_no_page_open_or_a_page_off_the_steps_origins() {
        let api = vault(&[]);
        for (page, failure) in [(None, Failure::PageUnavailable), (Some("about:blank"), Failure::PageUnavailable),
            (Some("https://evil.example/x"), Failure::OriginNotAllowed), (Some("https://accounts.shopee.co.th/"), Failure::OriginNotAllowed)] {
            let browser = FakeBrowser::at(page, Box::new(|_, _| unreachable!("nothing is run on such a page")));
            assert_eq!(run(&step("read", &[SHOP]), &browser, &api), Outcome::Failed(failure), "{page:?}");
            assert!(browser.calls.lock().unwrap().is_empty());
        }
    }

    /// A sign-in page that answers each script as a site would: the form is there, typing works, and then the site
    /// answers `after` (the CHECK script's `s`).
    fn sign_in_page(after: &'static str) -> FakeBrowser {
        FakeBrowser::at(Some(&format!("{ACCOUNTS}/seller/login")), Box::new(move |name, _| match name {
            "form" => json_answer(serde_json::json!({ "f": true, "a": format!("{ACCOUNTS}/seller/login") })),
            "type" => json_answer(serde_json::json!({ "r": "typed" })),
            "check" => json_answer(serde_json::json!({ "s": after })),
            _ => unreachable!(),
        }))
    }

    fn sign_in_step() -> OutpostStep {
        let mut s = step("sign_in", &[SHOP, ACCOUNTS]);
        s.grant_id = Some("g-1".into());
        s
    }

    #[test]
    fn signs_in_with_a_redeemed_grant_only_on_the_sign_ins_own_origins() {
        let browser = sign_in_page("in");
        let api = vault(&[ACCOUNTS, SHOP]);
        assert_eq!(run(&sign_in_step(), &browser, &api), Outcome::Done(None));
        assert_eq!(*api.redeemed.lock().unwrap(), ["g-1"]);
        assert_eq!(browser.names()[..2], ["form", "type"]);
        let calls = browser.calls.lock().unwrap();
        let typed = &calls[1].1;
        // The script is told the sign-in's origins that are also the step's, and checks them itself before typing.
        assert_eq!(typed["o"], format!(r#"["{ACCOUNTS}","{SHOP}"]"#));
        assert_eq!((typed["u"].as_str(), typed["p"].as_str()), ("fon@baanmali", "Pa55-known"));
        // Nothing but the typing script ever had them.
        for (name, args) in calls.iter().filter(|(name, _)| *name != "type") {
            assert!(args.values().all(|v| !v.contains("Pa55-known") && !v.contains("fon@baanmali")), "{name}");
        }
    }

    #[test]
    fn types_nothing_where_the_sign_in_may_not_go() {
        // The vault's origins for the sign-in do not include the page the step is on.
        let browser = sign_in_page("in");
        assert_eq!(run(&sign_in_step(), &browser, &vault(&[SHOP])), Outcome::Failed(Failure::OriginNotAllowed));
        assert_eq!(browser.names(), ["form"]);
        // The page moved off the sign-in's origins while the grant was being redeemed: it is looked at again before
        // anything is typed.
        let moving = sign_in_page("in");
        let page = moving.page.clone();
        let api = Vault {
            redeem: Box::new(move || {
                *page.lock().unwrap() = Some(format!("{SHOP}/portal"));
                Ok(Redeemed { origins: vec![ACCOUNTS.into()], username: Zeroizing::new("u".into()), password: Zeroizing::new("p".into()) })
            }),
            redeemed: Mutex::new(Vec::new()),
        };
        assert_eq!(run(&sign_in_step(), &moving, &api), Outcome::Failed(Failure::OriginNotAllowed));
        assert_eq!(moving.names(), ["form"]);
        // The script itself found the page off the origins when it came to type.
        let away = FakeBrowser::at(Some(&format!("{ACCOUNTS}/seller/login")), Box::new(|name, _| match name {
            "form" => json_answer(serde_json::json!({ "f": true, "a": "x" })),
            "type" => json_answer(serde_json::json!({ "r": "origin" })),
            _ => unreachable!(),
        }));
        assert_eq!(run(&sign_in_step(), &away, &vault(&[ACCOUNTS])), Outcome::Failed(Failure::OriginNotAllowed));
    }

    #[test]
    fn redeems_nothing_for_a_page_with_no_form_or_off_the_origins() {
        let api = vault(&[ACCOUNTS]);
        let no_form = FakeBrowser::at(Some(&format!("{ACCOUNTS}/")), Box::new(|_, _| json_answer(serde_json::json!({ "f": false, "a": "x" }))));
        assert_eq!(run(&sign_in_step(), &no_form, &api), Outcome::Failed(Failure::SelectorNotFound));
        let off = FakeBrowser::at(Some("https://evil.example/login"), Box::new(|_, _| unreachable!()));
        assert_eq!(run(&sign_in_step(), &off, &api), Outcome::Failed(Failure::OriginNotAllowed));
        let none = FakeBrowser::at(None, Box::new(|_, _| unreachable!()));
        assert_eq!(run(&sign_in_step(), &none, &api), Outcome::Failed(Failure::PageUnavailable));
        assert!(api.redeemed.lock().unwrap().is_empty());
    }

    #[test]
    fn a_refused_redeem_is_a_refused_grant() {
        for error in [ApiError::Refused, ApiError::Offline, ApiError::Unavailable, ApiError::Unauthorized] {
            let browser = sign_in_page("in");
            let api = Vault { redeem: Box::new(move || Err(error)), redeemed: Mutex::new(Vec::new()) };
            assert_eq!(run(&sign_in_step(), &browser, &api), Outcome::Failed(Failure::GrantRefused), "{error:?}");
            assert_eq!(browser.names(), ["form"]);
        }
    }

    #[test]
    fn says_how_the_site_answered_the_sign_in_and_never_guesses_a_refusal() {
        let api = vault(&[ACCOUNTS]);
        assert_eq!(run(&sign_in_step(), &sign_in_page("refused"), &api), Outcome::Failed(Failure::SignInRefused));
        assert_eq!(run(&sign_in_step(), &sign_in_page("away"), &api), Outcome::Failed(Failure::OriginNotAllowed));
        // Still undecided when its time is up (a captcha, a site that keeps what was typed): timed out, not refused.
        assert_eq!(run(&sign_in_step(), &sign_in_page("pending"), &api), Outcome::Failed(Failure::TimedOut));
        // An answer is taken only once it has held: a page that flips between answers is not decided by one look.
        let flips = std::sync::atomic::AtomicUsize::new(0);
        let flipping = FakeBrowser::at(Some(&format!("{ACCOUNTS}/seller/login")), Box::new(move |name, _| match name {
            "form" => json_answer(serde_json::json!({ "f": true, "a": "x" })),
            "type" => json_answer(serde_json::json!({ "r": "typed" })),
            _ => json_answer(serde_json::json!({ "s": if flips.fetch_add(1, Ordering::SeqCst) % 2 == 0 { "refused" } else { "in" } })),
        }));
        assert_eq!(run(&sign_in_step(), &flipping, &api), Outcome::Failed(Failure::TimedOut));
    }

    #[test]
    fn a_step_the_outpost_stops_under_ends_as_a_browser_error() {
        let browser = sign_in_page("pending");
        let stop = AtomicBool::new(false);
        let result = std::thread::scope(|scope| {
            let handle = scope.spawn(|| {
                let slow = Pace { sign_in: Duration::from_secs(60), ..QUICK };
                run_step(&sign_in_step(), &browser, &vault(&[ACCOUNTS]), &stop, &slow)
            });
            std::thread::sleep(Duration::from_millis(30));
            stop.store(true, Ordering::SeqCst);
            handle.join().unwrap()
        });
        assert_eq!(result, Outcome::Failed(Failure::BrowserError));
    }

    #[test]
    fn a_kind_it_does_not_know_or_a_step_missing_what_its_kind_needs_is_not_run() {
        // Not run is a code the API reads as nothing submitted (`NOTHING_SUBMITTED` in apps/api/src/browser-writes.ts):
        // a write the outpost cannot run settles failed, not unknown.
        assert_eq!(Failure::NotRun.code(), "not_run");
        let browser = FakeBrowser::at(Some(&format!("{SHOP}/")), Box::new(|_, _| unreachable!()));
        let api = vault(&[]);
        for kind in ["upload", "", "SUBMIT", "submit "] {
            let mut odd = write();
            odd.kind = kind.into();
            assert_eq!(run(&odd, &browser, &api), Outcome::Failed(Failure::NotRun), "{kind:?}");
        }
        let mut open = step("open", &[SHOP]);
        open.url = None;
        assert_eq!(run(&open, &browser, &api), Outcome::Failed(Failure::NotRun));
        let mut sign_in = sign_in_step();
        sign_in.grant_id = None;
        assert_eq!(run(&sign_in, &browser, &api), Outcome::Failed(Failure::NotRun));
        for missing in ["url", "form", "values"] {
            let mut short = write();
            match missing {
                "url" => short.url = None,
                "form" => short.form = None,
                _ => short.values = None,
            }
            assert_eq!(run(&short, &browser, &api), Outcome::Failed(Failure::NotRun), "{missing}");
        }
        // Nothing was opened, read, typed or pressed for any of them, and nothing redeemed.
        assert!(browser.calls.lock().unwrap().is_empty());
        assert!(browser.opened.lock().unwrap().is_empty());
        assert!(api.redeemed.lock().unwrap().is_empty());
    }

    const PAGE: &str = "https://seller.shopee.co.th/portal/chat/2291";
    /// A value nothing but the page may ever be given, with what JSON must escape in it.
    const KNOWN: &str = "Known-ค่า \"quoted\"\nline two";

    /// A write step as the API hands one out: the approved page, its form, and two values in order.
    fn write() -> OutpostStep {
        OutpostStep {
            step_id: "s-9".into(),
            kind: "submit".into(),
            url: Some(PAGE.into()),
            form: Some("form#chat".into()),
            values: Some(vec![
                SubmitValue { field: "textarea[name=\"reply\"]".into(), value: Zeroizing::new(KNOWN.into()) },
                SubmitValue { field: "select#reason".into(), value: Zeroizing::new("damaged".into()) },
            ]),
            origins: vec![SHOP.into()],
            ..Default::default()
        }
    }

    /// The approved page, answering each script as a site would: the values go in, the press answers `presses` in order
    /// (the last one again after that), and then the site answers `after` (SENT's `s`).
    fn form_page(presses: Vec<&'static str>, after: &'static str) -> FakeBrowser {
        let presses = Mutex::new(presses);
        FakeBrowser::at(None, Box::new(move |name, _| match name {
            "set" => json_answer(json!({ "r": "set" })),
            "press" => {
                let mut left = presses.lock().unwrap();
                let r = if left.len() > 1 { left.remove(0) } else { left[0] };
                json_answer(if r == "pressed" { json!({ "r": r, "a": PAGE }) } else { json!({ "r": r }) })
            }
            "sent" => json_answer(json!({ "s": after })),
            _ => unreachable!("{name}"),
        }))
    }

    #[test]
    fn submits_the_approved_values_in_order_on_the_approved_page_once() {
        let browser = form_page(vec!["pressed"], "sent");
        assert_eq!(run(&write(), &browser, &vault(&[])), Outcome::Done(None));
        // The approved page, opened fresh, the guard kept on the step's origin.
        assert_eq!(*browser.opened.lock().unwrap(), [PAGE.to_string()]);
        assert!(browser.kept.lock().unwrap().iter().all(|kept| kept == &[SHOP.to_string()]));
        let names = browser.names();
        assert_eq!(names[..2], ["set", "press"]);
        assert!(names[2..].iter().all(|n| *n == "sent") && names.len() > 2);
        let calls = browser.calls.lock().unwrap();
        let set = &calls[0].1;
        assert_eq!(set["o"], format!(r#"["{SHOP}"]"#));
        assert_eq!(set["f"], "form#chat");
        // Every value, in order, exactly as approved.
        let pairs: Vec<(String, String)> = serde_json::from_str(&set["v"]).unwrap();
        assert_eq!(pairs, [("textarea[name=\"reply\"]".to_string(), KNOWN.to_string()), ("select#reason".into(), "damaged".into())]);
        // The site's answer is read against the address just before the press.
        assert_eq!(calls[2].1["a"], PAGE);
    }

    /// The approved page of a settings form: the values go in, the press is made, the site then answers `after` in turn
    /// (the last one again after that), and the page loaded again answers `saved`.
    fn settings_page(after: Vec<&'static str>, saved: &'static str) -> FakeBrowser {
        let after = Mutex::new(after);
        FakeBrowser::at(None, Box::new(move |name, _| match name {
            "set" => json_answer(json!({ "r": "set" })),
            "press" => json_answer(json!({ "r": "pressed", "a": PAGE })),
            "sent" => {
                let mut left = after.lock().unwrap();
                let answer = if left.len() > 1 { left.remove(0) } else { left[0] };
                json_answer(json!({ "s": answer }))
            }
            "saved" => json_answer(json!({ "s": saved })),
            _ => unreachable!("{name}"),
        }))
    }

    /// What loading the page again does the second time it is loaded; the first load is the approved page, as it was.
    fn reopen(browser: &mut FakeBrowser, again: (Option<&'static str>, Blocked, Result<(), Failure>)) {
        let loads = AtomicUsize::new(0);
        browser.on_open = Box::new(move |url| match loads.fetch_add(1, Ordering::SeqCst) {
            0 => (Some(url.to_owned()), Blocked::Nothing, Ok(())),
            _ => (again.0.map(str::to_owned), again.1, again.2),
        });
    }

    #[test]
    fn a_settings_page_that_keeps_its_form_is_loaded_again_and_read_back() {
        let api = vault(&[]);
        // Kept as typed with nothing said: the page is loaded anew, after an empty page (never reloaded, which would send
        // the form again), and what the site keeps is read back. Pressed once, all the same.
        let browser = settings_page(vec!["kept"], "saved");
        assert_eq!(run(&write(), &browser, &api), Outcome::Done(None));
        assert_eq!(*browser.opened.lock().unwrap(), [PAGE.to_string(), "about:blank".into(), PAGE.into()]);
        let names = browser.names();
        assert_eq!(names.iter().filter(|n| **n == "press").count(), 1);
        assert_eq!(names.iter().filter(|n| **n == "set").count(), 1);
        assert!(names.contains(&"saved"));
        // The read-back is told the step's origins and the values, as arguments only.
        let calls = browser.calls.lock().unwrap();
        let (_, args) = calls.iter().find(|(name, _)| *name == "saved").unwrap();
        assert_eq!(args["o"], format!(r#"["{SHOP}"]"#));
        assert!(args["v"].contains("Known-ค่า"));
        assert!(!script(SAVED).contains("Known"));
        drop(calls);
        // What it reads back is not what was approved (a page that did not keep the change, or one still drawing its
        // form), or proves nothing (every value one an empty form shows too): not known, never failed, since the form was
        // pressed.
        for answer in ["other", "blank", "pending"] {
            assert_eq!(run(&write(), &settings_page(vec!["kept"], answer), &api), Outcome::Failed(Failure::TimedOut), "{answer}");
        }
        assert_eq!(run(&write(), &settings_page(vec!["kept"], "away"), &api), Outcome::Failed(Failure::OriginNotAllowed));
        // A page that will not load again is not known either, never `page_unavailable`, which says nothing was sent.
        let mut gone = settings_page(vec!["kept"], "saved");
        reopen(&mut gone, (None, Blocked::Nothing, Err(Failure::PageUnavailable)));
        assert_eq!(run(&write(), &gone, &api), Outcome::Failed(Failure::BrowserError));
        // A frame from elsewhere the guard refused as it loaded again: not known.
        let mut framed = settings_page(vec!["kept"], "saved");
        reopen(&mut framed, (Some(PAGE), Blocked::Frame, Ok(())));
        assert_eq!(run(&write(), &framed, &api), Outcome::Failed(Failure::OriginNotAllowed));
        // A site that answers before it has kept the form long enough (a box emptied a moment later) is taken at its
        // answer, with no second load; so is one that kept the form with a field marked wrong.
        let slow = Pace { kept: Duration::from_secs(5), ..PATIENT };
        let answering = settings_page(vec!["kept", "kept", "sent"], "saved");
        assert_eq!(run_step(&write(), &answering, &api, &AtomicBool::new(false), &slow), Outcome::Done(None));
        assert_eq!(*answering.opened.lock().unwrap(), [PAGE.to_string()]);
        let refusing = settings_page(vec!["kept", "refused"], "saved");
        assert_eq!(run_step(&write(), &refusing, &api, &AtomicBool::new(false), &slow), Outcome::Failed(Failure::SubmitRefused));
        assert_eq!(*refusing.opened.lock().unwrap(), [PAGE.to_string()]);
        // Every code a write can end with once pressed is one the API reads as not known, or done.
        for failure in [Failure::PageUnavailable, Failure::SelectorNotFound, Failure::SubmitRefused, Failure::NotRun, Failure::NavigationRefused] {
            assert_eq!(after_press(failure), Failure::BrowserError, "{failure:?}");
        }
        for failure in [Failure::TimedOut, Failure::BrowserError, Failure::OriginNotAllowed] {
            assert_eq!(after_press(failure), failure);
        }
    }

    #[test]
    fn says_how_the_site_answered_a_write_and_never_guesses() {
        let api = vault(&[]);
        assert_eq!(run(&write(), &form_page(vec!["pressed"], "refused"), &api), Outcome::Failed(Failure::SubmitRefused));
        assert_eq!(run(&write(), &form_page(vec!["pressed"], "away"), &api), Outcome::Failed(Failure::OriginNotAllowed));
        // Still undecided at the end of its time (a site that keeps the form and says nothing): not known, never a refusal.
        assert_eq!(run(&write(), &form_page(vec!["pressed"], "pending"), &api), Outcome::Failed(Failure::TimedOut));
        // An answer is taken only once it has held.
        let flips = AtomicUsize::new(0);
        let flipping = FakeBrowser::at(None, Box::new(move |name, _| match name {
            "set" => json_answer(json!({ "r": "set" })),
            "press" => json_answer(json!({ "r": "pressed", "a": PAGE })),
            _ => json_answer(json!({ "s": if flips.fetch_add(1, Ordering::SeqCst) % 2 == 0 { "refused" } else { "sent" } })),
        }));
        assert_eq!(run(&write(), &flipping, &api), Outcome::Failed(Failure::TimedOut));
    }

    #[test]
    fn checks_the_form_and_every_field_before_typing_anything() {
        for answer in ["form", "field", "moved"] {
            let browser = FakeBrowser::at(None, Box::new(move |name, _| match name {
                "set" => json_answer(json!({ "r": answer })),
                _ => unreachable!("nothing is pressed"),
            }));
            assert_eq!(run(&write(), &browser, &vault(&[])), Outcome::Failed(Failure::SelectorNotFound), "{answer}");
            // A form or a field not there is looked for again for a while; one that went while typing is not.
            let names = browser.names();
            assert!(names.iter().all(|n| *n == "set"), "{answer}");
            if answer == "moved" {
                assert_eq!(names.len(), 1);
            }
        }
        // The script checks the form and every field before it sets its first value, and answers only in fixed words.
        let first_set = SET.find("put(el, kind, value)").unwrap();
        for check in ["return JSON.stringify({ r: \"form\" })", "return JSON.stringify({ r: \"field\" })"] {
            assert!(SET.find(check).unwrap() < first_set, "{check}");
        }
        for answer in SET.match_indices("return ").map(|(at, _)| &SET[at..]) {
            assert!(["origin", "form", "field", "moved", "set"].iter().any(|r| answer.starts_with(&format!("return JSON.stringify({{ r: \"{r}\" }})"))),
                "{answer}");
        }
    }

    #[test]
    fn presses_once_waiting_for_the_page_to_turn_its_button_on() {
        let browser = form_page(vec!["wait", "wait", "pressed"], "sent");
        assert_eq!(run_step(&write(), &browser, &vault(&[]), &AtomicBool::new(false), &PATIENT), Outcome::Done(None));
        assert_eq!(browser.names().iter().filter(|n| **n == "press").count(), 3);
        // A button never turned on: the site would not take what was typed, and nothing was pressed.
        let never = form_page(vec!["wait"], "sent");
        assert_eq!(run(&write(), &never, &vault(&[])), Outcome::Failed(Failure::SubmitRefused));
        assert!(!never.names().contains(&"sent"));
        // A field that does not read back as approved, or that the page marks as wrong, for the whole of the wait: nothing
        // is pressed, however often it is looked at.
        for answer in ["changed", "flagged"] {
            let browser = form_page(vec![answer], "sent");
            assert_eq!(run(&write(), &browser, &vault(&[])), Outcome::Failed(Failure::SubmitRefused), "{answer}");
            let names = browser.names();
            assert_eq!(names[0], "set");
            assert!(names[1..].iter().all(|n| *n == "press"), "{answer} {names:?}");
        }
        // One that comes right a moment later (an editor taking in its text, a check the page runs again) is pressed then,
        // once.
        for answer in ["changed", "flagged"] {
            let browser = form_page(vec![answer, answer, "pressed"], "sent");
            assert_eq!(run_step(&write(), &browser, &vault(&[]), &AtomicBool::new(false), &PATIENT), Outcome::Done(None), "{answer}");
            assert_eq!(browser.names().iter().filter(|n| **n == "press").count(), 3);
        }
        assert_eq!(run(&write(), &form_page(vec!["gone"], "sent"), &vault(&[])), Outcome::Failed(Failure::SelectorNotFound));
    }

    #[test]
    fn waits_for_a_form_the_page_draws_after_it_loads_and_types_nothing_until_it_is_whole() {
        // The page draws its form with its own script: the first looks find no form, then not every field.
        let looks = AtomicUsize::new(0);
        let browser = FakeBrowser::at(None, Box::new(move |name, _| match name {
            "set" => {
                let seen = ["form", "field", "set"][looks.fetch_add(1, Ordering::SeqCst).min(2)];
                json_answer(json!({ "r": seen }))
            }
            "press" => json_answer(json!({ "r": "pressed", "a": PAGE })),
            "sent" => json_answer(json!({ "s": "sent" })),
            _ => unreachable!("{name}"),
        }));
        assert_eq!(run_step(&write(), &browser, &vault(&[]), &AtomicBool::new(false), &PATIENT), Outcome::Done(None));
        assert_eq!(browser.names()[..4], ["set", "set", "set", "press"]);
        // A frame from elsewhere refused while it waits: nothing was typed, and it stops there.
        let refusing = FakeBrowser::refusing(None, |blocked| Box::new(move |name, _| {
            refuse(&blocked, Blocked::Frame);
            match name {
                "set" => json_answer(json!({ "r": "field" })),
                _ => unreachable!("{name}"),
            }
        }));
        assert_eq!(run(&write(), &refusing, &vault(&[])), Outcome::Failed(Failure::NavigationRefused));
        assert_eq!(refusing.names(), ["set"]);
    }

    #[test]
    fn never_presses_twice_when_a_press_got_no_answer() {
        // The press may have been made: it is never made again, and the step ends as not known.
        let browser = FakeBrowser::at(None, Box::new(|name, _| match name {
            "set" => json_answer(json!({ "r": "set" })),
            "press" => Err(Failure::BrowserError),
            _ => unreachable!(),
        }));
        assert_eq!(run(&write(), &browser, &vault(&[])), Outcome::Failed(Failure::BrowserError));
        assert_eq!(browser.names(), ["set", "press"]);
    }

    /// The approved page, answering as `form_page` does, where the guard refuses `what` while the script `during` runs
    /// (its `nth` run, counting from 0).
    fn refusing_page(during: &'static str, nth: usize, what: Blocked, presses: Vec<&'static str>) -> FakeBrowser {
        let presses = Mutex::new(presses);
        let runs = AtomicUsize::new(0);
        FakeBrowser::refusing(None, move |blocked| Box::new(move |name, _| {
            if name == during && runs.fetch_add(1, Ordering::SeqCst) == nth {
                refuse(&blocked, what);
            }
            match name {
                "set" => json_answer(json!({ "r": "set" })),
                "press" => {
                    let mut left = presses.lock().unwrap();
                    let r = if left.len() > 1 { left.remove(0) } else { left[0] };
                    json_answer(if r == "pressed" { json!({ "r": r, "a": PAGE }) } else { json!({ "r": r }) })
                }
                "sent" => json_answer(json!({ "s": "sent" })),
                _ => unreachable!("{name}"),
            }
        }))
    }

    #[test]
    fn a_frame_from_elsewhere_before_the_press_stops_a_write_with_nothing_sent() {
        let api = vault(&[]);
        for what in [Blocked::Frame, Blocked::Page] {
            // Refused while the values went in: nothing is pressed.
            let typing = refusing_page("set", 0, what, vec!["pressed"]);
            assert_eq!(run(&write(), &typing, &api), Outcome::Failed(Failure::NavigationRefused), "{what:?}");
            assert_eq!(typing.names(), ["set"]);
            // Refused while the page had not yet turned its button on: the next look presses nothing.
            let waiting = refusing_page("press", 0, what, vec!["wait", "pressed"]);
            assert_eq!(run(&write(), &waiting, &api), Outcome::Failed(Failure::NavigationRefused), "{what:?}");
            assert_eq!(waiting.names(), ["set", "press"]);
            // A press the page would not take, with a refusal on the way: still nothing sent, and the refusal is the
            // reason given.
            let kept = refusing_page("press", 0, what, vec!["changed"]);
            assert_eq!(run(&write(), &kept, &api), Outcome::Failed(Failure::NavigationRefused), "{what:?}");
        }
        // The API reads the code as nothing submitted (`NOTHING_SUBMITTED` in apps/api/src/browser-writes.ts).
        assert_eq!(Failure::NavigationRefused.code(), "navigation_refused");
    }

    #[test]
    fn a_frame_from_elsewhere_after_the_press_leaves_the_write_not_known() {
        let api = vault(&[]);
        for what in [Blocked::Frame, Blocked::Page] {
            // Refused as the press was made: whatever the page goes on to show, the site may have needed what was refused.
            let pressing = refusing_page("press", 0, what, vec!["pressed"]);
            assert_eq!(run(&write(), &pressing, &api), Outcome::Failed(Failure::OriginNotAllowed), "{what:?}");
            assert_eq!(pressing.names(), ["set", "press"], "the wait ends at once");
            // Refused while the site's answer was read.
            let answering = refusing_page("sent", 0, what, vec!["pressed"]);
            assert_eq!(run(&write(), &answering, &api), Outcome::Failed(Failure::OriginNotAllowed), "{what:?}");
            // Refused after a press the page took, as its answer held (an answer is read at least twice, so its second
            // reading is always made): not known, never done.
            let late = refusing_page("sent", 1, what, vec!["pressed"]);
            assert_eq!(run(&write(), &late, &api), Outcome::Failed(Failure::OriginNotAllowed), "{what:?}");
        }
    }

    #[test]
    fn types_nothing_off_the_approved_page() {
        let api = vault(&[]);
        // An address off the step's origin is never opened.
        let browser = form_page(vec!["pressed"], "sent");
        let mut away = write();
        away.url = Some("https://evil.example/portal/chat/2291".into());
        assert_eq!(run(&away, &browser, &api), Outcome::Failed(Failure::OriginNotAllowed));
        assert!(browser.opened.lock().unwrap().is_empty() && browser.calls.lock().unwrap().is_empty());
        // The site sent the page elsewhere on the way, or a frame of it went for another site: the guard refused it, and
        // nothing is typed, so nothing was submitted (before, the page's case was not known). A page that did not load
        // because of it says the same.
        for (blocked, opened) in [(Blocked::Page, Ok(())), (Blocked::Frame, Ok(())), (Blocked::Page, Err(Failure::PageUnavailable)),
            (Blocked::Frame, Err(Failure::TimedOut))] {
            let mut redirected = form_page(vec!["pressed"], "sent");
            redirected.on_open = Box::new(move |url| (Some(url.to_owned()), blocked, opened));
            assert_eq!(run(&write(), &redirected, &api), Outcome::Failed(Failure::NavigationRefused), "{blocked:?} {opened:?}");
            assert!(redirected.calls.lock().unwrap().is_empty());
        }
        // The script found the page off the origin when it came to type.
        let moved = FakeBrowser::at(None, Box::new(|name, _| match name {
            "set" => json_answer(json!({ "r": "origin" })),
            _ => unreachable!(),
        }));
        assert_eq!(run(&write(), &moved, &api), Outcome::Failed(Failure::OriginNotAllowed));
    }

    #[test]
    fn a_write_whose_page_does_not_load_submitted_nothing() {
        let api = vault(&[]);
        for failure in [Failure::PageUnavailable, Failure::TimedOut, Failure::BrowserError] {
            let mut browser = form_page(vec!["pressed"], "sent");
            browser.on_open = Box::new(move |_| (None, Blocked::Nothing, Err(failure)));
            assert_eq!(run(&write(), &browser, &api), Outcome::Failed(Failure::PageUnavailable), "{failure:?}");
            assert!(browser.calls.lock().unwrap().is_empty());
        }
        // The outpost stopping before anything was typed: not run.
        let mut stopped = form_page(vec!["pressed"], "sent");
        stopped.on_open = Box::new(|_| (None, Blocked::Nothing, Err(Failure::BrowserError)));
        assert_eq!(run_step(&write(), &stopped, &vault(&[]), &AtomicBool::new(true), &QUICK), Outcome::Failed(Failure::NotRun));
        assert!(stopped.calls.lock().unwrap().is_empty());
        // Or once the page is open, before the values go in.
        let loaded = form_page(vec!["pressed"], "sent");
        assert_eq!(run_step(&write(), &loaded, &vault(&[]), &AtomicBool::new(true), &QUICK), Outcome::Failed(Failure::NotRun));
        assert!(loaded.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn a_value_goes_to_the_page_and_nowhere_else() {
        let browser = form_page(vec!["pressed"], "sent");
        let step = write();
        assert_eq!(run(&step, &browser, &vault(&[])), Outcome::Done(None));
        // Only the scripts that type and check it were handed it, as an argument, never inside a script's own text.
        for (name, args) in browser.calls.lock().unwrap().iter() {
            let holds = args.values().any(|v| v.contains("Known-ค่า"));
            assert_eq!(holds, ["set", "press", "sent"].contains(name), "{name}");
        }
        for body in [SET, PRESS, SENT] {
            assert!(!script(body).contains("Known"));
        }
        // A step never prints it.
        let printed = format!("{step:?} {step:#?}");
        assert!(!printed.contains("Known") && printed.contains("textarea"), "{printed}");
    }

    #[test]
    fn writes_the_values_as_json_in_order_with_nothing_lost() {
        let values = write().values.unwrap();
        let json = values_json(&values).unwrap();
        let back: Vec<(String, String)> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].1, KNOWN);
        assert_eq!(values_json(&[]).unwrap().as_str(), "[]");
        // Every character JSON escapes, at the most it takes: the buffer was sized for it.
        let odd = vec![SubmitValue { field: "\u{1}".repeat(50), value: Zeroizing::new("\u{1f}\"\\".repeat(40)) }];
        let back: Vec<(String, String)> = serde_json::from_str(&values_json(&odd).unwrap()).unwrap();
        assert_eq!(back, [("\u{1}".repeat(50), "\u{1f}\"\\".repeat(40))]);
    }

    #[test]
    fn cuts_a_read_to_the_apis_limit_at_a_characters_edge() {
        for text in ["", "short", &"a".repeat(MAX_READ_TEXT_BYTES * 2), &"é".repeat(5000), &"\"".repeat(3000),
            &"\u{1}".repeat(1000), &"🔑".repeat(2000), &format!("{}🔑", "a".repeat(4092))] {
            let cut = cut(text);
            let json = serde_json::to_string(&cut).unwrap();
            assert!(json.len() <= MAX_READ_TEXT_BYTES, "{}", json.len());
            assert!(text.starts_with(&cut));
            // As much as fits: one more character would not.
            if cut.len() < text.len() {
                let next = text[cut.len()..].chars().next().unwrap();
                assert!(serde_json::to_string(&format!("{cut}{next}")).unwrap().len() > MAX_READ_TEXT_BYTES);
            }
        }
        assert_eq!(cut("Shipped"), "Shipped");
    }

    #[test]
    fn the_scripts_check_the_origin_first_and_type_through_arguments_only() {
        for (body, names) in [(READ, &["o", "s", "m"][..]), (FORM, &["o"][..]), (TYPE, &["o", "u", "p"][..]), (CHECK, &["o", "a"][..]),
            (SET, &["o", "f", "v"][..]), (PRESS, &["o", "f", "v"][..]), (SENT, &["o", "a", "f", "v"][..]), (SAVED, &["o", "v"][..])] {
            let script = script(body);
            assert!(script.starts_with("const origins = JSON.parse(o);\nif (!origins.includes(location.origin)) return"), "{script}");
            assert!(!script.contains("VISIBLE") && !script.contains("FIELDS") && !script.contains("FIND"));
            for name in names {
                assert!(script.contains(name));
            }
        }
        // None of the three shared parts holds another's name, so the order `script` writes them in changes nothing.
        for (part, others) in [(VISIBLE, ["FIND", "FIELDS"]), (FIND, ["VISIBLE", "FIELDS"]), (FIELDS, ["VISIBLE", "FIND"])] {
            assert!(others.iter().all(|other| !part.contains(other)));
        }
        // The typing script answers only how it went, in fixed words, never a field's value. (Its own text, before
        // `VISIBLE` is written in, whose two returns are a yes or a no about a field.)
        let answers: Vec<&str> = TYPE.match_indices("return ").map(|(at, _)| &TYPE[at..]).collect();
        assert_eq!(answers.len(), 3);
        for answer in answers {
            assert!(["return JSON.stringify({ r: \"origin\" })", "return JSON.stringify({ r: \"form\" })",
                "return JSON.stringify({ r: \"typed\" })"].iter().any(|fixed| answer.starts_with(fixed)), "{answer}");
        }
    }
}
