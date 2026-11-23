//! One browser step, run in the outpost's browser (docs/browser-control.md, "The step channel"). Reading only: `open`
//! goes to a page, `read` reads the text of the page that is open (or of the part a selector names), and `sign_in`
//! redeems a grant and types the sign-in into the page that is open, then submits that form, since signing in is how
//! reading a shop's own site starts. Any other kind is failed: a step that submits anything else waits for
//! approval-core (the next slice).
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

use super::api::{Failure, OutpostApi, OutpostStep, Outcome, Redeemed, MAX_READ_TEXT_BYTES};
use super::origin;
use serde::Deserialize;
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
        self.stop.load(Ordering::SeqCst) || Instant::now() >= self.deadline
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
    /// The address of the page that is open, or None when no page is.
    fn address(&self) -> Option<String>;
    /// Whether the page is still loading.
    fn loading(&self) -> bool;
    /// Keeps the guard on `origins` from now on.
    fn keep_on(&self, origins: &[String]);
    /// Runs `body` as an async function in the page's main frame, in a world of the outpost's own, with `args` as its
    /// string arguments, and answers the string it returned. The arguments are wiped once the page has them.
    fn call(&self, body: &'static str, args: Vec<(&'static str, Zeroizing<String>)>, until: &Until) -> Result<String, Failure>;
    /// Whether the guard refused a navigation since this was last asked.
    fn take_blocked(&self) -> bool;
}

/// How long each kind may take, and how often a wait looks again. Every budget is well inside a step's two minutes,
/// and a sign-in's inside its grant's minute.
pub struct Pace {
    pub open: Duration,
    pub read: Duration,
    pub sign_in: Duration,
    /// How often a wait looks at the page again.
    pub poll: Duration,
    /// How long the site's answer to a sign-in must stay the same before it is taken as its answer.
    pub settled: Duration,
}

pub const PACE: Pace = Pace {
    open: Duration::from_secs(30),
    read: Duration::from_secs(15),
    sign_in: Duration::from_secs(40),
    poll: Duration::from_millis(400),
    settled: Duration::from_secs(3),
};

/// Whether something can be seen: an input a person could type into, or a button they could press.
const VISIBLE: &str = r#"const visible = (el) => {
  if (!el || el.disabled || el.type === "hidden" || el.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
};"#;

/// `read`: the text of the page (`s` empty) or of the first element selector `s` names, at most `m` UTF-16 units,
/// with any half of a surrogate pair made whole, so the answer is always valid JSON. `{ t }`, or `{ e: "origin" }` for
/// a page off the origins `o`, or `{ e: "selector" }` for a selector that names nothing or is not one.
pub const READ: &str = r#"const origins = JSON.parse(o);
if (!origins.includes(location.origin)) return JSON.stringify({ e: "origin" });
let node = document.body ?? document.documentElement;
if (s !== "") {
  try { node = document.querySelector(s); } catch (_) { return JSON.stringify({ e: "selector" }); }
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

/// The scripts as they are run: `VISIBLE` written into each one that uses it.
pub fn script(body: &'static str) -> String {
    body.replace("VISIBLE", VISIBLE)
}

/// Runs one step and answers how it went. A navigation the guard refused while it ran fails it whatever else
/// happened (`origin_not_allowed`): the page went, or tried to go, off the step's origins.
pub fn run_step(step: &OutpostStep, browser: &dyn Browser, api: &dyn OutpostApi, stop: &AtomicBool, pace: &Pace) -> Outcome {
    let origins = origin::clean(&step.origins);
    if origins.is_empty() {
        return Outcome::Failed(Failure::OriginNotAllowed);
    }
    // What the guard refused before this step began (between steps, say) is not this step's.
    browser.take_blocked();
    let now = Instant::now();
    let result = match step.kind.as_str() {
        "open" => open(step, &origins, browser, &Until { deadline: now + pace.open, stop }),
        "read" => read(step, &origins, browser, &Until { deadline: now + pace.read, stop }, pace),
        "sign_in" => sign_in(step, &origins, browser, api, &Until { deadline: now + pace.sign_in, stop }, pace),
        _ => Err(Failure::BrowserError),
    };
    if browser.take_blocked() {
        return Outcome::Failed(Failure::OriginNotAllowed);
    }
    match result {
        Ok(text) => Outcome::Done(text),
        Err(failure) => Outcome::Failed(failure),
    }
}

fn open(step: &OutpostStep, origins: &[String], browser: &dyn Browser, until: &Until) -> Result<Option<String>, Failure> {
    let url = step.url.as_deref().ok_or(Failure::BrowserError)?;
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
    let grant = step.grant_id.as_deref().ok_or(Failure::BrowserError)?;
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
        /// What `open` does: the address it leaves the page at, whether the guard refused something on the way, and
        /// what it answers.
        pub on_open: Box<dyn Fn(&str) -> (Option<String>, bool, Result<(), Failure>) + Send + Sync>,
        pub blocked: AtomicBool,
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
        } else {
            "other"
        }
    }

    impl FakeBrowser {
        pub fn at(page: Option<&str>, answer: Answer) -> Self {
            FakeBrowser {
                page: Arc::new(Mutex::new(page.map(str::to_owned))),
                answer,
                on_open: Box::new(|url| (Some(url.to_owned()), false, Ok(()))),
                blocked: AtomicBool::new(false),
                opened: Mutex::new(Vec::new()),
                kept: Mutex::new(Vec::new()),
                calls: Mutex::new(Vec::new()),
            }
        }

        pub fn names(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().iter().map(|(n, _)| *n).collect()
        }
    }

    impl Browser for FakeBrowser {
        fn open(&self, url: &str, origins: &[String], _until: &Until) -> Result<(), Failure> {
            self.opened.lock().unwrap().push(url.to_owned());
            self.kept.lock().unwrap().push(origins.to_vec());
            let (page, blocked, answer) = (self.on_open)(url);
            *self.page.lock().unwrap() = page;
            if blocked {
                self.blocked.store(true, Ordering::SeqCst);
            }
            answer
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
        fn take_blocked(&self) -> bool {
            self.blocked.swap(false, Ordering::SeqCst)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeBrowser;
    use super::*;
    use crate::outpost::api::ApiError;
    use std::sync::Mutex;

    const SHOP: &str = "https://seller.shopee.co.th";
    const ACCOUNTS: &str = "https://accounts.shopee.co.th";

    const QUICK: Pace = Pace {
        open: Duration::from_millis(500),
        read: Duration::from_millis(500),
        sign_in: Duration::from_millis(500),
        poll: Duration::from_millis(1),
        settled: Duration::from_millis(5),
    };

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
        OutpostStep { step_id: "s-1".into(), kind: kind.into(), url: None, selector: None, grant_id: None,
            origins: origins.iter().map(|o| o.to_string()).collect() }
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
        // A step with no origin the outpost can read opens nothing either.
        let mut none = step("open", &["https://Seller.shopee.co.th", "*"]);
        none.url = Some(format!("{SHOP}/"));
        assert_eq!(run(&none, &browser, &vault(&[])), Outcome::Failed(Failure::OriginNotAllowed));
        assert_eq!(browser.opened.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_page_that_goes_off_the_origins_on_the_way_fails_the_step() {
        let mut browser = FakeBrowser::at(None, Box::new(|_, _| unreachable!()));
        // The site redirected elsewhere: the guard refused it, and the page stayed where it was.
        browser.on_open = Box::new(|_| (None, true, Err(Failure::PageUnavailable)));
        let mut open = step("open", &[SHOP]);
        open.url = Some(format!("{SHOP}/"));
        assert_eq!(run(&open, &browser, &vault(&[])), Outcome::Failed(Failure::OriginNotAllowed));
        // A load that simply failed says so.
        browser.on_open = Box::new(|_| (None, false, Err(Failure::PageUnavailable)));
        assert_eq!(run(&open, &browser, &vault(&[])), Outcome::Failed(Failure::PageUnavailable));
        // Something refused between steps is not the next step's.
        browser.on_open = Box::new(|url| (Some(url.into()), false, Ok(())));
        browser.blocked.store(true, Ordering::SeqCst);
        assert_eq!(run(&open, &browser, &vault(&[])), Outcome::Done(None));
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
    fn a_kind_it_does_not_know_is_not_run() {
        let browser = FakeBrowser::at(Some(&format!("{SHOP}/")), Box::new(|_, _| unreachable!()));
        assert_eq!(run(&step("submit", &[SHOP]), &browser, &vault(&[])), Outcome::Failed(Failure::BrowserError));
        assert!(browser.calls.lock().unwrap().is_empty());
        let mut open = step("open", &[SHOP]);
        open.url = None;
        assert_eq!(run(&open, &browser, &vault(&[])), Outcome::Failed(Failure::BrowserError));
        let mut sign_in = sign_in_step();
        sign_in.grant_id = None;
        assert_eq!(run(&sign_in, &browser, &vault(&[])), Outcome::Failed(Failure::BrowserError));
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
        for (body, names) in [(READ, &["o", "s", "m"][..]), (FORM, &["o"][..]), (TYPE, &["o", "u", "p"][..]), (CHECK, &["o", "a"][..])] {
            let script = script(body);
            assert!(script.starts_with("const origins = JSON.parse(o);\nif (!origins.includes(location.origin)) return"), "{script}");
            assert!(!script.contains("VISIBLE"));
            for name in names {
                assert!(script.contains(name));
            }
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
