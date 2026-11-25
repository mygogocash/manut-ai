// Settings › Voice (item 81): the language the person speaks to the chat box, where speech becomes text (this Mac only,
// or Apple's servers for a language this Mac cannot recognize by itself, which only the person's yes turns on), and the
// Mac voice that reads answers aloud. Under them, what works on this Mac for each language, read from the Mac itself
// without asking anything, what does not work yet, the two permissions as macOS keeps them, and what is never kept.
//
// `VoiceView` draws a given state so a test can draw each one (VoicePage.test.tsx); `VoicePage` reads the Mac and acts.
import { useEffect, useState } from "react";
import { t, type Key } from "../i18n";
import { Seg } from "../chat/model/Seg";
import { getVoiceEngines, voiceOffered, type MacVoice } from "../voice/engine";
import { onPrefs, readPrefs, savePrefs, SPOKEN, spokenName, type Access, type HearStatus, type Spoken, type VoicePrefs, type Where } from "../voice/voice";
import { Row } from "./DevRow";

export interface VoiceViewProps {
  /** Voice works here (the Mac app). */
  offered: boolean;
  prefs: VoicePrefs;
  /** What this Mac can do for each language; null while it is being read. */
  statuses: Partial<Record<Spoken, HearStatus>> | null;
  /** The Mac's voices for the chosen language. */
  voices: MacVoice[];
  onLang: (lang: Spoken) => void;
  onWhere: (where: Where) => void;
  onVoice: (id: string) => void;
}

const ACCESS: Record<Access, Key> = {
  notAsked: "voice.access.notAsked",
  allowed: "voice.access.allowed",
  denied: "voice.access.denied",
  restricted: "voice.access.restricted",
};

/** One language on this Mac, in a line: on the Mac itself, only through Apple's servers, or not at all. */
export function worksLine(s: HearStatus | undefined, lang: Spoken): string {
  const name = spokenName(lang);
  if (!s?.supported) return t("voice.set.none", { lang: name });
  return t(s.onDevice ? "voice.set.onDevice" : "voice.set.appleOnly", { lang: name });
}

/** The voices a language may be read with: those whose language is the same, whatever the region. */
export const voicesFor = (all: readonly MacVoice[], lang: Spoken): MacVoice[] => all.filter((v) => v.lang.replace("_", "-").split("-")[0].toLowerCase() === lang.split("-")[0]);

export function VoiceView(p: VoiceViewProps) {
  if (!p.offered) {
    return (
      <div className="st-page" data-testid="voice-page">
        <div className="st-gh st-gh0">{t("set.voice")}</div>
        <div className="st-note" data-testid="voice-not-here">
          {t("voice.set.notMac")}
        </div>
      </div>
    );
  }
  const thai = p.statuses?.["th-TH"];
  const any = p.statuses ? Object.values(p.statuses)[0] : undefined;
  return (
    <div className="st-page" data-testid="voice-page">
      <div className="st-gh st-gh0">{t("set.voice")}</div>
      <div className="st-grp">
        <Row title={t("voice.set.lang")} hint={t("voice.set.langHint")}>
          <Seg label={t("voice.set.lang")} value={p.prefs.lang} onChange={(v) => p.onLang(v as Spoken)} options={SPOKEN.map((l) => ({ value: l, label: spokenName(l) }))} testId="voice-lang" />
        </Row>
        <Row title={t("voice.set.where")} hint={t("voice.set.whereHint")}>
          <Seg
            label={t("voice.set.where")}
            value={p.prefs.where}
            onChange={(v) => p.onWhere(v as Where)}
            options={[
              { value: "device", label: t("voice.set.device") },
              { value: "apple", label: t("voice.set.apple") },
            ]}
            testId="voice-where"
          />
        </Row>
        <Row title={t("voice.set.voice")} hint={p.voices.length ? t("voice.set.voiceHint") : t("voice.set.noVoice", { lang: spokenName(p.prefs.lang) })}>
          <select className="vc-select" aria-label={t("voice.set.voice")} value={p.prefs.voices[p.prefs.lang] ?? ""} onChange={(e) => p.onVoice(e.target.value)} data-testid="voice-voice">
            <option value="">{t("voice.set.voiceDefault")}</option>
            {p.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Row>
      </div>
      <div className="st-gh">{t("voice.set.works")}</div>
      <div className="st-grp" data-testid="voice-works">
        {!p.statuses ? (
          <Row hint={t("voice.set.checking")} />
        ) : (
          SPOKEN.map((l) => (
            <div key={l} className="st-row" data-testid="voice-works-row" data-lang={l} data-on-device={String(!!p.statuses?.[l]?.onDevice)}>
              <div className="st-k">
                <span>{worksLine(p.statuses?.[l], l)}</span>
              </div>
            </div>
          ))
        )}
        {any && (
          <>
            <Row title={t("voice.set.mic")}>
              <span className="st-val" data-testid="voice-mic-access">
                {t(ACCESS[any.mic])}
              </span>
            </Row>
            <Row title={t("voice.set.speech")}>
              <span className="st-val" data-testid="voice-speech-access">
                {t(ACCESS[any.speech])}
              </span>
            </Row>
          </>
        )}
      </div>
      {thai?.supported && !thai.onDevice && (
        <div className="st-note" data-testid="voice-thai-later">
          {t("voice.set.thaiLater")}
        </div>
      )}
      <div className="st-note">{t("voice.set.asks")}</div>
      <div className="st-note">{t("voice.set.read")}</div>
      <div className="st-note" data-testid="voice-kept">
        {t("voice.set.kept")}
      </div>
    </div>
  );
}

export function VoicePage() {
  const offered = voiceOffered();
  const [prefs, setPrefs] = useState<VoicePrefs>(() => readPrefs());
  const [statuses, setStatuses] = useState<Partial<Record<Spoken, HearStatus>> | null>(null);
  const [voices, setVoices] = useState<MacVoice[]>([]);
  useEffect(() => onPrefs(() => setPrefs(readPrefs())), []);
  // what this Mac can do for each language, read once the page opens (no prompt: nothing is asked)
  useEffect(() => {
    if (!offered) return;
    let live = true;
    const { ears } = getVoiceEngines();
    void Promise.all(SPOKEN.map((l) => ears.status(l).then((s) => [l, s] as const, () => null))).then((rows) => {
      if (!live) return;
      const out: Partial<Record<Spoken, HearStatus>> = {};
      for (const r of rows) if (r) out[r[0]] = r[1];
      setStatuses(out);
    });
    return () => {
      live = false;
    };
  }, [offered]);
  // the Mac's voices come late in a web view: read again when it says they changed
  useEffect(() => {
    if (!offered) return;
    const { mouth } = getVoiceEngines();
    const read = () => setVoices(mouth?.voices() ?? []);
    read();
    const ss = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    ss?.addEventListener?.("voiceschanged", read);
    return () => ss?.removeEventListener?.("voiceschanged", read);
  }, [offered]);
  return (
    <VoiceView
      offered={offered}
      prefs={prefs}
      statuses={statuses}
      voices={voicesFor(voices, prefs.lang)}
      onLang={(lang) => setPrefs(savePrefs({ lang }))}
      onWhere={(where) => setPrefs(savePrefs({ where }))}
      onVoice={(id) => setPrefs(savePrefs({ voices: { ...prefs.voices, [prefs.lang]: id || undefined } }))}
    />
  );
}
