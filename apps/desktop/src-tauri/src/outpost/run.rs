//! The outpost's loop, while the app is open and someone is signed in to the shop (mod.rs starts and stops it). Two
//! threads, both with the outpost's own credential:
//!
//! - **The heartbeat**, every 30 seconds, on a thread of its own: the API counts the outpost online while its last
//!   beat is under 90 seconds old, and a batch of steps (five sign-ins of 40 seconds each, at worst) must not let it
//!   fall asleep under the work it is doing.
//! - **The steps**: asked for every 3 seconds; run one at a time in the outpost's browser; each outcome reported once.
//!   An ask that brought the most one ask hands out (five) is followed by another at once, since more may be waiting.
//!
//! Why 3 seconds: it is what the API's ingress limit is sized for (an outpost asking every 3 seconds and beating every
//! 30 uses some 25 of its 300 a minute, so a dozen outposts can share an address), and it is a small share of a grant's
//! one minute and a step's two. Asking faster would crowd the limit for little; slower would eat into the grant.
//!
//! Nothing stops silently. A stop (the owner's Stop, signing out, quitting) wakes both threads at once; a step that is
//! running ends as a browser error, and each step still held and not begun is reported not run (`not_run`) rather than
//! left to run out of time: the outpost did nothing for it, so a write it held settles as nothing submitted. A credential the API no longer takes (the outpost was removed, or given a new credential) ends the
//! loop, and the Connections page says so. While the API cannot be reached, the asks space out, doubling up to a
//! minute, and an ask over the limit waits out the minute the API names.

use super::api::{ApiError, Failure, OutpostApi, OutpostStep, Outcome};
use super::step::{self, Browser, Pace};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

pub struct Timing {
    pub beat: Duration,
    pub ask: Duration,
    /// The longest an ask waits while the API cannot be reached.
    pub ask_most: Duration,
    /// How long an ask over the outposts' ingress limit waits (the API's `Retry-After`).
    pub limited: Duration,
    /// How long before a report that got no answer is sent again.
    pub retry: Duration,
}

pub const TIMING: Timing = Timing {
    beat: Duration::from_secs(30),
    ask: Duration::from_secs(3),
    ask_most: Duration::from_secs(60),
    limited: Duration::from_secs(60),
    retry: Duration::from_secs(2),
};

/// The most steps one ask hands out (the API's).
pub const MOST_PER_ASK: usize = 5;
/// How long a heartbeat keeps an outpost online, as the API counts it.
pub const ONLINE_FOR: Duration = Duration::from_secs(90);
/// How many times one outcome is sent when it gets no answer. The API takes a step's report once and refuses another
/// (`step_reported`), so sending the same outcome again after no answer can never count twice.
const REPORT_TRIES: u32 = 3;

/// What the loop shares with the app while it runs.
#[derive(Default)]
pub struct Shared {
    stop: AtomicBool,
    refused: AtomicBool,
    held: AtomicU32,
    beat: Mutex<Option<Instant>>,
    rest: Mutex<()>,
    wake: Condvar,
    notes: Mutex<Vec<&'static str>>,
}

impl Shared {
    /// Stops the loop: both threads wake at once and end.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // Taken so a thread about to rest sees the stop or is woken by it, never neither.
        let _resting = self.rest.lock().unwrap_or_else(|e| e.into_inner());
        self.wake.notify_all();
    }

    pub fn stopping(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// The flag a running step watches.
    pub fn stop_flag(&self) -> &AtomicBool {
        &self.stop
    }

    /// The API no longer takes this outpost's credential.
    pub fn refused(&self) -> bool {
        self.refused.load(Ordering::SeqCst)
    }

    /// Online as the API counts it: running, and the last heartbeat under 90 seconds old.
    pub fn online(&self) -> bool {
        !self.stopping() && self.beat.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|at| at.elapsed() < ONLINE_FOR)
    }

    /// How many steps it holds: handed out, and not yet reported.
    pub fn held(&self) -> u32 {
        self.held.load(Ordering::SeqCst)
    }

    /// What the loop said about itself, in fixed words only: never anything it read, was given or typed. Kept for a
    /// diagnosis; only the tests read them so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn notes(&self) -> Vec<&'static str> {
        self.notes.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn note(&self, what: &'static str) {
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        if notes.len() >= 64 {
            notes.remove(0);
        }
        notes.push(what);
    }

    fn refuse(&self) {
        self.refused.store(true, Ordering::SeqCst);
        self.stop();
    }

    /// Waits until `until`, or less if the loop is stopped.
    fn rest(&self, until: Instant) {
        let mut resting = self.rest.lock().unwrap_or_else(|e| e.into_inner());
        while !self.stopping() {
            let now = Instant::now();
            if now >= until {
                return;
            }
            resting = self.wake.wait_timeout(resting, until - now).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
}

/// Runs the loop until it is stopped or the API refuses the credential.
pub fn run(api: &dyn OutpostApi, browser: &dyn Browser, shared: &Shared, timing: &Timing, pace: &Pace) {
    shared.note("started");
    std::thread::scope(|scope| {
        scope.spawn(|| beat(api, shared, timing));
        ask(api, browser, shared, timing, pace);
        // The steps ended (stopped, or refused): so does the heartbeat.
        shared.stop();
    });
    shared.held.store(0, Ordering::SeqCst);
    shared.note(if shared.refused() { "credential refused" } else { "stopped" });
}

fn beat(api: &dyn OutpostApi, shared: &Shared, timing: &Timing) {
    while !shared.stopping() {
        match api.heartbeat() {
            Ok(()) => *shared.beat.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now()),
            Err(ApiError::Unauthorized) => {
                shared.refuse();
                return;
            }
            Err(_) => shared.note("heartbeat missed"),
        }
        shared.rest(Instant::now() + timing.beat);
    }
}

/// How long to wait before the next ask, after an ask that answered `error` (None: it answered steps), when the last
/// wait was `last`.
pub fn next_wait(error: Option<ApiError>, last: Duration, timing: &Timing) -> Duration {
    match error {
        None | Some(ApiError::Refused) | Some(ApiError::Unauthorized) => timing.ask,
        Some(ApiError::RateLimited) => timing.limited,
        Some(ApiError::Offline) | Some(ApiError::Unavailable) => (last.max(timing.ask) * 2).min(timing.ask_most),
    }
}

fn ask(api: &dyn OutpostApi, browser: &dyn Browser, shared: &Shared, timing: &Timing, pace: &Pace) {
    let mut wait = timing.ask;
    while !shared.stopping() {
        let (error, at_once) = match api.steps() {
            Ok(steps) => {
                let full = steps.len() >= MOST_PER_ASK;
                if !run_steps(steps, api, browser, shared, timing, pace) {
                    return;
                }
                (None, full)
            }
            Err(ApiError::Unauthorized) => {
                shared.refuse();
                return;
            }
            Err(error) => {
                shared.note(match error {
                    ApiError::RateLimited => "asked too often",
                    ApiError::Refused => "steps refused",
                    _ => "API not reached",
                });
                (Some(error), false)
            }
        };
        wait = next_wait(error, wait, timing);
        if !at_once {
            shared.rest(Instant::now() + wait);
        }
    }
}

/// Runs and reports each step in turn. Once the loop is stopping, a step not yet begun is reported not run at once
/// instead of being run. Answers false when the API refused the credential.
fn run_steps(steps: Vec<OutpostStep>, api: &dyn OutpostApi, browser: &dyn Browser, shared: &Shared, timing: &Timing, pace: &Pace)
    -> bool {
    shared.held.store(steps.len() as u32, Ordering::SeqCst);
    for step in steps {
        let outcome = if shared.stopping() {
            Outcome::Failed(Failure::NotRun)
        } else {
            step::run_step(&step, browser, api, shared.stop_flag(), pace)
        };
        let reported = report(api, shared, timing, &step.step_id, &outcome);
        shared.held.fetch_sub(1, Ordering::SeqCst);
        if !reported {
            shared.held.store(0, Ordering::SeqCst);
            return false;
        }
    }
    true
}

/// Reports one outcome. It is sent again, the same, only when it got no answer (the API may not have it); a report the
/// API answered, taken or refused, is never sent again. Answers false when the API refused the credential.
fn report(api: &dyn OutpostApi, shared: &Shared, timing: &Timing, step_id: &str, outcome: &Outcome) -> bool {
    for tries in 1..=REPORT_TRIES {
        match api.report(step_id, outcome) {
            Ok(()) | Err(ApiError::Refused) => return true,
            Err(ApiError::Unauthorized) => {
                shared.refuse();
                return false;
            }
            Err(_) if tries < REPORT_TRIES => {
                shared.note("report sent again");
                std::thread::sleep(timing.retry);
            }
            Err(_) => shared.note("report not answered"),
        }
    }
    true
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::outpost::api::{Redeemed, SubmitValue};
    use crate::outpost::step::fake::FakeBrowser;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    pub const FAST: Timing = Timing {
        beat: Duration::from_millis(20),
        ask: Duration::from_millis(5),
        ask_most: Duration::from_millis(40),
        limited: Duration::from_millis(30),
        retry: Duration::from_millis(1),
    };

    pub const QUICK: Pace = Pace {
        open: Duration::from_millis(300),
        read: Duration::from_millis(300),
        sign_in: Duration::from_millis(300),
        submit: Duration::from_millis(300),
        appear: Duration::from_millis(30),
        press: Duration::from_millis(30),
        poll: Duration::from_millis(1),
        settled: Duration::from_millis(3),
    };

    /// An API that hands out the batches it is given, one per ask, and records what it is asked.
    #[derive(Default)]
    struct Api {
        batches: Mutex<Vec<Vec<OutpostStep>>>,
        beats: AtomicUsize,
        asks: AtomicUsize,
        reports: Mutex<Vec<(String, Outcome)>>,
        beat_answer: Mutex<Option<ApiError>>,
        ask_answer: Mutex<Option<ApiError>>,
        /// Answers for reports, in order; once they run out, reports are taken.
        report_answers: Mutex<Vec<ApiError>>,
        /// Called at each ask, before it answers.
        on_ask: Option<Box<dyn Fn(&Api) + Send + Sync>>,
    }

    impl OutpostApi for Api {
        fn heartbeat(&self) -> Result<(), ApiError> {
            self.beats.fetch_add(1, Ordering::SeqCst);
            self.beat_answer.lock().unwrap().map_or(Ok(()), Err)
        }
        fn steps(&self) -> Result<Vec<OutpostStep>, ApiError> {
            self.asks.fetch_add(1, Ordering::SeqCst);
            if let Some(on_ask) = &self.on_ask {
                on_ask(self);
            }
            if let Some(error) = *self.ask_answer.lock().unwrap() {
                return Err(error);
            }
            let mut batches = self.batches.lock().unwrap();
            Ok(if batches.is_empty() { Vec::new() } else { batches.remove(0) })
        }
        fn redeem(&self, _: &str) -> Result<Redeemed, ApiError> {
            Err(ApiError::Refused)
        }
        fn report(&self, step_id: &str, outcome: &Outcome) -> Result<(), ApiError> {
            self.reports.lock().unwrap().push((step_id.to_owned(), outcome.clone()));
            let mut answers = self.report_answers.lock().unwrap();
            if answers.is_empty() {
                Ok(())
            } else {
                Err(answers.remove(0))
            }
        }
    }

    const SHOP: &str = "https://seller.shopee.co.th";

    fn open(id: &str) -> OutpostStep {
        OutpostStep { step_id: id.into(), kind: "open".into(), url: Some(format!("{SHOP}/{id}")), origins: vec![SHOP.into()], ..Default::default() }
    }

    fn page() -> FakeBrowser {
        FakeBrowser::at(None, Box::new(|_, _| Ok(r#"{"t":"Shipped"}"#.into())))
    }

    /// Runs the loop on a thread of its own until `done` says so (or two seconds pass), then stops it, and answers
    /// how long the stop took to end it.
    fn run_until(api: &Api, browser: &FakeBrowser, shared: &Shared, done: impl Fn() -> bool) -> Duration {
        std::thread::scope(|scope| {
            let handle = scope.spawn(|| run(api, browser, shared, &FAST, &QUICK));
            let started = Instant::now();
            while !done() && started.elapsed() < Duration::from_secs(2) {
                std::thread::sleep(Duration::from_millis(2));
            }
            let stopping = Instant::now();
            shared.stop();
            handle.join().unwrap();
            stopping.elapsed()
        })
    }

    #[test]
    fn beats_asks_runs_and_reports_each_step_once() {
        let api = Api::default();
        api.batches.lock().unwrap().push(vec![open("s-1"), open("s-2")]);
        let browser = page();
        let shared = Shared::default();
        run_until(&api, &browser, &shared, || api.reports.lock().unwrap().len() >= 2 && api.asks.load(Ordering::SeqCst) >= 3);
        assert_eq!(*api.reports.lock().unwrap(), [("s-1".into(), Outcome::Done(None)), ("s-2".into(), Outcome::Done(None))]);
        assert!(api.beats.load(Ordering::SeqCst) >= 1);
        assert_eq!(*browser.opened.lock().unwrap(), [format!("{SHOP}/s-1"), format!("{SHOP}/s-2")]);
        assert_eq!(shared.held(), 0);
        assert!(!shared.refused());
        assert_eq!(shared.notes().first(), Some(&"started"));
        assert_eq!(shared.notes().last(), Some(&"stopped"));
    }

    #[test]
    fn is_online_while_its_beats_are_answered() {
        let api = Api::default();
        let browser = page();
        let shared = Shared::default();
        assert!(!shared.online(), "not before its first beat");
        std::thread::scope(|scope| {
            let handle = scope.spawn(|| run(&api, &browser, &shared, &FAST, &QUICK));
            while api.beats.load(Ordering::SeqCst) == 0 {
                std::thread::sleep(Duration::from_millis(1));
            }
            std::thread::sleep(Duration::from_millis(5));
            assert!(shared.online());
            shared.stop();
            handle.join().unwrap();
        });
        assert!(!shared.online(), "stopped, it is asleep");
    }

    #[test]
    fn asks_again_at_once_after_an_ask_that_brought_the_most() {
        let api = Api::default();
        api.batches.lock().unwrap().push((1..=5).map(|i| open(&format!("s-{i}"))).collect());
        api.batches.lock().unwrap().push(vec![open("s-6")]);
        let browser = page();
        let shared = Shared::default();
        let slow = Timing { ask: Duration::from_secs(30), ..FAST };
        std::thread::scope(|scope| {
            let handle = scope.spawn(|| run(&api, &browser, &shared, &slow, &QUICK));
            let started = Instant::now();
            while api.reports.lock().unwrap().len() < 6 && started.elapsed() < Duration::from_secs(5) {
                std::thread::sleep(Duration::from_millis(2));
            }
            shared.stop();
            handle.join().unwrap();
        });
        // The sixth came from the second ask, which did not wait out the 30 seconds.
        assert_eq!(api.reports.lock().unwrap().len(), 6);
        assert_eq!(api.asks.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stops_at_once_and_reports_what_it_still_held() {
        // The owner presses Stop just as an ask hands out three steps.
        let shared = Arc::new(Shared::default());
        let stopper = shared.clone();
        let api = Api { on_ask: Some(Box::new(move |api: &Api| {
            if api.asks.load(Ordering::SeqCst) == 1 {
                stopper.stop();
            }
        })), ..Api::default() };
        api.batches.lock().unwrap().push(vec![open("s-1"), open("s-2"), open("s-3")]);
        let browser = page();
        let took = run_until(&api, &browser, &shared, || shared.stopping());
        assert!(took < Duration::from_secs(1), "{took:?}");
        // The outpost did nothing for them: not run, which the API reads as nothing submitted, were one a write.
        let failed = Outcome::Failed(Failure::NotRun);
        assert_eq!(*api.reports.lock().unwrap(), [("s-1".into(), failed.clone()), ("s-2".into(), failed.clone()), ("s-3".into(), failed)]);
        assert!(browser.opened.lock().unwrap().is_empty(), "nothing was run once it was stopping");
        assert_eq!(api.asks.load(Ordering::SeqCst), 1);
        assert_eq!(shared.held(), 0);
    }

    #[test]
    fn a_stop_wakes_a_resting_loop_at_once() {
        let api = Api::default();
        let browser = page();
        let shared = Shared::default();
        let resting = Timing { beat: Duration::from_secs(60), ask: Duration::from_secs(60), ..FAST };
        let took = std::thread::scope(|scope| {
            let handle = scope.spawn(|| run(&api, &browser, &shared, &resting, &QUICK));
            while api.asks.load(Ordering::SeqCst) == 0 || api.beats.load(Ordering::SeqCst) == 0 {
                std::thread::sleep(Duration::from_millis(1));
            }
            let stopping = Instant::now();
            shared.stop();
            handle.join().unwrap();
            stopping.elapsed()
        });
        assert!(took < Duration::from_millis(500), "{took:?}");
        assert_eq!(api.asks.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn ends_when_the_api_no_longer_takes_its_credential() {
        for at_beat in [true, false] {
            let api = Api::default();
            if at_beat {
                *api.beat_answer.lock().unwrap() = Some(ApiError::Unauthorized);
            } else {
                *api.ask_answer.lock().unwrap() = Some(ApiError::Unauthorized);
            }
            let browser = page();
            let shared = Shared::default();
            std::thread::scope(|scope| {
                scope.spawn(|| run(&api, &browser, &shared, &FAST, &QUICK)).join().unwrap();
            });
            assert!(shared.refused() && shared.stopping());
            assert_eq!(shared.notes().last(), Some(&"credential refused"));
            assert!(!shared.online());
        }
    }

    #[test]
    fn spaces_out_its_asks_while_the_api_cannot_be_reached() {
        let ask = FAST.ask;
        assert_eq!(next_wait(None, FAST.ask_most, &FAST), ask);
        assert_eq!(next_wait(Some(ApiError::Offline), ask, &FAST), ask * 2);
        assert_eq!(next_wait(Some(ApiError::Unavailable), ask * 2, &FAST), ask * 4);
        assert_eq!(next_wait(Some(ApiError::Offline), FAST.ask_most, &FAST), FAST.ask_most);
        assert_eq!(next_wait(Some(ApiError::RateLimited), ask, &FAST), FAST.limited);
        // Switched off or no consent: nothing to run now, so it asks again as usual.
        assert_eq!(next_wait(Some(ApiError::Refused), ask * 4, &FAST), ask);
        assert_eq!(TIMING.ask, Duration::from_secs(3));
        assert_eq!(TIMING.beat, Duration::from_secs(30));
    }

    #[test]
    fn a_write_steps_values_reach_the_page_and_nothing_else() {
        // A write step the API hands out, carrying a value nothing but the page may ever be given.
        const KNOWN: &str = "Refund-ค่า-7731 \"exact\"";
        let write = OutpostStep {
            step_id: "s-w".into(),
            kind: "submit".into(),
            url: Some(format!("{SHOP}/portal/sale/return/2291")),
            form: Some("form#refund".into()),
            values: Some(vec![SubmitValue { field: "input[name=\"amount\"]".into(), value: zeroize::Zeroizing::new(KNOWN.into()) }]),
            origins: vec![SHOP.into()],
            ..Default::default()
        };
        let api = Api::default();
        api.batches.lock().unwrap().push(vec![write, open("s-2")]);
        let browser = FakeBrowser::at(None, Box::new(|name, _| match name {
            "set" => Ok(r#"{"r":"set"}"#.into()),
            "press" => Ok(format!(r#"{{"r":"pressed","a":"{SHOP}/portal/sale/return/2291"}}"#)),
            "sent" => Ok(r#"{"s":"sent"}"#.into()),
            _ => unreachable!("{name}"),
        }));
        let shared = Shared::default();
        run_until(&api, &browser, &shared, || api.reports.lock().unwrap().len() >= 2);
        // Done, reported with a code or nothing: no report the outpost sent holds the value, and neither does anything it
        // noted or what it says it holds.
        let reports = api.reports.lock().unwrap();
        assert_eq!(*reports, [("s-w".to_string(), Outcome::Done(None)), ("s-2".to_string(), Outcome::Done(None))]);
        assert!(!format!("{reports:?}").contains("7731"));
        assert!(shared.notes().iter().all(|note| !note.contains("7731")));
        assert_eq!(shared.held(), 0);
        // The page was handed it, by the scripts that type and check it, and by nothing else.
        for (name, args) in browser.calls.lock().unwrap().iter() {
            assert_eq!(args.values().any(|v| v.contains("7731")), ["set", "press", "sent"].contains(name), "{name}");
        }
    }

    #[test]
    fn sends_a_report_again_only_when_it_got_no_answer_and_never_a_different_one() {
        let api = Api::default();
        *api.report_answers.lock().unwrap() = vec![ApiError::Offline, ApiError::Unavailable];
        api.batches.lock().unwrap().push(vec![open("s-1")]);
        let browser = page();
        let shared = Shared::default();
        run_until(&api, &browser, &shared, || api.reports.lock().unwrap().len() >= 3);
        assert_eq!(*api.reports.lock().unwrap(), vec![("s-1".to_string(), Outcome::Done(None)); 3]);

        // A report the API refused (late, already reported) is not sent again.
        let api = Api::default();
        *api.report_answers.lock().unwrap() = vec![ApiError::Refused];
        api.batches.lock().unwrap().push(vec![open("s-1"), open("s-2")]);
        let shared = Shared::default();
        run_until(&api, &browser, &shared, || api.reports.lock().unwrap().len() >= 2 && api.asks.load(Ordering::SeqCst) >= 3);
        let reports = api.reports.lock().unwrap();
        assert_eq!(reports.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["s-1", "s-2"]);
    }
}
