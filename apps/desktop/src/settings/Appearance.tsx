// Settings > General > Appearance: theme, bubble style, text size, chat width and colours, with a live preview. The colours
// are the brand's look or a theme of the person's own (item 99b: the owner chose full themes on 27 Nov 2026, lifting item
// 85i's "no accent for the person to pick"): one made from the look in force and edited here, or one imported from a VS
// Code theme file. Every choice only changes how manut looks on this computer (saved in localStorage); nothing goes to
// Hermes. A theme whose body or second-line text would read under 4.5 to 1 on one of its backgrounds is refused with the
// ratio and the background (src/theme/themes.ts), when it is imported and on every change.
import { useRef, useState } from "react";
import { useStore, BUBBLE_STYLES, CHAT_WIDTHS, type BubbleStyle, type ChatWidth, type TextSize, type Theme } from "../state/store";
import { useResolvedTheme } from "../app/theme";
import { Modes } from "../ui/Modes";
import { t, tx, type Key } from "../i18n";
import { ratioText } from "../theme/colour";
import { freeName, MAX_THEMES, newThemeId, putTheme, removeTheme, useThemes } from "../theme/library";
import { BRAND_ID, cleanName, copyOf, editKind, fullColors, kindsOf, ROLE_TOKEN, ROLES, withColour, type Band, type Kind, type Role, type Shortfall, type UserTheme } from "../theme/themes";
import { importVsCode, VSCODE_MAX_BYTES, type ImportRefusal } from "../theme/vscode";

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
const WIDTH_NAME: Record<ChatWidth, Key> = { narrow: "look.narrow", medium: "look.medium", wide: "look.wide" };
const opts = <V extends string>(list: { value: V; label: Key }[]) => list.map((o) => ({ value: o.value, label: t(o.label) }));

const BAND_WORD: Record<Band, Key> = {
  "--main": "look.band.main",
  "--side": "look.band.side",
  "--aui-surface": "look.band.surface",
  "--aui-overlay": "look.band.overlay",
  "--soft": "look.band.soft",
  "--aui-subtle": "look.band.subtle",
  "--hov": "look.band.hov",
};

/** Why text misses the rule, in words: which text, the ratio and the background. */
export const shortfallWords = (s: Shortfall): string =>
  t(s.what === "text" ? "look.why.text" : "look.why.muted", { ratio: ratioText(s.ratio), band: t(BAND_WORD[s.band]) });

/** Why a theme was not imported or kept, in words. */
export function refusalWords(why: ImportRefusal | { kind: "read" } | { kind: "many" }): string {
  switch (why.kind) {
    case "big":
      return t("look.why.big");
    case "parse":
      return t("look.why.parse");
    case "noColors":
      return t("look.why.noColors");
    case "noBackground":
      return t("look.why.noBackground");
    case "read":
      return t("look.why.read");
    case "many":
      return t("look.why.many", { n: MAX_THEMES });
    case "contrast":
      return shortfallWords(why.why);
  }
}

const ROLE_NAME: Record<Role, Key> = {
  background: "look.role.background",
  side: "look.role.side",
  text: "look.role.text",
  muted: "look.role.muted",
  accent: "look.role.accent",
  line: "look.role.line",
};
const ROLE_HINT: Record<Role, Key> = {
  background: "look.role.backgroundHint",
  side: "look.role.sideHint",
  text: "look.role.textHint",
  muted: "look.role.mutedHint",
  accent: "look.role.accentHint",
  line: "look.role.lineHint",
};

type Note = { text: string; bad: boolean } | null;

export function Appearance() {
  const s = useStore();
  const look = s.ui.look;
  const mode = useResolvedTheme(s.ui.theme);
  const themes = useThemes();
  const picked = themes.find((th) => th.id === look.palette) ?? null;
  const [note, setNote] = useState<Note>(null);
  const file = useRef<HTMLInputElement>(null);

  /** Draw a theme (null: the brand's). A theme of one kind is drawn in it, so the app's Theme follows it there. */
  const show = (th: UserTheme | null) => {
    s.setLook({ palette: th ? th.id : BRAND_ID });
    const kinds = th ? kindsOf(th) : [];
    if (kinds.length === 1 && kinds[0] !== mode) s.setTheme(kinds[0]!);
  };
  const keep = (th: UserTheme, done: string) => {
    const r = putTheme(th);
    if (!r.ok) return setNote({ text: t("look.notChanged", { why: refusalWords({ kind: r.why === "many" ? "many" : "parse" }) }), bad: true });
    show(th);
    setNote({ text: done, bad: false });
  };
  const make = () => {
    const name = freeName(picked ? t("look.copyName", { name: picked.name }) : t("look.mine"));
    keep(copyOf(picked, newThemeId(), name), t("look.made", { name }));
  };
  const bring = async (f: File | undefined) => {
    if (!f) return;
    const refuse = (why: Parameters<typeof refusalWords>[0]) => setNote({ text: t("look.notImported", { why: refusalWords(why) }), bad: true });
    // the size first, so a file that is not a theme is never read whole
    if (f.size > VSCODE_MAX_BYTES) return refuse({ kind: "big" });
    let text: string;
    try {
      text = await f.text();
    } catch {
      return refuse({ kind: "read" });
    }
    const r = importVsCode(text, f.name);
    if (!r.ok) return refuse(r.why);
    const name = freeName(r.theme.name);
    const th: UserTheme = { id: newThemeId(), name, from: "vscode", [r.theme.kind]: r.theme.colors, ...(r.theme.term ? { term: r.theme.term } : {}) };
    if (themes.length >= MAX_THEMES) return refuse({ kind: "many" });
    keep(th, t("look.imported", { name, n: r.theme.read }));
  };

  const only = picked && kindsOf(picked).length === 1 ? kindsOf(picked)[0] : null;
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
        <div className="st-row">
          <div className="st-k">
            <b>{t("look.width")}</b>
            <span>{t("look.widthHint")}</span>
          </div>
          <div className="st-v">
            <Modes
              label={t("look.width")}
              value={look.width}
              options={CHAT_WIDTHS.map((w) => ({ value: w, label: t(WIDTH_NAME[w]) }))}
              onChange={(v) => s.setLook({ width: v as ChatWidth })}
              testId="width-seg"
            />
          </div>
        </div>
        <div className="st-row">
          <div className="st-k">
            <b>{t("look.colours")}</b>
            <span data-testid="colours-hint">{t(only === "dark" ? "look.onlyDark" : only === "light" ? "look.onlyLight" : "look.coloursHint")}</span>
          </div>
          <div className="st-v">
            <select
              className="dev-in"
              value={picked ? picked.id : BRAND_ID}
              aria-label={t("look.colours")}
              onChange={(e) => {
                setNote(null);
                show(themes.find((th) => th.id === e.currentTarget.value) ?? null);
              }}
              data-testid="theme-pick"
            >
              <option value={BRAND_ID}>{t("look.brand")}</option>
              {themes.map((th) => (
                <option key={th.id} value={th.id}>
                  {th.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="st-row ap-acts">
          {note ? (
            <span className={`ap-note${note.bad ? " bad" : ""}`} role={note.bad ? "alert" : "status"} data-testid="theme-note">
              {note.text}
            </span>
          ) : (
            <span />
          )}
          <div className="st-pair">
            <button type="button" className="st-btn" onClick={make} data-testid="theme-make">
              {t("look.make")}
            </button>
            <button type="button" className="st-btn" onClick={() => file.current?.click()} data-testid="theme-import">
              {t("look.import")}
            </button>
            <input
              ref={file}
              type="file"
              accept=".json,.jsonc,application/json"
              hidden
              data-testid="theme-file"
              onChange={(e) => {
                void bring(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        {picked && (
          <ThemeEditor
            key={picked.id}
            theme={picked}
            mode={mode}
            onDeleted={() => {
              removeTheme(picked.id);
              s.setLook({ palette: BRAND_ID });
              setNote({ text: t("look.deleted", { name: picked.name }), bad: false });
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The person's own theme: its name, its six main colours for the kind being changed, and Delete. */
function ThemeEditor({ theme, mode, onDeleted }: { theme: UserTheme; mode: Kind; onDeleted: () => void }) {
  const kind = editKind(theme, mode);
  const full = fullColors(kind, theme[kind] ?? {});
  // the editor is drawn again for each theme (its key), and only this field renames it, so the field holds the name
  const [name, setName] = useState(theme.name);
  const [asking, setAsking] = useState(false);
  const rename = () => {
    const next = cleanName(name);
    if (next && next !== theme.name) putTheme({ ...theme, name: next });
    setName(next || theme.name);
  };
  return (
    <div className="ap-edit" data-testid="theme-editor" data-kind={kind}>
      <div className="st-row">
        <div className="st-k">
          <b>{t("look.name")}</b>
          <span>{kindsOf(theme).length > 1 ? t(kind === "dark" ? "look.editsDark" : "look.editsLight") : t("look.nameHint")}</span>
        </div>
        <div className="st-v">
          <input
            className="dev-in"
            value={name}
            maxLength={60}
            aria-label={t("look.name")}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
              if (e.key === "Escape") setName(theme.name);
            }}
            data-testid="theme-name"
          />
        </div>
      </div>
      {ROLES.map((role) => (
        <ColourRow key={role} theme={theme} kind={kind} role={role} value={full[ROLE_TOKEN[role]]} />
      ))}
      <div className="st-row">
        {asking ? (
          <>
            <div className="st-k">
              <b>{t("look.deleteAsk", { name: theme.name })}</b>
            </div>
            <div className="st-pair">
              <button type="button" className="st-btn" onClick={() => setAsking(false)} data-testid="theme-delete-no">
                {t("look.deleteNo")}
              </button>
              <button type="button" className="st-btn danger" onClick={onDeleted} data-testid="theme-delete-yes">
                {t("look.deleteYes")}
              </button>
            </div>
          </>
        ) : (
          <>
            <span />
            <button type="button" className="st-btn danger" onClick={() => setAsking(true)} data-testid="theme-delete">
              {t("look.delete")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** One main colour. A pick that would put text under the rule is refused: the theme keeps its colour, and the row says why
 *  until a pick is kept. The field shows the pick being made until it leaves the field, then the theme's colour again. */
function ColourRow({ theme, kind, role, value }: { theme: UserTheme; kind: Kind; role: Role; value: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const change = (v: string) => {
    setDraft(v);
    const r = withColour(theme, kind, role, v);
    if (!r.ok) return setWhy(t("look.notChanged", { why: shortfallWords(r.why) }));
    setWhy(null);
    putTheme(r.theme);
  };
  return (
    <div className="st-row">
      <div className="st-k">
        <b>{t(ROLE_NAME[role])}</b>
        {why ? (
          <span className="dev-err" role="alert" data-testid={`theme-err-${role}`}>
            {why}
          </span>
        ) : (
          <span>{t(ROLE_HINT[role])}</span>
        )}
      </div>
      <div className="st-v">
        <input
          type="color"
          className="ap-colour"
          value={draft ?? value}
          aria-label={t(ROLE_NAME[role])}
          onChange={(e) => change(e.currentTarget.value)}
          onBlur={() => setDraft(null)}
          data-testid={`theme-colour-${role}`}
        />
      </div>
    </div>
  );
}
