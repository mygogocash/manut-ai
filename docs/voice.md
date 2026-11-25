# Voice in the chat box

Item 81, the owner's "record audio, voice mode" (25 Nov 2026). Both chats' box (Buddy's, in its main chat and each
thread, and Kit's coding chat) has a microphone and a voice mode before Send, with no key of ours: the Mac's own speech
recognition and voices.

Code: `apps/desktop/src-tauri/src/voice.rs` (listening, in the shell), `apps/desktop/src/voice/` (`voice.ts` what both
share, `engine.ts` the shell's listening and the web view's reading aloud behind two interfaces, `mic.ts` the
microphone, `mode.ts` voice mode), `apps/desktop/src/chat/box/Voice.tsx` (the buttons, the card, the line over the
box) and `apps/desktop/src/settings/VoicePage.tsx` (Settings › Voice). Declared in `apps/desktop/src-tauri/Info.plist`
and `Entitlements.plist`.

## What a person sees and does

- **The microphone.** Press it and speak: the words appear in the message's text as they are heard, after what was
  already typed, to be read and corrected. Nothing is sent by itself; Send is the person's. A line over the box says it
  listens, in which language, and whether on this Mac or through Apple's servers. Press again or Esc to stop; typing or
  Send stops it too, and the words stay.
- **Voice mode.** Press it: the box listens, and when the person pauses (1.8 seconds with no new words) what was said
  goes as the message, through the same chat, to the same agent with the same asks. The answer is read aloud (without
  its code or web addresses), then the box listens again. The line over the box says when it listens (with the words
  heard so far), sends, waits for the answer and reads aloud, with a Stop. One press, of the button, Stop or Esc, ends it.
- **An ask is never answered by voice.** When an approval card or a question appears, voice mode stops listening and
  reading, the line says "There is something to approve above. Voice mode waits: decide with the card, as always.",
  and the Mac says one sentence to that effect in the app's language. Nothing heard meanwhile is sent. Once the person
  decides with the card, the answer is read and the box listens again.
- **Before audio leaves the Mac.** A language this Mac cannot recognize by itself (Thai, on this Mac today) shows a card
  over the box before the first use: what is sent, to whom, that no recording is kept, and where to change it. It
  listens only after "Use Apple's servers"; "Not now" listens to nothing and keeps nothing.
- **Settings › Voice.** The language spoken (Thai or English), where speech becomes text (This Mac only, or Apple when
  needed, the yes given on the card or here, and taken back here), the Mac voice that reads answers, what works on this
  Mac for each language as the Mac itself reports it, the two permissions as macOS keeps them, and what is never kept.

Voice is in the Mac app only, and only in a box with the agent's controls (item 80): not in a Hermes bot's chat or a
new session's draft.

## What the platform gives

Checked on 25 Nov 2026 on this Mac (macOS 27.2.1, Apple silicon) against Apple's documentation, WebKit's source and the
installed Tauri 2.12.5 (wry 0.57.1, tauri-utils 2.10.2, tauri-codegen 2.7.4, Tauri CLI 2.12.6). The Mac was read with a
small Swift program that only lists what the frameworks offer (no permission asked, no audio, no prompt), and with
`voice::tests::reads_this_macs_languages_without_asking`, which does the same through the app's own bindings.

### Speech to text

| What | Fact | Source |
| --- | --- | --- |
| Speech framework (`SFSpeechRecognizer`), macOS 10.15 and later | By default the audio goes to Apple's servers: "The speech recognition process involves capturing audio of the user's voice and sending that data to Apple's servers for processing ... You must also obtain the user's permission before sending that data across the network" | [Asking permission to use speech recognition](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition) |
| | A request keeps its audio on the Mac with `requiresOnDeviceRecognition`, but "The request only honors this setting if the `supportsOnDeviceRecognition` property is also `true`"; when that is false "the SFSpeechRecognizer requires a network" | [requiresOnDeviceRecognition](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition), [supportsOnDeviceRecognition](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition) |
| | Limits: "Plan for a one-minute limit on audio duration", and devices and apps may be limited per day; asked for a language it does not have, `initWithLocale:` falls back to the dictation keyboard's language | [SFSpeechRecognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer), and the same page in the `objc2-speech` 0.3.2 bindings |
| | Apple's advice: "Don't send passwords, health or financial data, and other sensitive speech for recognition" | [SFSpeechRecognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer) |
| On this Mac | 62 locales, `th-TH` and `en-US` among them. Thai: available, **not on the device** (Apple's servers only). US English: **on the device**. British and Australian English: servers only. macOS logged "No Assistant asset for language th-TH" | the probe, and the test above |
| SpeechAnalyzer (`SpeechTranscriber`, `DictationTranscriber`), macOS 26 and later | "SpeechAnalyzer transcriber modules don't send audio data of the user's voice to Apple's servers." `DictationTranscriber` "uses the same speech-to-text machine learning models as system dictation ... or as SFSpeechRecognizer does when it is configured for on-device operation" and "does not support languages or locales that SFSpeechRecognizer only supports via network access". A Swift-only API: no Objective-C declaration | [Asking permission](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition), [DictationTranscriber](https://developer.apple.com/documentation/speech/dictationtranscriber) |
| On this Mac | `DictationTranscriber` lists `th-TH` as supported but not installed (only `en-US` is installed); `SpeechTranscriber` lists English only. So an on-device Thai model appears to exist as a download, which this item did not fetch | the probe |
| The web view's own `webkitSpeechRecognition` | Present in a plain WKWebView on this Mac. WebKit makes an `SFSpeechRecognizer` and sets `requiresOnDeviceRecognition` only `if ([_recognizer supportsOnDeviceRecognition])`, so for Thai it would send audio to Apple with no way for the app to ask first. An embedding app needs `NSSpeechRecognitionUsageDescription` or it gets `service-not-allowed`; wry grants the page's media capture by default | the probe; [WebSpeechRecognizerTask.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/speech/cocoa/WebSpeechRecognizerTask.mm); [WebKit bug 239816](https://bugs.webkit.org/show_bug.cgi?id=239816); wry 0.57.1 `src/wkwebview/class/wry_web_view_ui_delegate.rs` |

### Text to speech

| What | Fact | Source |
| --- | --- | --- |
| The web view's `speechSynthesis` | WebKit's Cocoa speech synthesis is `AVSpeechSynthesizer` with the system's voices, each listed with `localService` true | [PlatformSpeechSynthesizerCocoa.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/cocoa/PlatformSpeechSynthesizerCocoa.mm) |
| On this Mac | A plain WKWebView lists 70 voices: Thai is Kanya (`com.apple.voice.compact.th-TH.Kanya` and a super-compact one); US English has Samantha, Albert and others; British, Australian, Irish, Indian and South African English too. `AVSpeechSynthesisVoice.speechVoices()` lists the same | the probe |
| Not checked | How well the compact Kanya voice reads a Thai answer, and whether better Thai voices can be added in macOS's settings | the owner's steps below |

### What the app declares and asks

| What | Fact | Source |
| --- | --- | --- |
| `Info.plist` | An `Info.plist` in `src-tauri` "is merged with the values generated by the Tauri CLI"; a debug build embeds it in the binary | [Tauri: macOS application bundle](https://v2.tauri.app/distribute/macos-application-bundle/); tauri-codegen 2.7.4 `src/context.rs` |
| `NSMicrophoneUsageDescription` | "required if your app uses APIs that access the device's microphone" (macOS 10.14 and later) | [NSMicrophoneUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription) |
| `NSSpeechRecognitionUsageDescription` | "If this key is not present, your app will crash when it calls requestAuthorization(_:)", whether or not the request is on the device | [Asking permission](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition) |
| Hardened runtime | Tauri signs with the hardened runtime by default (`hardened_runtime: true`), and adds `--options runtime` whatever the identity, so the ad-hoc build `"-"` has it too | tauri-utils 2.10.2 `src/config.rs`; [tauri-macos-sign keychain.rs](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-macos-sign/src/keychain.rs) |
| `com.apple.security.device.audio-input` | Under the hardened runtime, the microphone is a resource-access entitlement: "first enable the Hardened Runtime capability ... then under Resource Access, select Audio Input". Tauri applies `bundle.macOS.entitlements` "when your application is signed" | [Audio input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input), [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime), [Tauri](https://v2.tauri.app/distribute/macos-application-bundle/) |
| When to ask | "Do not request access to speech recognition if you do not intend to use the feature right away" | [Asking permission](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition) |
| An unsigned or ad-hoc build (0.1.1) | "Ad hoc signed code ... has a DR but it's tied to that specific version of the code ... macOS can't reliably track the identity of the code"; macOS records the DR for the microphone, and "If you tweak the code and run it again, macOS repeats that prompt." So 0.1.1 can be given both permissions, and **each update asks again**; a Developer ID build keeps the yes across updates | [TN3127: Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) |

So the app declares `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` (`src-tauri/Info.plist`)
and the one entitlement `com.apple.security.device.audio-input` (`src-tauri/Entitlements.plist`, named by
`bundle.macOS.entitlements`, kept by the unsigned build, which changes only the identity). macOS's own two prompts
show the first time the microphone or voice mode is pressed, never at launch.

## The route

- **Listening: the Speech framework, from the shell.** `voice.rs` hands the microphone's audio from `AVAudioEngine`'s
  input tap straight into an `SFSpeechAudioBufferRecognitionRequest`, in memory, through the objc2 project's bindings
  (`objc2-speech`, `objc2-avf-audio`, `objc2-av-foundation`, Zlib OR Apache-2.0 OR MIT). It sets
  `requiresOnDeviceRecognition` whenever the recognizer supports it, and starts a recognition that would go to Apple's
  servers only when the page passes the person's yes; the page checks the same first (`decide` in `voice.ts`), and the
  shell checks again (`may_listen`). The web view's own recognition was not used because it would send Thai to Apple
  without the app being able to ask first.
- **Thai:** through Apple's servers, after the person's yes, on this Mac today. **English (US):** on the Mac.
  Settings › Voice reads this from the Mac each time it opens, so a Mac that can do Thai by itself is used that way
  with no change here.
- **Reading aloud: the web view's `speechSynthesis`**, which speaks with the Mac's own voices on the Mac, in short
  pieces, in the language spoken and with the voice chosen in Settings (else the Mac's default for it).

## What is never kept

- No recording: no audio file is written and nothing records. The tap's buffers go to the recognizer in memory and are
  gone. `voice::tests::keeps_no_recording_and_logs_nothing` holds `voice.rs` to that: no file API, no `AVAudioFile`,
  no recorder, no print or log, and the words go to the page in one event only.
- No log of the audio or the words heard: the shell sends the words only to the page; an error goes as its kind
  (`failed:<domain>:<code>`), never its message. The page's voice code writes no console line
  (`voice.test.ts`, "logs nothing").
- What stays is what a person would see anyway: the words the microphone put in the box (until sent or cleared, as
  typed text) and, in voice mode, the message sent, which is the chat's history as any message is. The page keeps only
  the three choices of Settings › Voice (`manut.voice.lang`, `manut.voice.where`, `manut.voice.voices`).
- When the person said yes to Apple, Apple's servers receive the audio of what is said while the box listens, to send
  the words back; the card and Settings › Voice say so. What Apple does with it is under Apple's terms.

## What tests cover

- Rust (`voice.rs`): the two languages and nothing else, the two permission orders (speech's and the microphone's
  differ), on the Mac when it can and on Apple's servers only after a yes, the refusals in the person's order, the event
  shapes, the plists as Tauri's parser reads them, the Mac's own list read without asking, and no recording or log.
- `release-desktop.test.mjs`: the entitlement for both builds and nothing else, and the two usage lines.
- `voice.test.ts`, `mic.test.ts`, `mode.test.ts`: the choices and where they are kept, the yes before Apple, the words
  after what was typed, the microphone's start, stop, typing and refusals, voice mode step by step (the pause, the turn,
  the answer, an ask, a hand-sent message, no answer, Stop) and run with stand-ins for the shell, the voice and the clock.
- `voice.test.tsx`, `VoicePage.test.tsx`: the buttons, the card, the line over the box and Settings › Voice, in every
  language.
- `e2e/voice.spec.ts`: the box in a browser with the stand-in listening and voice: the microphone, the card and the yes,
  and voice mode through a pause, an answer read aloud, an approval card it waits on, the card decided, and Stop.

## What only a person with a microphone can check

On the Mac app built from this branch, in a quiet room:

1. Open Kit's chat (or Buddy's), Settings › Voice: English reads "recognized on this Mac", Thai "only through Apple's
   servers", Microphone and Speech recognition read "macOS asks the first time".
2. Set the language to English. Press the microphone: macOS asks for speech recognition, then for the microphone, each
   with Manut AI's line. Allow both. Say "show me today's orders": the words appear in the box as you speak, the line
   says "on this Mac". Press Esc: it stops, the words stay, nothing is sent. Press Send.
3. With Wi-Fi off, repeat step 2: English still works (on the Mac).
4. Set the language to Thai, This Mac only. Press the microphone: the card asks before Apple. Press Not now: nothing
   listens. Press it again, then Use Apple's servers: speak Thai; the line says "through Apple's servers". Judge whether
   the Thai words are good enough. Settings › Voice now shows Apple when needed.
5. Press voice mode, ask a short question in English or Thai, and pause: it sends, the line says it waits, the answer is
   read aloud, then it listens again. Judge the Thai voice (Kanya).
6. In voice mode, in Kit's chat on a test project, ask for something that needs approval (for example "delete the build
   folder"): the card appears, the reading stops, the line says there is something to approve, and the Mac says so.
   Say "yes": nothing is sent. Decide on the card: the answer is read, then it listens again. Press Stop.
7. Talk for more than a minute in Thai with the microphone: it stops by itself (Apple's one-minute limit) and keeps the
   words.
8. System Settings › Privacy & Security › Microphone: turn Manut AI off, press the microphone: the box says how to turn
   it back on.
9. After installing the next unsigned update, press the microphone: expect macOS to ask again (TN3127).

## Needs the owner

- **Thai on the Mac alone.** Two free ways, neither done here: (1) Try adding Thai to the Mac's Dictation, then open
  Settings › Voice: if Thai reads "recognized on this Mac", Manut AI already uses it on the Mac (not tried here: it
  downloads a model on the owner's Mac). (2) macOS 26's `SpeechAnalyzer` with `DictationTranscriber`, which lists Thai
  on this Mac and never sends audio to Apple, but is a Swift-only API: it needs a small Swift part in the Tauri build
  and works only on macOS 26 and later. A paid recognition service would be a third way; none was added, and which
  service, its price per minute of audio and whose key are the owner's call.
- **A Developer ID signature**, so the microphone and speech recognition permissions survive updates (an ad-hoc build
  is asked again after each one).
- **The Thai voice.** Only the compact Kanya voice is on this Mac; whether it is good enough to read answers is the
  owner's ear.
