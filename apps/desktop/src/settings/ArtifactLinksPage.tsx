// Settings › Artifacts (item 83), the page the owner showed from another app, in Manut AI's words: share HTML and Markdown files with
// the team and manage their public links. One switch, Allow publishing public artifact links, off by default (lib/artifactLinks.ts
// says what it stops), and the three steps: choose a file to share or ask an agent to share it, copy the public link, manage it.
// Every link is still asked first on the Artifacts page; this switch only decides whether anything is offered or sent at all.
//
// `ArtifactLinksView` draws a given state so a test can draw it; `ArtifactLinksPage` reads and saves the switch.
import { t } from "../i18n";
import { setArtifactSettings, useArtifactSettings } from "../lib/artifactLinks";
import { Toggle } from "../pages/kit";
import { getStore } from "../state/store";
import { Row } from "./DevRow";

export function ArtifactLinksView({ publish, onPublish, onOpen }: { publish: boolean; onPublish: (on: boolean) => void; onOpen: () => void }) {
  return (
    <div className="st-page" data-testid="artifact-links-page">
      <div className="st-gh st-gh0">{t("set.artifacts")}</div>
      <div className="st-note">{t("art.set.intro")}</div>
      <div className="st-grp">
        <Row title={t("art.set.publish")} hint={t("art.set.publishHint")}>
          <Toggle on={publish} label={t("art.set.publish")} onChange={onPublish} testId="art-set-publish" />
        </Row>
      </div>
      <div className="st-gh">{t("art.set.how")}</div>
      <div className="st-grp">
        <Row title={t("art.set.step1")} hint={t("art.set.step1Hint")} />
        <Row title={t("art.set.step2")} hint={t("art.set.step2Hint")} />
        <Row title={t("art.set.step3")} hint={t("art.set.step3Hint")} />
      </div>
      <div className="st-note">
        <button type="button" className="st-btn" onClick={onOpen} data-testid="art-set-open">
          {t("art.set.open")}
        </button>
      </div>
    </div>
  );
}

export function ArtifactLinksPage() {
  const saved = useArtifactSettings();
  return <ArtifactLinksView publish={saved.publish} onPublish={(publish) => setArtifactSettings({ publish })} onOpen={() => getStore().actions.openPage("artifacts")} />;
}
