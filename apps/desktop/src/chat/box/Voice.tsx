// Voice in the chat box (item 81), in the room item 80 left before Send: the microphone, which puts the words heard into
// the message's text for the person to read and correct before sending, and voice mode, which listens, sends what was
// said at a pause, reads the answer aloud and listens again. Both start only once this Mac can listen in the person's
// language, and a language it cannot recognize by itself waits for the person's yes to Apple's servers (the card above
// the box). The line over the box says plainly while either listens, where the words are made, and while voice mode
// waits, reads aloud or waits for an ask to be decided. The behaviour is the controllers' (voice/mic.ts, voice/mode.ts);
// this file draws them and wires them to the chat.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./voice.css";
import { useStore } from "../../state/store";
import { lang as uiLang, LANG_TAG, t } from "../../i18n";
import { getVoiceEngines } from "../../voice/engine";
import { createMic, type MicView } from "../../voice/mic";
import { createVoiceMode, OFF, type ModeState } from "../../voice/mode";
import { usePlace, type BoxPlace } from "../../palette/places";
import { decide, onPrefs, readPrefs, refusalOf, refusalText, routeText, savePrefs, spokenName, type Spoken } from "../../voice/voice";
import { Icon } from "../../ui/icons";

const MicMark = () => (
  <Icon name="mic" />
);

const WaveMark = () => (
  <Icon name="audio-lines" />
);

/** Whether a microphone or voice mode view is on (listening, starting, or going on in some phase). */
const micOn = (v: MicView) => v.kind !== "off";
const modeOn = (m: ModeState) => m.phase !== "off";

/** The two buttons before Send. Each is one press to start and one to stop; one is off while the other works. */
export function VoiceButtons({ mic, mode, lang, disabled, onMic, onMode }: { mic: MicView; mode: ModeState; lang: Spoken; disabled: boolean; onMic: () => void; onMode: () => void }) {
  const name = spokenName(lang);
  const micLive = micOn(mic);
  const modeLive = modeOn(mode);
  const micTip = micLive ? t("voice.micStop") : t("voice.mic", { lang: name });
  const modeTip = modeLive ? t("voice.modeStop") : t("voice.mode", { lang: name });
  return (
    <>
      <button
        type="button"
        className={`bx-voice${micLive ? " on" : ""}`}
        aria-pressed={micLive}
        aria-label={micTip}
        title={micTip}
        disabled={disabled || modeLive}
        onClick={onMic}
        data-testid="voice-mic"
      >
        <MicMark />
      </button>
      <button
        type="button"
        className={`bx-voice${modeLive ? " on" : ""}`}
        aria-pressed={modeLive}
        aria-label={modeTip}
        title={modeTip}
        disabled={disabled || micLive}
        onClick={onMode}
        data-testid="voice-mode"
      >
        <WaveMark />
      </button>
    </>
  );
}

/** What voice mode is doing, in words. */
function modeLine(m: ModeState, lang: Spoken): string {
  switch (m.phase) {
    case "starting":
      return t("voice.mode.starting");
    case "listening":
      return t("voice.mode.listening", { lang: spokenName(lang), where: routeText(m.route ?? "onDevice") });
    case "finishing":
      return t("voice.mode.finishing");
    case "waiting":
      return t("voice.mode.waiting");
    case "speaking":
      return t("voice.mode.speaking");
    case "paused":
      return t("voice.mode.paused");
    default:
      return "";
  }
}

/** The card that asks before a language goes to Apple's servers, the line while either listens, and a note. */
export function VoiceAbove({
  consent,
  mic,
  mode,
  lang,
  note,
  onYes,
  onNo,
  onStop,
}: {
  consent: Spoken | null;
  mic: MicView;
  mode: ModeState;
  lang: Spoken;
  note: string | null;
  onYes: () => void;
  onNo: () => void;
  onStop: () => void;
}) {
  const modeNote = mode.note === "noAnswer" ? t("voice.noAnswer") : mode.note ? refusalText(mode.note, lang) : null;
  return (
    <>
      {consent && (
        <div className="vc-card" role="group" aria-label={t("voice.consentTitle", { lang: spokenName(consent) })} data-testid="voice-consent">
          <b className="vc-card-h">{t("voice.consentTitle", { lang: spokenName(consent) })}</b>
          <p className="vc-card-p">{t("voice.consentBody", { lang: spokenName(consent) })}</p>
          <div className="vc-card-acts">
            <button type="button" className="vc-yes" onClick={onYes} data-testid="voice-consent-yes">
              {t("voice.consentYes")}
            </button>
            <button type="button" className="vc-no" onClick={onNo} data-testid="voice-consent-no">
              {t("voice.consentNo")}
            </button>
          </div>
        </div>
      )}
      {micOn(mic) && (
        <div className="vc-line" role="status" data-testid="voice-mic-line" data-state={mic.kind}>
          <i className="vc-dot" aria-hidden="true" />
          <span className="vc-t">{mic.kind === "starting" ? t("voice.micStarting") : t("voice.micLine", { lang: spokenName(lang), where: routeText(mic.route) })}</span>
        </div>
      )}
      {modeOn(mode) && (
        <div className={`vc-line vc-mode vc-${mode.phase}`} role="status" data-testid="voice-strip" data-phase={mode.phase}>
          <i className="vc-dot" aria-hidden="true" />
          <span className="vc-t">
            {modeLine(mode, lang)}
            {mode.heard && (mode.phase === "listening" || mode.phase === "finishing") && (
              <span className="vc-heard" data-testid="voice-heard">
                {mode.heard}
              </span>
            )}
          </span>
          <button type="button" className="vc-stop" onClick={onStop} data-testid="voice-stop">
            {t("voice.stop")}
          </button>
        </div>
      )}
      {(note || modeNote) && (
        <div className="vc-note" role="status" data-testid="voice-note">
          {note ?? modeNote}
        </div>
      )}
    </>
  );
}

/** What the box needs from its voice: the buttons, what goes over the box, and the box's own moments. */
export interface BoxVoice {
  buttons: ReactNode;
  above: ReactNode;
  /** The person typed: the microphone stops, and the words already in the box stay. */
  typed(): void;
  /** Esc: stops whichever listens (or closes the card); true when it did something. */
  escape(): boolean;
  /** The box is sending: the microphone stops first. */
  sending(): void;
}

/** The answers in a chat, oldest first, as voice mode reads them. */
export const answersOf = (items: readonly { kind: string; id: string; text?: string }[] | undefined) =>
  (items ?? []).filter((i) => i.kind === "assistant").map((i) => ({ id: i.id, text: i.text ?? "" }));

/** Voice for one chat's box. `on` false (a chat without the box's controls, or not the Mac app) gives nothing. */
export function useBoxVoice(o: { on: boolean; chatKey: string; text: string; setText: (text: string) => void; running: boolean; asking: boolean; offline: boolean; send: (text: string) => void }): BoxVoice {
  const s = useStore();
  const items = s.chats[o.chatKey]?.items;
  const latest = useRef({ text: o.text, setText: o.setText, send: o.send, items });
  latest.current = { text: o.text, setText: o.setText, send: o.send, items };
  const engines = useMemo(() => (o.on ? getVoiceEngines() : null), [o.on]);
  const [micView, setMicView] = useState<MicView>({ kind: "off" });
  const [mode, setMode] = useState<ModeState>(OFF);
  const [consent, setConsent] = useState<{ lang: Spoken; then: "mic" | "mode" } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lang, setLangChoice] = useState<Spoken>(() => readPrefs().lang);
  // a language picked in Settings › Voice shows on the buttons at once
  useEffect(() => onPrefs(() => setLangChoice(readPrefs().lang)), []);

  const mic = useMemo(
    () =>
      engines &&
      createMic({
        ears: engines.ears,
        text: () => latest.current.text,
        setText: (text) => latest.current.setText(text),
        onView: setMicView,
        onRefusal: (why) => setNote(refusalText(why, readPrefs().lang)),
      }),
    [engines],
  );
  const voice = useMemo(
    () =>
      engines &&
      createVoiceMode({
        ears: engines.ears,
        mouth: engines.mouth,
        lang: () => readPrefs().lang,
        apple: () => readPrefs().where === "apple",
        voice: () => {
          const p = readPrefs();
          return p.voices[p.lang];
        },
        send: (text) => latest.current.send(text),
        answers: () => answersOf(latest.current.items),
        // said in the app's language, which the person reads, with the Mac's voice for it
        announceAsk: () => engines.mouth?.speak(t("voice.askSpoken"), LANG_TAG[uiLang()], undefined, () => undefined),
        onView: setMode,
      }),
    [engines],
  );

  // the chat as it is now goes to voice mode, which waits for the turn to end, an answer, or an ask
  useEffect(() => voice?.chat(o.running, o.asking), [voice, o.running, o.asking, items]);
  // leaving the chat, going offline, or a box without voice: nothing keeps listening or speaking
  useEffect(() => {
    if (!o.on || o.offline) {
      mic?.cancel();
      voice?.stop();
    }
  }, [o.on, o.offline, mic, voice]);
  useEffect(
    () => () => {
      mic?.cancel();
      voice?.stop();
    },
    [mic, voice],
  );

  // The command palette offers the same two presses while this box is the one on screen. It reads the latest state
  // through a ref, so the registration holds still while the box re-renders.
  const press = useRef<{ micLive: boolean; modeLive: boolean; lang: Spoken; mic: () => void; mode: () => void }>({ micLive: false, modeLive: false, lang, mic: () => {}, mode: () => {} });
  const place = useMemo<BoxPlace | null>(
    () =>
      o.on && !o.offline && engines
        ? { micLive: () => press.current.micLive, modeLive: () => press.current.modeLive, spoken: () => spokenName(press.current.lang), toggleMic: () => press.current.mic(), toggleMode: () => press.current.mode() }
        : null,
    [o.on, o.offline, engines],
  );
  usePlace("box", place);

  if (!o.on || !engines || !mic || !voice) return { buttons: null, above: null, typed: () => {}, escape: () => false, sending: () => {} };

  /** A press: what this Mac can do for the person's language decides whether it listens, asks first, or says why not. */
  const begin = async (then: "mic" | "mode") => {
    setNote(null);
    setConsent(null);
    // a note voice mode left when it stopped goes with the next press
    if (!modeOn(voice.state)) voice.stop();
    const prefs = readPrefs();
    setLangChoice(prefs.lang);
    let status;
    try {
      status = await engines.ears.status(prefs.lang);
    } catch (e) {
      setNote(refusalText(refusalOf(e), prefs.lang));
      return;
    }
    const plan = decide(status, prefs.where);
    if (plan.kind === "refuse") return setNote(refusalText(plan.why, prefs.lang));
    if (plan.kind === "ask") return setConsent({ lang: prefs.lang, then });
    if (then === "mic") void mic.start(prefs.lang, plan.apple);
    else voice.start();
  };

  press.current = { micLive: micOn(micView), modeLive: modeOn(mode), lang, mic: () => (micOn(micView) ? mic.stop() : void begin("mic")), mode: () => (modeOn(mode) ? voice.stop() : void begin("mode")) };

  return {
    buttons: (
      <VoiceButtons
        mic={micView}
        mode={mode}
        lang={lang}
        disabled={o.offline}
        onMic={() => (micOn(micView) ? mic.stop() : void begin("mic"))}
        onMode={() => (modeOn(mode) ? voice.stop() : void begin("mode"))}
      />
    ),
    above: (
      <VoiceAbove
        consent={consent?.lang ?? null}
        mic={micView}
        mode={mode}
        lang={lang}
        note={note}
        onYes={() => {
          const then = consent?.then ?? "mic";
          // the person's yes, kept and shown in Settings › Voice, where it can be taken back
          savePrefs({ where: "apple" });
          setConsent(null);
          void begin(then);
        }}
        onNo={() => setConsent(null)}
        onStop={() => voice.stop()}
      />
    ),
    typed: () => mic.cancel(),
    escape: () => {
      if (micOn(mic.view)) {
        mic.stop();
        return true;
      }
      if (modeOn(voice.state)) {
        voice.stop();
        return true;
      }
      if (consent) {
        setConsent(null);
        return true;
      }
      return false;
    },
    sending: () => mic.cancel(),
  };
}
