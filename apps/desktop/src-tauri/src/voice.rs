//! Voice in the chat box (item 81): the microphone that turns speech into a message's text, and voice mode, which
//! listens for one message at a time. This is the listening half; the page reads answers aloud with the web view's own
//! `speechSynthesis`, which speaks with the Mac's voices (docs/voice.md).
//!
//! macOS: the Speech framework's `SFSpeechRecognizer`, fed from `AVAudioEngine`'s input node through a tap whose
//! buffers go straight into an `SFSpeechAudioBufferRecognitionRequest`, in memory. Nothing of the audio is ever written:
//! there is no file, no `AVAudioFile` and no recorder here, and neither the audio nor the words heard go to a log; the
//! words go only to the page, in the `voice-heard` event. The test at the bottom reads this file and holds it to that.
//!
//! Where the words are made. Apple's documentation says a request keeps its audio on the Mac when
//! `requiresOnDeviceRecognition` is set, and that the setting is honored only while the recognizer's
//! `supportsOnDeviceRecognition` is true; otherwise the audio goes to Apple's servers. So a language this Mac can
//! recognize on its own always runs on the Mac, and one it cannot is started only when the page says the person said
//! yes to Apple (`apple`), which `may_listen` checks here again, whatever the page did.
//!
//! The Objective-C objects live on the main thread only: each command hops there with `run_on_main_thread`, the
//! recognizer reports on the main queue, and the one live recognition is kept in a thread-local there. Elsewhere
//! (Windows, Linux) there is no voice, and every command says so.

use serde::Serialize;

/// The languages a person may speak to the box, as the Speech framework names them. Thai and English are the two the
/// owner asked for; US English is the English this Mac recognizes on its own (docs/voice.md).
pub const LANGS: [&str; 2] = ["th-TH", "en-US"];

/// What the page hears about one recognition as the words come: the text heard so far (the recognizer revises it as it
/// goes, so each event replaces the last), and whether it is the last one.
pub const HEARD_EVENT: &str = "voice-heard";
/// The recognition ended: by the person, by the recognizer (its own end, an error, a minute's limit) or by a cancel.
pub const ENDED_EVENT: &str = "voice-ended";

/// Whether the person let this app use the microphone or speech recognition, as macOS keeps it.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    /// Never asked: the first use shows macOS's own prompt.
    NotAsked,
    Allowed,
    Denied,
    /// Not the person's to give (a profile, parental controls).
    Restricted,
}

impl Access {
    /// `SFSpeechRecognizerAuthorizationStatus`: 0 not determined, 1 denied, 2 restricted, 3 authorized.
    pub fn from_speech(raw: isize) -> Access {
        match raw {
            3 => Access::Allowed,
            1 => Access::Denied,
            2 => Access::Restricted,
            _ => Access::NotAsked,
        }
    }

    /// `AVAuthorizationStatus`: 0 not determined, 1 restricted, 2 denied, 3 authorized. Not the same order as speech's.
    pub fn from_mic(raw: isize) -> Access {
        match raw {
            3 => Access::Allowed,
            2 => Access::Denied,
            1 => Access::Restricted,
            _ => Access::NotAsked,
        }
    }
}

/// What this Mac can do for one language, read without asking the person anything (no prompt shows).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub lang: String,
    /// The Speech framework lists the language at all.
    pub supported: bool,
    /// It can recognize it right now (a language that needs Apple's servers is not, offline).
    pub available: bool,
    /// It can recognize it on this Mac, with no audio sent anywhere.
    pub on_device: bool,
    pub speech: Access,
    pub mic: Access,
}

/// Where one recognition runs.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    /// On this Mac: `requiresOnDeviceRecognition` set, honored because the recognizer supports it.
    OnDevice,
    /// On Apple's servers, which the person said yes to.
    Apple,
}

/// A recognition that started: its id, which every event names, and where it runs.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub id: u32,
    pub route: Route,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Heard {
    pub id: u32,
    pub text: String,
    #[serde(rename = "final")]
    pub done: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ended {
    pub id: u32,
    /// Why it ended badly, as a code the page puts into words (`failed`, `input`); none when it simply ended. It never
    /// carries what was heard.
    pub error: Option<String>,
}

/// One of the languages offered (`LANGS`); anything else is refused before a recognizer is made.
pub fn lang_ok(lang: &str) -> bool {
    LANGS.contains(&lang)
}

/// The same locale whatever its separator: the framework lists `th-TH` where an `NSLocale` may say `th_TH`.
pub fn same_locale(a: &str, b: &str) -> bool {
    a.replace('_', "-").eq_ignore_ascii_case(&b.replace('_', "-"))
}

/// Whether a recognition may start, and where, once both permissions were asked for: the refusal is a code the page
/// puts into words. The order is the person's: a language this Mac cannot do at all first, then their own no to macOS,
/// then a language that needs Apple's servers without their yes, then a recognizer that cannot work right now.
pub fn may_listen(s: &Status, apple: bool) -> Result<Route, &'static str> {
    if !lang_ok(&s.lang) || !s.supported {
        return Err("unsupported");
    }
    if s.mic != Access::Allowed {
        return Err("mic-denied");
    }
    if s.speech != Access::Allowed {
        return Err("speech-denied");
    }
    let route = if s.on_device {
        Route::OnDevice
    } else if apple {
        Route::Apple
    } else {
        return Err("apple-not-allowed");
    };
    if !s.available {
        return Err("unavailable");
    }
    Ok(route)
}

/// The page asks what this Mac can do for `lang` (Settings › Voice, and before the box's first use). Asks nothing.
#[tauri::command]
pub async fn voice_status(app: tauri::AppHandle, lang: String) -> Result<Status, String> {
    if !lang_ok(&lang) {
        return Err("unsupported".into());
    }
    #[cfg(target_os = "macos")]
    return on_main(&app, move || mac::status(&lang)).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(Status { lang, supported: false, available: false, on_device: false, speech: Access::Restricted, mic: Access::Restricted })
    }
}

/// Start listening in `lang`: macOS's own prompts for the microphone and speech recognition show here the first time,
/// then the recognition starts on this Mac, or on Apple's servers only with `apple` (the person's yes). The words come
/// as `voice-heard` events until `voice-ended`.
#[tauri::command]
pub async fn voice_listen(app: tauri::AppHandle, lang: String, apple: bool) -> Result<Started, String> {
    if !lang_ok(&lang) {
        return Err("unsupported".into());
    }
    #[cfg(target_os = "macos")]
    {
        // each prompt waits for the person's answer off the main thread, which keeps drawing the window meanwhile
        let speech = on_main(&app, mac::speech_access).await?;
        if speech == Access::NotAsked {
            wait(on_main(&app, mac::ask_speech).await?).await?;
        }
        let mic = on_main(&app, mac::mic_access).await?;
        if mic == Access::NotAsked {
            wait(on_main(&app, mac::ask_mic).await?).await?;
        }
        let handle = app.clone();
        on_main(&app, move || mac::start(handle, &lang, apple)).await?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, apple);
        Err("not-here".into())
    }
}

/// Stop recognition `id`. With `keep` the words heard so far are finished and the last `voice-heard` comes; without it
/// they are dropped at once. Either way `voice-ended` follows, and a recognition that already ended is left alone.
#[tauri::command]
pub async fn voice_stop(app: tauri::AppHandle, id: u32, keep: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        on_main(&app, move || mac::stop(&handle, id, keep)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id, keep);
        Ok(())
    }
}

/// Runs `f` on the main thread and hands its answer back to this command.
#[cfg(target_os = "macos")]
async fn on_main<T: Send + 'static>(app: &tauri::AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

/// Waits for the person's answer to one of macOS's prompts; what they answered is read again afterwards.
#[cfg(target_os = "macos")]
async fn wait(rx: std::sync::mpsc::Receiver<()>) -> Result<(), String> {
    // A prompt left open is not an error: after a long wait the start goes on and finds the permission still not given.
    tauri::async_runtime::spawn_blocking(move || {
        let _ = rx.recv_timeout(std::time::Duration::from_secs(600));
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{may_listen, same_locale, Access, Ended, Heard, Route, Started, Status, ENDED_EVENT, HEARD_EVENT};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObjectProtocol};
    use objc2::AnyThread;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};
    use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer, AVAudioTime};
    use objc2_foundation::{NSError, NSLocale, NSOperationQueue, NSString};
    use objc2_speech::{
        SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognitionTaskHint,
        SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
    };
    use std::cell::{Cell, RefCell};
    use std::ptr::NonNull;
    use std::sync::mpsc::{channel, Receiver};
    use tauri::{AppHandle, Emitter};

    /// The one recognition that runs, and everything it holds: the engine and its tap, the request the tap feeds, the
    /// task and its recognizer. Dropping it lets them all go.
    struct Live {
        id: u32,
        engine: Retained<AVAudioEngine>,
        request: Retained<SFSpeechAudioBufferRecognitionRequest>,
        task: Retained<SFSpeechRecognitionTask>,
        _recognizer: Retained<SFSpeechRecognizer>,
    }

    thread_local! {
        static LIVE: RefCell<Option<Live>> = const { RefCell::new(None) };
        static NEXT: Cell<u32> = const { Cell::new(1) };
    }

    pub fn speech_access() -> Access {
        Access::from_speech(unsafe { SFSpeechRecognizer::authorizationStatus() }.0)
    }

    pub fn mic_access() -> Access {
        match unsafe { AVMediaTypeAudio } {
            Some(audio) => Access::from_mic(unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) }.0),
            None => Access::Restricted,
        }
    }

    /// macOS's speech recognition prompt (with the Info.plist's `NSSpeechRecognitionUsageDescription`); the receiver
    /// gets a message once the person answered.
    pub fn ask_speech() -> Receiver<()> {
        let (tx, rx) = channel();
        let done = RcBlock::new(move |_status: SFSpeechRecognizerAuthorizationStatus| {
            let _ = tx.send(());
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&done) };
        rx
    }

    /// macOS's microphone prompt (with the Info.plist's `NSMicrophoneUsageDescription`).
    pub fn ask_mic() -> Receiver<()> {
        let (tx, rx) = channel();
        let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
            let _ = tx.send(());
            return rx;
        };
        let done = RcBlock::new(move |_granted: Bool| {
            let _ = tx.send(());
        });
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &done) };
        rx
    }

    /// A recognizer for `lang` only when the framework lists that very language: asked for one it does not have,
    /// `initWithLocale:` falls back to the keyboard's dictation language, which is not what the person picked.
    fn recognizer(lang: &str) -> Option<Retained<SFSpeechRecognizer>> {
        let listed = unsafe { SFSpeechRecognizer::supportedLocales() }.iter().any(|l| same_locale(&l.localeIdentifier().to_string(), lang));
        if !listed {
            return None;
        }
        let locale = NSLocale::localeWithLocaleIdentifier(&NSString::from_str(lang));
        let r = unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale) }?;
        same_locale(&unsafe { r.locale() }.localeIdentifier().to_string(), lang).then_some(r)
    }

    pub fn status(lang: &str) -> Status {
        let r = recognizer(lang);
        Status {
            lang: lang.to_string(),
            supported: r.is_some(),
            available: r.as_ref().is_some_and(|r| unsafe { r.isAvailable() }),
            on_device: r.as_ref().is_some_and(|r| unsafe { r.supportsOnDeviceRecognition() }),
            speech: speech_access(),
            mic: mic_access(),
        }
    }

    /// Ends the live recognition `id`, if it is still the live one: the engine stops and the tap comes off, so no more
    /// audio is taken, and the request is told no more is coming. `cancel` also drops what was heard.
    fn end(id: u32, cancel: bool) -> bool {
        let live = LIVE.with(|l| {
            let mut l = l.borrow_mut();
            if l.as_ref().is_some_and(|x| x.id == id) {
                l.take()
            } else {
                None
            }
        });
        let Some(live) = live else { return false };
        unsafe {
            live.engine.stop();
            live.engine.inputNode().removeTapOnBus(0);
            live.request.endAudio();
            if cancel {
                live.task.cancel();
            } else {
                live.task.finish();
            }
        }
        true
    }

    pub fn stop(app: &AppHandle, id: u32, keep: bool) {
        if end(id, !keep) && !keep {
            // a cancelled task may report nothing more, so the page hears the end from here
            let _ = app.emit(ENDED_EVENT, Ended { id, error: None });
        }
    }

    pub fn start(app: AppHandle, lang: &str, apple: bool) -> Result<Started, String> {
        if LIVE.with(|l| l.borrow().is_some()) {
            return Err("busy".into());
        }
        let route = may_listen(&status(lang), apple).map_err(str::to_string)?;
        let recognizer = recognizer(lang).ok_or("unsupported")?;
        let id = NEXT.with(|n| {
            let id = n.get();
            n.set(id.wrapping_add(1).max(1));
            id
        });
        unsafe {
            // results on the main queue, where the live recognition is kept
            recognizer.setQueue(&NSOperationQueue::mainQueue());
            let request = SFSpeechAudioBufferRecognitionRequest::new();
            request.setShouldReportPartialResults(true);
            request.setTaskHint(SFSpeechRecognitionTaskHint::Dictation);
            // On this Mac whenever it can: Apple honors this only while the recognizer supports it, which `route` read.
            request.setRequiresOnDeviceRecognition(route == Route::OnDevice);
            // Punctuation came with macOS 13; on an older Mac the words come without it.
            if request.respondsToSelector(objc2::sel!(setAddsPunctuation:)) {
                request.setAddsPunctuation(true);
            }

            let engine = AVAudioEngine::new();
            let input = engine.inputNode();
            let format = input.outputFormatForBus(0);
            // No input device (or none allowed) reads as a format with no samples, and installing a tap on it raises.
            if format.sampleRate() <= 0.0 || format.channelCount() == 0 {
                return Err("input".into());
            }
            // The tap hands each buffer of the microphone's audio to the request, in memory, and keeps nothing.
            let feed = request.clone();
            let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                feed.appendAudioPCMBuffer(buffer.as_ref());
            });
            let tapped = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap));
            }));
            if tapped.is_err() {
                return Err("input".into());
            }
            engine.prepare();
            if engine.startAndReturnError().is_err() {
                input.removeTapOnBus(0);
                return Err("input".into());
            }

            let sink = app.clone();
            let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                let mut done = !error.is_null();
                if let Some(result) = result.as_ref() {
                    done |= result.isFinal();
                    let text = result.bestTranscription().formattedString().to_string();
                    let _ = sink.emit(HEARD_EVENT, Heard { id, text, done: result.isFinal() });
                }
                if done {
                    end(id, false);
                    // only the error's kind goes to the page, never its message
                    let error = error.as_ref().map(|e| format!("failed:{}:{}", e.domain(), e.code()));
                    let _ = sink.emit(ENDED_EVENT, Ended { id, error });
                }
            });
            let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);
            LIVE.with(|l| *l.borrow_mut() = Some(Live { id, engine, request, task, _recognizer: recognizer }));
            Ok(Started { id, route })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(on_device: bool) -> Status {
        Status { lang: "th-TH".into(), supported: true, available: true, on_device, speech: Access::Allowed, mic: Access::Allowed }
    }

    #[test]
    fn offers_thai_and_english_only_and_reads_a_locale_either_way() {
        assert!(lang_ok("th-TH") && lang_ok("en-US"));
        for bad in ["", "th", "en-GB", "fr-FR", "th-TH; rm -rf /", "TH-TH"] {
            assert!(!lang_ok(bad), "{bad}");
        }
        assert!(same_locale("th_TH", "th-TH"));
        assert!(same_locale("en-us", "en-US"));
        assert!(!same_locale("en-GB", "en-US"));
    }

    #[test]
    fn reads_each_permission_in_its_own_order() {
        // Speech: 1 denied, 2 restricted. The microphone: 1 restricted, 2 denied.
        assert_eq!(Access::from_speech(0), Access::NotAsked);
        assert_eq!(Access::from_speech(1), Access::Denied);
        assert_eq!(Access::from_speech(2), Access::Restricted);
        assert_eq!(Access::from_speech(3), Access::Allowed);
        assert_eq!(Access::from_mic(1), Access::Restricted);
        assert_eq!(Access::from_mic(2), Access::Denied);
        assert_eq!(Access::from_mic(3), Access::Allowed);
        assert_eq!(Access::from_mic(9), Access::NotAsked);
    }

    #[test]
    fn listens_on_this_mac_when_it_can_and_on_apples_servers_only_after_a_yes() {
        // a language the Mac recognizes on its own runs there, with or without the yes
        assert_eq!(may_listen(&status(true), false), Ok(Route::OnDevice));
        assert_eq!(may_listen(&status(true), true), Ok(Route::OnDevice));
        // one it cannot is refused without the yes, and goes to Apple only with it
        assert_eq!(may_listen(&status(false), false), Err("apple-not-allowed"));
        assert_eq!(may_listen(&status(false), true), Ok(Route::Apple));
    }

    #[test]
    fn refuses_in_the_persons_order() {
        let s = status(false);
        assert_eq!(may_listen(&Status { supported: false, ..s.clone() }, true), Err("unsupported"));
        assert_eq!(may_listen(&Status { lang: "fr-FR".into(), ..s.clone() }, true), Err("unsupported"));
        assert_eq!(may_listen(&Status { mic: Access::Denied, speech: Access::Denied, ..s.clone() }, true), Err("mic-denied"));
        assert_eq!(may_listen(&Status { mic: Access::NotAsked, ..s.clone() }, true), Err("mic-denied"));
        assert_eq!(may_listen(&Status { speech: Access::Restricted, ..s.clone() }, true), Err("speech-denied"));
        // the yes is asked before the network: an offline Mac still says Thai needs Apple
        assert_eq!(may_listen(&Status { available: false, ..s.clone() }, false), Err("apple-not-allowed"));
        assert_eq!(may_listen(&Status { available: false, ..s.clone() }, true), Err("unavailable"));
    }

    #[test]
    fn tells_the_page_the_words_and_the_end_in_its_own_names() {
        let heard = serde_json::to_value(Heard { id: 3, text: "สวัสดี".into(), done: true }).unwrap();
        assert_eq!(heard, serde_json::json!({ "id": 3, "text": "สวัสดี", "final": true }));
        let ended = serde_json::to_value(Ended { id: 3, error: None }).unwrap();
        assert_eq!(ended, serde_json::json!({ "id": 3, "error": null }));
        let s = serde_json::to_value(status(true)).unwrap();
        assert_eq!(s["onDevice"], true);
        assert_eq!(s["mic"], "allowed");
        assert_eq!(serde_json::to_value(Access::NotAsked).unwrap(), "notAsked");
        assert_eq!(serde_json::to_value(Started { id: 1, route: Route::OnDevice }).unwrap(), serde_json::json!({ "id": 1, "route": "onDevice" }));
    }

    /// The bindings as they run on a Mac: the framework's own list has both languages, a recognizer is made for each,
    /// and reading what this Mac can do asks nothing (no permission is requested, so no prompt shows).
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_this_macs_languages_without_asking() {
        for lang in LANGS {
            let s = super::mac::status(lang);
            assert!(s.supported, "{lang}");
            assert_eq!(s.lang, lang);
        }
        let before = (super::mac::speech_access(), super::mac::mic_access());
        let _ = super::mac::status("th-TH");
        assert_eq!((super::mac::speech_access(), super::mac::mic_access()), before);
    }

    /// What the app declares, read with the plist parser Tauri merges and embeds them with: the two lines macOS shows in
    /// its prompts, and the one entitlement the hardened runtime needs for the microphone, which the bundle names.
    #[test]
    fn declares_the_microphone_and_speech_recognition() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let info = plist::Value::from_file(dir.join("Info.plist")).unwrap();
        let info = info.as_dictionary().unwrap();
        for key in ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"] {
            let line = info.get(key).and_then(|v| v.as_string()).unwrap_or_default();
            assert!(line.starts_with("Manut AI "), "{key}");
        }
        assert!(info.get("NSSpeechRecognitionUsageDescription").unwrap().as_string().unwrap().contains("asks you first"));
        // nothing a Tauri build already sets (the version, the name) is overwritten from here
        assert_eq!(info.len(), 2);
        let ent = plist::Value::from_file(dir.join("Entitlements.plist")).unwrap();
        let ent = ent.as_dictionary().unwrap();
        assert_eq!(ent.get("com.apple.security.device.audio-input").and_then(|v| v.as_boolean()), Some(true));
        assert_eq!(ent.len(), 1);
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["bundle"]["macOS"]["entitlements"], "./Entitlements.plist");
    }

    /// No recording is kept: this file (all but its tests) writes no file, makes no recorder and logs nothing, so neither
    /// the audio nor the words heard can reach a disk or a log from here.
    #[test]
    fn keeps_no_recording_and_logs_nothing() {
        let src = include_str!("voice.rs");
        // what runs, without the comments that explain it (which name what is not here)
        let code: String = src[..src.find("#[cfg(test)]\nmod tests").unwrap()]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(code.contains("appendAudioPCMBuffer"), "the tap feeds the request in memory");
        for banned in ["std::fs", "File::", "AVAudioFile", "AVAudioRecorder", "println!", "eprintln!", "dbg!", "log::", "tracing::", "write!", "writeln!", ".write("] {
            assert!(!code.contains(banned), "{banned}");
        }
        // the words go to the page in one event and nowhere else
        assert_eq!(code.matches("HEARD_EVENT, Heard").count(), 1);
    }
}
