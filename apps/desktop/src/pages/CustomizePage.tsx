// Customize: what shapes how the team works. The design canvas's Customize board (Brain.dc.html) holds what the team
// knows, its routines and its connections; the runtime keeps none of that yet, so the page says what will show here.
// The existing Automations and Plugins pages are its entries when the runtime offers them (`can("automations")`,
// `can("plugins")`), as the sidebar's foot offered them before; they keep the sidebar's test ids.
import { t } from "../i18n";
import { can } from "../runtime";
import { useStore } from "../state/store";
import { MenuIcon, OnGlyph } from "../sidebar/menuIcons";
import { Empty, MenuPageFrame } from "./MenuPage";

export function CustomizeView({
  automations,
  plugins,
}: {
  /** offered: how many scheduled jobs there are, and the page's opener */
  automations?: { count: number; open: () => void };
  /** offered: the page's opener */
  plugins?: { open: () => void };
}) {
  return (
    <MenuPageFrame page="customize" title={t("menu.customize")}>
      <div className="col">
        {(automations || plugins) && (
          <ul className="rows">
            {automations && (
              <li>
                <button type="button" className="rowl" onClick={automations.open} data-testid="nav-automations">
                  <span className="grow">
                    <span className="l1">{t("nav.automations")}</span>
                    <span className="l2">{t("customize.automations")}</span>
                  </span>
                  {automations.count > 0 && <span className="when">{automations.count}</span>}
                  <OnGlyph />
                </button>
              </li>
            )}
            {plugins && (
              <li>
                <button type="button" className="rowl" onClick={plugins.open} data-testid="nav-plugins">
                  <span className="grow">
                    <span className="l1">{t("nav.plugins")}</span>
                    <span className="l2">{t("customize.plugins")}</span>
                  </span>
                  <OnGlyph />
                </button>
              </li>
            )}
          </ul>
        )}
        <Empty icon={<MenuIcon row="customize" />} title={t("customize.emptyTitle")} text={t("customize.emptyText")} testId="customize-empty" />
      </div>
    </MenuPageFrame>
  );
}

export function CustomizePage() {
  const s = useStore();
  return (
    <CustomizeView
      automations={can("automations") ? { count: s.automations?.length ?? 0, open: () => s.openAutomations() } : undefined}
      plugins={can("plugins") ? { open: () => s.openPlugins() } : undefined}
    />
  );
}
