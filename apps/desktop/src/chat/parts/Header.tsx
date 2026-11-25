import type { Bot } from "../../lib/protocol";
import type { Chat } from "../../state/store";
import { useStore } from "../../state/store";
import { slots } from "../../features";
import { Avatar, Pill } from "../../ui";
import { isMac } from "../../app/shortcuts";
import { reasoningLabel } from "../model/levels";
import { t } from "../../i18n";
import { PanelButton } from "./PanelButton";

export { reasoningLabel };

/** Header: avatar + name (toggles Details), the places chip slot, and on the right the model control plus the
 *  right panel's button. `noModel`: the chat box holds the model (a chat through the person's own agent, item 80). */
export function Header({ bot, chat, noModel = false }: { bot: Bot; chat: Chat | undefined; noModel?: boolean }) {
  const s = useStore();
  const Places = slots.headerPlaces;
  const Picker = slots.modelPicker;
  const model = chat?.model || bot.model;
  const reasoning = reasoningLabel(chat?.reasoning ?? "");
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
        {noModel ? null : Picker ? (
          <Picker bot={bot} chat={chat} />
        ) : (
          <Pill as="span" className="model-pill">
            <span data-testid="model-label" title={model}>
              {model}
            </span>
            {reasoning && (
              <>
                <span className="sep" />
                <span className="eff">{reasoning}</span>
              </>
            )}
          </Pill>
        )}
        <PanelButton bot={bot} />
      </div>
    </header>
  );
}
