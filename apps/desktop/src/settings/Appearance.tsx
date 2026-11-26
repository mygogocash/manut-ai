// Settings > General > Appearance: theme, bubble style and text size, with a live preview. There is no colour to pick:
// the brand's colours are everyone's ("no accent for the person to pick", docs/design-audit.md, item 85i).
// The choices only change how manut looks on this computer (saved in localStorage); nothing goes to Hermes.
import { useStore, BUBBLE_STYLES, type BubbleStyle, type TextSize, type Theme } from "../state/store";
import { Modes } from "../ui/Modes";
import { t, tx, type Key } from "../i18n";

const BUBBLE_NAME: Record<BubbleStyle, Key> = { soft: "look.soft", solid: "look.solid", open: "look.open" };
const BUBBLE_HINT: Record<BubbleStyle, Key> = { soft: "look.softHint", solid: "look.solidHint", open: "look.openHint" };
const THEMES: { value: Theme; label: Key }[] = [
  { value: "system", label: "look.system" },
  { value: "dark", label: "look.dark" },
  { value: "light", label: "look.light" },
];
const SIZES: { value: TextSize; label: Key }[] = [
  { value: "small", label: "look.small" },
  { value: "medium", label: "look.medium" },
  { value: "large", label: "look.large" },
];
const opts = <V extends string>(list: { value: V; label: Key }[]) => list.map((o) => ({ value: o.value, label: t(o.label) }));

export function Appearance() {
  const s = useStore();
  const look = s.ui.look;
  return (
    <div className="ap" data-testid="appearance">
      <div className="ap-preview" aria-hidden="true" data-testid="appearance-preview">
        <div className="msg u">
          <div className="b">{t("look.pvAsk")}</div>
        </div>
        <div className="msg a">
          <div className="b md">
            <p>{tx("look.pvAnswer", { path: <code>/v1/responses</code>, link: <a href="#preview">{t("look.pvLink")}</a> })}</p>
          </div>
        </div>
        <div className="ap-pv-foot">
          <span className="ap-pv-chip">/plan</span>
          <span className="ap-pv-dot" />
          <span className="ap-pv-send">↑</span>
        </div>
      </div>

      <div className="st-grp">
        <div className="st-row">
          <div className="st-k">
            <b>{t("look.theme")}</b>
            <span>{t("look.themeHint")}</span>
          </div>
          <div className="st-v">
            <Modes label={t("look.theme")} value={s.ui.theme} options={opts(THEMES)} onChange={(v) => s.setTheme(v as Theme)} testId="theme-seg" />
          </div>
        </div>
        <div className="st-row">
          <div className="st-k">
            <b>{t("look.bubbles")}</b>
            <span data-testid="bubbles-hint">{t(BUBBLE_HINT[look.bubbles])}</span>
          </div>
          <div className="st-v">
            <Modes
              label={t("look.bubbles")}
              value={look.bubbles}
              options={BUBBLE_STYLES.map((b) => ({ value: b, label: t(BUBBLE_NAME[b]) }))}
              onChange={(b) => s.setLook({ bubbles: b as BubbleStyle })}
              testId="bubbles-seg"
            />
          </div>
        </div>
        <div className="st-row">
          <div className="st-k">
            <b>{t("look.size")}</b>
            <span>{t("look.sizeHint")}</span>
          </div>
          <div className="st-v">
            <Modes
              label={t("look.size")}
              value={look.text}
              options={opts(SIZES)}
              onChange={(v) => s.setLook({ text: v as TextSize })}
              testId="text-seg"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
