//! The outpost's side of the step channel (docs/pilot-api.md, "Vault sign-ins and outposts"): its heartbeat, asking
//! for its steps, redeeming a grant and reporting how a step went. Every call goes from here, with the outpost's own
//! credential, through the shell's curl (api_link.rs); none of it passes through the page.
//!
//! The redeem is the one answer that holds a password. It is read into a buffer that is wiped when dropped
//! (`api_link::request_sealed`), and the username and password are taken out of it straight into buffers of their
//! own that are wiped too, never through a copy that is not: serde reads them as raw JSON borrowed from the answer,
//! and `unescape` writes each one once, into a buffer sized for it.
//!
//! A write step's values are not secrets, but they go nowhere but the page either: the steps' answer is read the same
//! way, each value is written once into a buffer that is wiped when the step is dropped, and no step prints them.

use crate::api_link::{self, LinkError};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::json;
use std::fmt;
use zeroize::Zeroizing;

/// The most a read's text may be, once written as JSON in UTF-8 (the API's `MAX_READ_TEXT_BYTES`).
pub const MAX_READ_TEXT_BYTES: usize = 4096;

/// A browser step as its outpost is handed it (`OutpostStep`). Its Debug leaves a write's values out.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct OutpostStep {
    pub step_id: String,
    /// `open`, `read`, `sign_in` or `submit`; any other is not run (`not_run`).
    pub kind: String,
    /// `open`: the page; `submit`: the approved write's page.
    pub url: Option<String>,
    pub selector: Option<String>,
    pub grant_id: Option<String>,
    /// `submit`: the form it submits, or the control (a button) it presses, as a selector.
    pub form: Option<String>,
    /// `submit`: each field and exactly what goes in it, in order: the approved copy's, as the API handed it out. None
    /// when the step carries none, or none that reads as a list of fields and text.
    pub values: Option<Vec<SubmitValue>>,
    /// The origins its browser may be on for this step; anywhere else stops it.
    pub origins: Vec<String>,
}

impl fmt::Debug for OutpostStep {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OutpostStep")
            .field("step_id", &self.step_id)
            .field("kind", &self.kind)
            .field("url", &self.url)
            .field("selector", &self.selector)
            .field("grant_id", &self.grant_id)
            .field("form", &self.form)
            .field("values", &self.values)
            .field("origins", &self.origins)
            .finish()
    }
}

/// One value a write step types or chooses: the field it goes into, as a selector, and exactly what goes there. The
/// value is wiped when dropped, and never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct SubmitValue {
    pub field: String,
    pub value: Zeroizing<String>,
}

impl fmt::Debug for SubmitValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SubmitValue").field("field", &self.field).finish_non_exhaustive()
    }
}

/// Why a step failed, from the API's fixed list (`STEP_FAILURES`): never free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    OriginNotAllowed,
    PageUnavailable,
    SelectorNotFound,
    SignInRefused,
    GrantRefused,
    /// A write step's site refused what was submitted and kept the form, or would not let it be submitted as typed.
    SubmitRefused,
    /// The outpost did not do what the step asks: a kind it does not know, a step missing what its kind needs, or a
    /// stop before the step began or, for a write, before anything was typed. The API reads it as nothing submitted.
    NotRun,
    /// A write step, before it pressed anything: the guard refused a navigation of the page or of one of its frames
    /// to somewhere off the step's origins, and the outpost stopped there. The API reads it as nothing submitted.
    NavigationRefused,
    /// A sign-in step: the site asked for something the saved sign-in cannot give (a check that you are a person, a
    /// code sent to a phone, "verify it's you", a page the outpost does not know between the account's name and the
    /// password), and the outpost stopped there. The sign-in is not broken: it was never refused.
    SignInInterrupted,
    TimedOut,
    BrowserError,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Failure::OriginNotAllowed => "origin_not_allowed",
            Failure::PageUnavailable => "page_unavailable",
            Failure::SelectorNotFound => "selector_not_found",
            Failure::SignInRefused => "sign_in_refused",
            Failure::GrantRefused => "grant_refused",
            Failure::SubmitRefused => "submit_refused",
            Failure::NotRun => "not_run",
            Failure::NavigationRefused => "navigation_refused",
            Failure::SignInInterrupted => "sign_in_interrupted",
            Failure::TimedOut => "timed_out",
            Failure::BrowserError => "browser_error",
        }
    }
}

/// How a step went: done (with what it read, for a read), or failed with a code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Done(Option<String>),
    Failed(Failure),
}

/// A redeemed grant: where the sign-in may be typed, and what. The username and password are wiped when this is
/// dropped, and never printed.
pub struct Redeemed {
    pub origins: Vec<String>,
    pub username: Zeroizing<String>,
    pub password: Zeroizing<String>,
}

impl fmt::Debug for Redeemed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Redeemed").field("origins", &self.origins).finish_non_exhaustive()
    }
}

/// Why a call to the API did not do what it asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiError {
    /// No answer: the API could not be reached, or did not answer in time.
    Offline,
    /// 401: the credential is not (or no longer) this outpost's: it was removed, or given a new credential.
    Unauthorized,
    /// 429: over the outposts' ingress limit for this address.
    RateLimited,
    /// Any other 4xx: the API will not do it, and asking again will not change that.
    Refused,
    /// A 5xx, or an answer this outpost cannot read.
    Unavailable,
}

/// What the outpost asks of the API. The loop and the steps talk to this, so tests can stand a fake in for it.
pub trait OutpostApi: Send + Sync {
    fn heartbeat(&self) -> Result<(), ApiError>;
    fn steps(&self) -> Result<Vec<OutpostStep>, ApiError>;
    fn redeem(&self, grant_id: &str) -> Result<Redeemed, ApiError>;
    fn report(&self, step_id: &str, outcome: &Outcome) -> Result<(), ApiError>;
}

/// The API at `origin`, as the outpost `outpost_id` of `tenant`, with its credential.
pub struct HttpApi {
    origin: String,
    tenant: String,
    outpost_id: String,
    credential: Zeroizing<String>,
}

impl HttpApi {
    pub fn new(origin: &str, tenant: &str, outpost_id: &str, credential: &str) -> Self {
        HttpApi {
            origin: origin.to_owned(),
            tenant: tenant.to_owned(),
            outpost_id: outpost_id.to_owned(),
            credential: Zeroizing::new(credential.to_owned()),
        }
    }

    fn post(&self, path: &str, body: serde_json::Value) -> Result<String, ApiError> {
        match api_link::request(&format!("{}{path}", self.origin), "POST", Some(&self.credential), Some(&body.to_string())) {
            Ok(answer) => status_of(answer.status).map(|()| answer.body),
            Err(LinkError::Offline) => Err(ApiError::Offline),
            Err(LinkError::Failed(_)) => Err(ApiError::Unavailable),
        }
    }

    fn report_body(&self, step_id: &str, outcome: &Outcome) -> serde_json::Value {
        let (tenant, outpost_id) = (&self.tenant, &self.outpost_id);
        match outcome {
            Outcome::Done(None) => json!({ "tenant": tenant, "outpostId": outpost_id, "stepId": step_id, "outcome": "done" }),
            Outcome::Done(Some(text)) => {
                json!({ "tenant": tenant, "outpostId": outpost_id, "stepId": step_id, "outcome": "done", "text": text })
            }
            Outcome::Failed(failure) => json!({ "tenant": tenant, "outpostId": outpost_id, "stepId": step_id,
                "outcome": "failed", "code": failure.code() }),
        }
    }
}

/// What a status means to the outpost; only a 200 did what was asked.
fn status_of(status: u16) -> Result<(), ApiError> {
    match status {
        200 => Ok(()),
        401 => Err(ApiError::Unauthorized),
        429 => Err(ApiError::RateLimited),
        400..=499 => Err(ApiError::Refused),
        _ => Err(ApiError::Unavailable),
    }
}

#[derive(Deserialize)]
struct StepsWire<'a> {
    #[serde(borrow)]
    steps: Vec<StepWire<'a>>,
}

/// A step as the answer holds it. A write step's values stay raw JSON borrowed from the answer until each is written
/// once into a buffer that is wiped (`values_of`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepWire<'a> {
    step_id: String,
    kind: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    grant_id: Option<String>,
    #[serde(default)]
    form: Option<String>,
    #[serde(default, borrow)]
    values: Option<&'a RawValue>,
    #[serde(default)]
    origins: Vec<String>,
}

#[derive(Deserialize)]
struct ValueWire<'a> {
    field: String,
    #[serde(borrow)]
    value: &'a RawValue,
}

/// The steps an answer to `POST /v1/outposts/steps` holds. A write step whose values do not read as a list of fields
/// and text is still read, with no values, so it is reported (not run) rather than lost with the rest of the batch.
pub fn steps_of(answer: &str) -> Result<Vec<OutpostStep>, ApiError> {
    let wire: StepsWire = serde_json::from_str(answer).map_err(|_| ApiError::Unavailable)?;
    Ok(wire
        .steps
        .into_iter()
        .map(|step| OutpostStep {
            step_id: step.step_id,
            kind: step.kind,
            url: step.url,
            selector: step.selector,
            grant_id: step.grant_id,
            form: step.form,
            values: step.values.and_then(values_of),
            origins: step.origins,
        })
        .collect())
}

/// A write's values, each written once from its raw JSON into a buffer that is wiped, or None for anything else.
fn values_of(raw: &RawValue) -> Option<Vec<SubmitValue>> {
    let wire: Vec<ValueWire> = serde_json::from_str(raw.get()).ok()?;
    wire.into_iter().map(|v| Some(SubmitValue { field: v.field, value: unescape(v.value.get())? })).collect()
}

#[derive(Deserialize)]
struct RedeemedWire<'a> {
    origins: Vec<String>,
    #[serde(borrow)]
    username: &'a RawValue,
    #[serde(borrow)]
    password: &'a RawValue,
}

impl OutpostApi for HttpApi {
    fn heartbeat(&self) -> Result<(), ApiError> {
        self.post("/v1/outposts/heartbeat", json!({ "tenant": self.tenant, "outpostId": self.outpost_id })).map(|_| ())
    }

    fn steps(&self) -> Result<Vec<OutpostStep>, ApiError> {
        // Read as the redeem is: a write step's values are in this answer, and the buffer that holds it is wiped.
        let body = json!({ "tenant": self.tenant, "outpostId": self.outpost_id }).to_string();
        let (status, answer) = match api_link::request_sealed(&format!("{}/v1/outposts/steps", self.origin), "POST",
            Some(&self.credential), Some(&body)) {
            Ok(answer) => answer,
            Err(LinkError::Offline) => return Err(ApiError::Offline),
            Err(LinkError::Failed(_)) => return Err(ApiError::Unavailable),
        };
        status_of(status)?;
        steps_of(&answer)
    }

    fn redeem(&self, grant_id: &str) -> Result<Redeemed, ApiError> {
        let body = json!({ "tenant": self.tenant, "outpostId": self.outpost_id, "grantId": grant_id }).to_string();
        let (status, answer) = match api_link::request_sealed(&format!("{}/v1/outposts/redeem", self.origin), "POST",
            Some(&self.credential), Some(&body)) {
            Ok(answer) => answer,
            Err(LinkError::Offline) => return Err(ApiError::Offline),
            Err(LinkError::Failed(_)) => return Err(ApiError::Unavailable),
        };
        status_of(status)?;
        let wire: RedeemedWire = serde_json::from_str(&answer).map_err(|_| ApiError::Unavailable)?;
        let username = unescape(wire.username.get()).ok_or(ApiError::Unavailable)?;
        let password = unescape(wire.password.get()).ok_or(ApiError::Unavailable)?;
        Ok(Redeemed { origins: wire.origins, username, password })
    }

    fn report(&self, step_id: &str, outcome: &Outcome) -> Result<(), ApiError> {
        self.post("/v1/outposts/steps/report", self.report_body(step_id, outcome)).map(|_| ())
    }
}

/// A JSON string, as its raw text with the quotes, written out as the text it stands for, into a buffer sized for it
/// up front (the text is never longer than its JSON) and wiped when dropped. None for anything that is not a JSON
/// string; what was written by then is wiped as well.
pub fn unescape(raw: &str) -> Option<Zeroizing<String>> {
    let inner = raw.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = Zeroizing::new(String::with_capacity(inner.len()));
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            if (c as u32) < 0x20 || c == '"' {
                return None;
            }
            out.push(c);
            continue;
        }
        match chars.next()? {
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            '/' => out.push('/'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'u' => {
                let high = hex4(&mut chars)?;
                let code = match high {
                    0xD800..=0xDBFF => {
                        if chars.next()? != '\\' || chars.next()? != 'u' {
                            return None;
                        }
                        let low = hex4(&mut chars)?;
                        if !(0xDC00..=0xDFFF).contains(&low) {
                            return None;
                        }
                        0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)
                    }
                    0xDC00..=0xDFFF => return None,
                    _ => high,
                };
                out.push(char::from_u32(code)?);
            }
            _ => return None,
        }
    }
    Some(out)
}

fn hex4(chars: &mut std::str::Chars<'_>) -> Option<u32> {
    let mut value = 0;
    for _ in 0..4 {
        value = value * 16 + chars.next()?.to_digit(16)?;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_out_a_json_string_exactly_as_json_reads_it() {
        for text in ["", "plain", "p\"w\\d/", "tab\there\nline\r\u{8}\u{c}", "ร้านมะลิ", "emoji 🔑 and é", "\u{1}\u{1f}", "a\u{2028}b"] {
            let raw = serde_json::to_string(text).unwrap();
            assert_eq!(unescape(&raw).as_deref().map(String::as_str), Some(text), "{raw}");
        }
        // escapes a JSON writer may choose, which serde_json would not write itself
        assert_eq!(unescape(r#""\u0041\/\ud83d\udd11\u00e9""#).as_deref().map(String::as_str), Some("A/🔑é"));
        for bad in ["", "\"", "x", "\"open", "\"a\"b\"", "\"\\x\"", "\"\\u12\"", "\"\\u12g4\"", "\"\\ud83d\"", "\"\\ud83dx\"",
            "\"\\udd11\"", "\"\\ud83d\\u0041\"", "\"line\nbreak\"", "\"trail\\\""] {
            assert!(unescape(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn says_what_each_status_means() {
        assert_eq!(status_of(200), Ok(()));
        assert_eq!(status_of(401), Err(ApiError::Unauthorized));
        assert_eq!(status_of(429), Err(ApiError::RateLimited));
        for refused in [400, 403, 404, 409, 413] {
            assert_eq!(status_of(refused), Err(ApiError::Refused), "{refused}");
        }
        for down in [500, 502, 503, 204, 302] {
            assert_eq!(status_of(down), Err(ApiError::Unavailable), "{down}");
        }
    }

    #[test]
    fn reports_a_code_from_the_fixed_list_or_what_a_read_read_and_nothing_else() {
        let api = HttpApi::new("http://127.0.0.1:9", "pilot:shop", "op-1", &format!("mo1_{}", "a".repeat(43)));
        assert_eq!(api.report_body("s-1", &Outcome::Done(None)),
            json!({ "tenant": "pilot:shop", "outpostId": "op-1", "stepId": "s-1", "outcome": "done" }));
        assert_eq!(api.report_body("s-1", &Outcome::Done(Some("Shipped".into()))),
            json!({ "tenant": "pilot:shop", "outpostId": "op-1", "stepId": "s-1", "outcome": "done", "text": "Shipped" }));
        assert_eq!(api.report_body("s-1", &Outcome::Failed(Failure::SignInRefused)),
            json!({ "tenant": "pilot:shop", "outpostId": "op-1", "stepId": "s-1", "outcome": "failed", "code": "sign_in_refused" }));
        assert_eq!(api.report_body("s-1", &Outcome::Failed(Failure::NotRun)),
            json!({ "tenant": "pilot:shop", "outpostId": "op-1", "stepId": "s-1", "outcome": "failed", "code": "not_run" }));
        let codes: Vec<&str> = [Failure::OriginNotAllowed, Failure::PageUnavailable, Failure::SelectorNotFound, Failure::SignInRefused,
            Failure::GrantRefused, Failure::SubmitRefused, Failure::NotRun, Failure::NavigationRefused, Failure::SignInInterrupted,
            Failure::TimedOut, Failure::BrowserError].iter().map(|f| f.code()).collect();
        // the API's STEP_FAILURES, in its order
        assert_eq!(codes, ["origin_not_allowed", "page_unavailable", "selector_not_found", "sign_in_refused", "grant_refused",
            "submit_refused", "not_run", "navigation_refused", "sign_in_interrupted", "timed_out", "browser_error"]);
    }

    #[test]
    fn reads_steps_as_the_api_hands_them_out() {
        let wire = r#"{"steps":[{"stepId":"s-1","kind":"open","url":"https://seller.shopee.co.th/","origins":["https://seller.shopee.co.th"],"expiresAt":"2026-11-24T10:00:00.000Z"},
            {"stepId":"s-2","kind":"read","selector":".status","origins":[]},{"stepId":"s-3","kind":"sign_in","grantId":"g-1","origins":["https://a.example"]},
            {"stepId":"s-4","kind":"submit","action":"refund","url":"https://seller.shopee.co.th/portal/sale/return/2291","form":"form#refund",
             "values":[{"field":"input[name=\"amount\"]","value":"500.00"},{"field":"textarea","value":"ร้าน \"มะลิ\"\n🔑\u00e9\t"}],
             "origins":["https://seller.shopee.co.th"],"expiresAt":"2026-11-24T10:00:00.000Z"},
            {"stepId":"s-5","kind":"upload","origins":[]}]}"#;
        let steps = steps_of(wire).unwrap();
        assert_eq!(steps.len(), 5);
        assert_eq!(steps[0].url.as_deref(), Some("https://seller.shopee.co.th/"));
        assert_eq!(steps[1].selector.as_deref(), Some(".status"));
        assert_eq!(steps[2].grant_id.as_deref(), Some("g-1"));
        // A write step: its page, its form, and every value exactly as the JSON says it, in order.
        let write = &steps[3];
        assert_eq!((write.kind.as_str(), write.form.as_deref()), ("submit", Some("form#refund")));
        let values = write.values.as_ref().unwrap();
        assert_eq!(values.iter().map(|v| (v.field.as_str(), v.value.as_str())).collect::<Vec<_>>(),
            [("input[name=\"amount\"]", "500.00"), ("textarea", "ร้าน \"มะลิ\"\n🔑é\t")]);
        // A kind this outpost does not know is still read, so it can be reported.
        assert_eq!(steps[4].kind, "upload");
        assert!(steps[0].values.is_none() && steps[0].form.is_none());
        assert!(steps_of("not json").is_err());
    }

    #[test]
    fn reads_a_write_step_whose_values_are_not_text_with_none_rather_than_losing_the_batch() {
        for values in [r#"[{"field":"input","value":500}]"#, r#""500""#, r#"[{"field":"input"}]"#, "null"] {
            let wire = format!(r#"{{"steps":[{{"stepId":"s-1","kind":"submit","form":"form","values":{values},"origins":[]}},{{"stepId":"s-2","kind":"read","origins":[]}}]}}"#);
            let steps = steps_of(&wire).unwrap();
            assert_eq!(steps.len(), 2, "{values}");
            assert!(steps[0].values.is_none(), "{values}");
        }
    }

    #[test]
    fn never_prints_a_write_steps_values() {
        let step = OutpostStep {
            step_id: "s-1".into(),
            kind: "submit".into(),
            form: Some("form#refund".into()),
            values: Some(vec![SubmitValue { field: "input[name=amount]".into(), value: Zeroizing::new("Known-7731".into()) }]),
            ..Default::default()
        };
        let printed = format!("{step:?} {step:#?} {:?}", step.values);
        assert!(printed.contains("input[name=amount]") && printed.contains("form#refund"), "{printed}");
        assert!(!printed.contains("Known-7731"), "{printed}");
    }

    #[test]
    fn never_prints_a_redeemed_username_or_password() {
        let redeemed = Redeemed { origins: vec!["https://a.example".into()], username: Zeroizing::new("fon@baanmali".into()),
            password: Zeroizing::new("hunter2-secret".into()) };
        let printed = format!("{redeemed:?} {redeemed:#?}");
        assert!(printed.contains("https://a.example"));
        assert!(!printed.contains("fon@baanmali") && !printed.contains("hunter2-secret"), "{printed}");
    }
}
