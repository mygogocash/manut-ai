// Settings › Developer › Editor (item 107): which editor "Open in" uses. Automatic opens the first one found on this computer, in the
// order of the shell's fixed list; or the person names one of those found. There is no field for a typed command: that would be a way
// to run anything, which needs the design of an ask (docs/decisions.md). `EditorSettingView` draws a given state, so the tests draw
// every one; `EditorSetting` reads the host it is given and saves the choice (code/editor.ts).
import { useEffect } from "react";
import { t } from "../i18n";
import { editorsOf, EDITOR_IDS, setEditorPref, useEditorPref, useEditors, type EditorHost, type EditorInfo } from "../code/editor";
import { Row } from "./DevRow";

const LABEL: Record<string, string> = { vscode: "Visual Studio Code", cursor: "Cursor", windsurf: "Windsurf", zed: "Zed", xcode: "Xcode" };

export interface EditorSettingViewProps {
  /** the editors found here; null until the host has answered */
  installed: EditorInfo[] | null;
  /** "auto" or the id saved */
  pref: string;
  onPick: (id: string) => void;
}

export function EditorSettingView({ installed, pref, onPick }: EditorSettingViewProps) {
  if (installed === null) return null;
  if (installed.length === 0) return <Row title={t("editor.title")} hint={t("editor.none")} />;
  // a saved editor that is not found here: the first found is used, and the row says so
  const gone = pref !== "auto" && !installed.some((e) => e.id === pref) && (EDITOR_IDS as readonly string[]).includes(pref);
  return (
    <Row title={t("editor.title")} hint={gone ? t("editor.gone", { name: LABEL[pref] ?? pref }) : t("editor.hint")}>
      <select className="dev-in" value={gone ? "auto" : pref} aria-label={t("editor.title")} onChange={(e) => onPick(e.currentTarget.value)} data-testid="dev-editor">
        <option value="auto">{t("editor.auto")}</option>
        {installed.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function EditorSetting({ host }: { host: EditorHost }) {
  const installed = useEditors(host);
  const pref = useEditorPref();
  // an editor installed since the app started shows up when this page opens
  useEffect(() => void editorsOf(host, true), [host]);
  return <EditorSettingView installed={installed} pref={pref} onPick={setEditorPref} />;
}
