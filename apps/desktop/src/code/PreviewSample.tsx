// "The preview has no shop ID yet, so the QR code is a sample." with Add the shop ID (the canvas's StatesCodeDev board, "No
// secret in the preview"): the Code page says which secrets the project's code reads that a preview would run on a sample,
// and that adding one has to wait for the vault. `PreviewSampleView` takes everything it shows as props and uses no hooks,
// so a test can draw it; `PreviewSample` reads the project's sessions.
import "./kit.css";
import { useState } from "react";
import { t, type Key } from "../i18n";
import { useSessions } from "../sessions/sessions";
import { needsOfProject, onSample, sessionsWithNeeds, usePreviewVersion, type Need } from "./preview";

export interface PreviewSampleProps {
  needs: Need[];
  /** The secret whose Add was pressed: the vault's note shows under it. */
  asked: string | null;
  onAdd: (name: string) => void;
  /** Without the band that names it, for a place that says so itself (the pane beside a lane, under its Preview). */
  bare?: boolean;
}

export function PreviewSampleView({ needs, asked, onAdd, bare = false }: PreviewSampleProps) {
  if (!needs.length) return null;
  return (
    <>
      {!bare && (
        <div className="band">
          <span>{t("kit.sample.title")}</span>
        </div>
      )}
      {needs.map((n) => (
        <div key={n.name} data-testid="kit-sample">
          <div className="rowl">
            <span className="tag">{t("kit.sample.tag")}</span>
            <span className="grow">{n.kind === "shop_id" ? t("kit.sample.shop_id") : t("kit.sample.key", { name: n.name })}</span>
            <button type="button" className="lk" onClick={() => onAdd(n.name)} data-testid="kit-sample-add">
              {t(`kit.sample.add.${n.kind}` satisfies Key)}
            </button>
          </div>
          {asked === n.name && (
            <p className="mut" role="status" data-testid="kit-sample-vault">
              {t("kit.sample.vault")}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

export function PreviewSample({ root }: { root: string }) {
  const ss = useSessions();
  usePreviewVersion();
  const [asked, setAsked] = useState<string | null>(null);
  // The owner can add none yet (there is no vault), so every secret the project reads is still on its sample.
  const needs = onSample(needsOfProject(root, sessionsWithNeeds(), ss.list));
  return <PreviewSampleView needs={needs} asked={asked} onAdd={setAsked} />;
}
