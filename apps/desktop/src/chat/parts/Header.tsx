import type { Bot } from "../../lib/protocol";
import { useStore } from "../../state/store";
import { slots } from "../../features";
import { Avatar } from "../../ui";
import { isMac } from "../../app/shortcuts";
import { reasoningLabel } from "../model/levels";
import { t } from "../../i18n";
import { PanelButton } from "./PanelButton";

export { reasoningLabel };

/** Header: avatar + name (toggles Details), the places chip slot, and on the right the right panel's button. No model
 *  and no other company's mark here (item 85f, docs/design-audit.md finding 7): the model and its effort are in the
 *  chat box, where item 80 put Buddy's, and what the member runs on is told in Details. */
export function Header({ bot }: { bot: Bot }) {
  const s = useStore();
  const Places = slots.headerPlaces;
  return (
    <header className="head" data-testid="header">
      <button
        type="button"
        className="who-btn"
        onClick={() => s.togglePanel()}
        aria-expanded={s.ui.panelOpen}
        title={t("head.details", { key: isMac() ? "⌘." : "Ctrl+." })}
        data-testid="who"
      >
        <Avatar bot={bot.name} size={26} />
        <span className="head-title">{bot.display_name}</span>
      </button>
      {Places && <Places bot={bot} />}
      <div className="head-right" data-testid="head-right">
        <PanelButton bot={bot} />
      </div>
    </header>
  );
}
