// Header chip: "3 other places", in words only; toggles the Details panel, which lists each place. No other company's
// mark in the header (item 85f, docs/design-audit.md finding 7): Details names the apps.
import type { SlotProps } from "../features";
import { useStore } from "../state/store";
import { sourceList } from "./format";
import "./elsewhere.css";
import { t } from "../i18n";
import { can } from "../runtime";

export const slot = "headerPlaces";

export default function Places({ bot }: SlotProps["headerPlaces"]) {
  const s = useStore();
  const away = s.elsewhere[bot.name] ?? [];
  // a runtime with no sessions in other apps has no chip, whatever an old list in the store says
  if (!can("elsewhere") || away.length === 0) return null;
  const open = s.ui.panelOpen;
  return (
    <button
      type="button"
      className={`ew-places${open ? " on" : ""}`}
      onClick={() => s.togglePanel()}
      aria-expanded={open}
      title={t("pl.where", { bot: bot.display_name, list: sourceList(away.map((a) => a.source)) })}
      data-testid="places"
    >
      <span data-testid="places-label">
        {away.length === 1 ? t("pl.one") : t("pl.many", { n: away.length })}
      </span>
    </button>
  );
}
