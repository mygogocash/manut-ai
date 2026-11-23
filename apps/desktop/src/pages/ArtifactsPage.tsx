// Artifacts: what the team makes (pages, posts, sheets, reports) will be listed here, as the design canvas's Tools
// board lists them. The runtime keeps no artifacts yet, so the page says what will show here and shows nothing made up.
import { t } from "../i18n";
import { MenuIcon } from "../sidebar/menuIcons";
import { Empty, MenuPageFrame } from "./MenuPage";

export function ArtifactsPage() {
  return (
    <MenuPageFrame page="artifacts" title={t("menu.artifacts")}>
      <div className="col">
        <Empty icon={<MenuIcon row="artifacts" />} title={t("artifacts.emptyTitle")} text={t("artifacts.emptyText")} testId="artifacts-empty" />
      </div>
    </MenuPageFrame>
  );
}
