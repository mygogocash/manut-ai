// Home's mode at the top left, as ChatGPT names its model there (the owner, 27 Nov 2026): "Manut AI · Team ⌄" opens a short
// menu of the modes, each with what it does (Ask Buddy something, Give the team a job, Ask Kit to build something) and a tick
// on the one in use. Picking one is what the box's mode was; the menu closes on a pick, a click outside or Esc, and the focus
// goes back to the button. Only the modes the team can take are offered (home.ts `offeredModes`).
import { useRef, useState } from "react";
import { t } from "../i18n";
import { Icon } from "../ui/icons";
import { Popover } from "../ui/Popover";
import { MODE_WORDS, type HomeMode } from "./home";

export function ModePicker({ mode, modes, onMode }: { mode: HomeMode; modes: readonly HomeMode[]; onMode: (m: HomeMode) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className="mpick">
      <button
        ref={button}
        type="button"
        className="mpick-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("home.modePick", { mode: t(MODE_WORDS[mode].label) })}
        onClick={() => setOpen((o) => !o)}
        data-testid="home-mode-pick"
      >
        <span className="mpick-brand">{t("home.brand")}</span>
        <span className="mpick-mode" data-testid="home-mode-now">
          {t(MODE_WORDS[mode].label)}
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
      <Popover open={open} onClose={close} align="left" width={280} label={t("home.where")}>
        <ModeMenu
          mode={mode}
          modes={modes}
          onPick={(m) => {
            onMode(m);
            close();
          }}
        />
      </Popover>
    </div>
  );
}

/** The menu's modes, each with what it does and a tick on the one in use; drawn apart so a test can draw it. */
export function ModeMenu({ mode, modes, onPick }: { mode: HomeMode; modes: readonly HomeMode[]; onPick: (m: HomeMode) => void }) {
  return (
    <div role="menu" aria-label={t("home.where")} className="mpick-menu">
      {modes.map((m) => (
        <button key={m} type="button" role="menuitemradio" aria-checked={m === mode} className="mpick-item" onClick={() => onPick(m)} data-testid={`home-mode-${m}`}>
          <span className="mpick-text">
            <span className="mpick-name">{t(MODE_WORDS[m].label)}</span>
            <span className="mpick-what">{t(MODE_WORDS[m].title)}</span>
          </span>
          {m === mode && <Icon name="check" size={14} />}
        </button>
      ))}
    </div>
  );
}
