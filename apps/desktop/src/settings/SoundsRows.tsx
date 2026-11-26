// Settings › General › Sounds and chimes (item 131): the finish chime on or off, the sound a finish makes (Default or one of five
// tones) with Preview, the settle tick and the effort slider's sound. Each is saved on this Mac as it is chosen (src/sound/prefs.ts)
// and starts as GoSpark's does: on, with the Default chime. The app has no tooltip component of its own, so there is no
// tooltip switch to draw (docs/sounds.md).
//
// `SoundsRowsView` draws the given choices so a test can draw each state; `SoundsRows` reads and saves them.
import { useState } from "react";
import { t } from "../i18n";
import { Modes } from "../ui/Modes";
import {
  effortSoundEnabled,
  finishChimeEnabled,
  finishTone,
  previewTone,
  setEffortSoundEnabled,
  setFinishChimeEnabled,
  setFinishTone,
  setSettleSoundEnabled,
  settleSoundEnabled,
  TONES,
  TONE_LABEL,
  warmTone,
  type ToneId,
} from "../sound";
import { Row } from "./DevRow";

export interface SoundsRowsProps {
  finish: boolean;
  tone: ToneId;
  settle: boolean;
  effort: boolean;
  onFinish: (on: boolean) => void;
  onTone: (tone: ToneId) => void;
  onSettle: (on: boolean) => void;
  onEffort: (on: boolean) => void;
  /** Play the chosen sound once, whatever the switches say. */
  onPreview: (tone: ToneId) => void;
}

function OnOff({ on, label, onChange, testId }: { on: boolean; label: string; onChange: (on: boolean) => void; testId: string }) {
  return (
    <Modes
      label={label}
      value={on ? "on" : "off"}
      options={[
        { value: "on", label: t("sounds.on") },
        { value: "off", label: t("sounds.off") },
      ]}
      onChange={(v) => onChange(v === "on")}
      testId={testId}
    />
  );
}

export function SoundsRowsView(p: SoundsRowsProps) {
  return (
    <>
      <Row title={t("sounds.finish")} hint={t("sounds.finishHint")}>
        <OnOff on={p.finish} label={t("sounds.finish")} onChange={p.onFinish} testId="sound-finish-seg" />
      </Row>
      <Row title={t("sounds.tone")} hint={t("sounds.toneHint")}>
        <span className="st-pair">
          <button type="button" className="st-btn" onClick={() => p.onPreview(p.tone)} data-testid="sound-preview">
            {t("sounds.preview")}
          </button>
          <select className="dev-in" value={p.tone} aria-label={t("sounds.tone")} onChange={(e) => p.onTone(e.currentTarget.value as ToneId)} data-testid="sound-tone">
            {TONES.map((id) => (
              <option key={id} value={id}>
                {t(TONE_LABEL[id])}
              </option>
            ))}
          </select>
        </span>
      </Row>
      <Row title={t("sounds.settle")} hint={t("sounds.settleHint")}>
        <OnOff on={p.settle} label={t("sounds.settle")} onChange={p.onSettle} testId="sound-settle-seg" />
      </Row>
      <Row title={t("sounds.effort")} hint={t("sounds.effortHint")}>
        <OnOff on={p.effort} label={t("sounds.effort")} onChange={p.onEffort} testId="sound-effort-seg" />
      </Row>
    </>
  );
}

export function SoundsRows() {
  const [finish, setFinish] = useState(finishChimeEnabled());
  const [tone, setTone] = useState(finishTone());
  const [settle, setSettle] = useState(settleSoundEnabled());
  const [effort, setEffort] = useState(effortSoundEnabled());
  return (
    <SoundsRowsView
      finish={finish}
      tone={tone}
      settle={settle}
      effort={effort}
      onFinish={(on) => (setFinishChimeEnabled(on), setFinish(on))}
      onTone={(id) => {
        setFinishTone(id);
        setTone(id);
        // its file is read now so the next finish does not wait on it; Preview is the person's to press
        void warmTone(id);
      }}
      onSettle={(on) => (setSettleSoundEnabled(on), setSettle(on))}
      onEffort={(on) => (setEffortSoundEnabled(on), setEffort(on))}
      onPreview={(id) => void previewTone(id)}
    />
  );
}
