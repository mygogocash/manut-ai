// Settings › Computer › Snapshot of any app (item 104, src/computer/snapshot.ts): the key is off until the person turns
// it on here, and only then does the shell register it with macOS (src-tauri/src/computer/snap.rs). The keys box shows the
// suggested keys, which the person can take as they are or change by pressing others; a press of two of Control, Option
// and Command with a letter or a digit sets them. One line says where the key stands: off, on, taken by another app or
// macOS, or why those keys cannot be used. A picture of the window is a second switch, off too. What is read, and what
// never is, is said under them.
//
// `SnapshotRowsView` draws a given state so a test can draw each one (SnapshotRows.test.tsx); `SnapshotRows` reads and
// changes it through the shell.
import { useCallback, useEffect, useState } from "react";
import { t, type Key } from "../i18n";
import { Modes } from "../ui/Modes";
import { getSnapShell, keysFromEvent, type SnapState } from "../computer/snapshot";
import { Row } from "./DevRow";
import "../computer/snapshot.css";

export interface SnapshotRowsProps {
  /** Where the key stands; null while it is read, or when it could not be. */
  state: SnapState | null;
  /** macOS has given Manut AI Accessibility (Settings › Computer's own read). */
  accessibility: boolean | undefined;
  onOn: (on: boolean) => void;
  onKeys: (keys: string) => void;
  onPicture: (on: boolean) => void;
}

/** The line under the keys: where the key stands, in words. */
export function statusText(s: SnapState): string {
  if (s.status === "on") return t("snap.status.on", { keys: s.shown });
  if (s.status === "taken") return t("snap.status.taken", { keys: s.shown });
  if (s.why) return t(`snap.why.${s.why}` as Key, { keys: s.shown });
  return t("snap.status.off", { keys: s.shown });
}

export function SnapshotRowsView(p: SnapshotRowsProps) {
  const s = p.state;
  const onOff = (on: boolean, label: string, change: (on: boolean) => void, testId: string) => (
    <Modes
      label={label}
      value={on ? "on" : "off"}
      options={[
        { value: "on", label: t("snap.on") },
        { value: "off", label: t("snap.off") },
      ]}
      onChange={(v) => change(v === "on")}
      disabled={!s}
      testId={testId}
    />
  );
  return (
    <>
      <div className="st-gh">{t("snap.title")}</div>
      <div className="st-grp" data-testid="snap-rows">
        <Row title={t("snap.key")} hint={t("snap.keyHint")}>
          {onOff(!!s?.on, t("snap.key"), p.onOn, "snap-onoff")}
        </Row>
        <Row title={t("snap.keys")} hint={t("snap.keysHint")}>
          <span className="st-pair">
            {s && s.keys !== s.suggested && (
              <button type="button" className="st-btn" onClick={() => p.onKeys(s.suggested)} data-testid="snap-suggest">
                {t("snap.suggest", { keys: s.suggestedShown })}
              </button>
            )}
            <input
              className="dev-in snap-keys"
              type="text"
              readOnly
              value={s?.shown ?? ""}
              aria-label={t("snap.keysAria")}
              disabled={!s}
              onKeyDown={(e) => {
                // Tab still moves on; any other key is the person setting the keys, never typed into the box
                if (e.key === "Tab") return;
                e.preventDefault();
                const keys = keysFromEvent(e);
                if (keys) p.onKeys(keys);
              }}
              data-testid="snap-keys"
            />
          </span>
        </Row>
        <Row title={t("snap.picture")} hint={t("snap.pictureHint")}>
          {onOff(!!s?.picture, t("snap.picture"), p.onPicture, "snap-picture")}
        </Row>
      </div>
      {s && (
        <div className="st-note" data-testid="snap-status" data-status={s.status} role="status">
          {statusText(s)}
        </div>
      )}
      {p.accessibility === false && (
        <div className="st-note" data-testid="snap-needs">
          {t("snap.needs")}
        </div>
      )}
      <div className="st-note" data-testid="snap-what">
        {t("snap.what")}
      </div>
    </>
  );
}

export function SnapshotRows({ accessibility }: { accessibility: boolean | undefined }) {
  const [state, setState] = useState<SnapState | null>(null);
  useEffect(() => {
    void getSnapShell()
      .settings()
      .then(setState, () => setState(null));
  }, []);
  const change = useCallback(
    (next: Partial<{ on: boolean; keys: string; picture: boolean }>) => {
      if (!state) return;
      void getSnapShell()
        .set({ on: state.on, keys: state.keys, picture: state.picture, ...next })
        .then(setState, () => undefined);
    },
    [state],
  );
  return <SnapshotRowsView state={state} accessibility={accessibility} onOn={(on) => change({ on })} onKeys={(keys) => change({ keys })} onPicture={(picture) => change({ picture })} />;
}
