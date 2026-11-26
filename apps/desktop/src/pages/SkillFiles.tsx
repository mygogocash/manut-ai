// Every file of a bundle of skills, before it is published (the Artifacts page) or installed (Settings › MCP and Skills), item 84.
// Each file shows its path and size, a script or program is marked (by its ending, a `#!` first line or its executable bit), and
// View opens its text, as written, in a plain block: nothing in a file is ever drawn as a page. Opening a file counts it as looked
// at (fileReview.ts); the tick "I have looked at every file" counts them all. While neither is done the list says so, and the ask's
// Yes stays held back.
import { t } from "../i18n";
import { sizeText } from "./artifacts";
import { isScript } from "../runtime/skillBundle";
import type { FileReview } from "../runtime/fileReview";
import "./skillFiles.css";

export interface ShownSkill {
  name: string;
  files: readonly { path: string; text: string; exec?: boolean }[];
}

export interface SkillFilesProps {
  skills: readonly ShownSkill[];
  /** the ask's record of what was looked at; null shows the files with no tick */
  review: Pick<FileReview, "opened" | "lookedAtAll" | "done"> | null;
  /** the file whose text is open, as `skill/path` */
  shown: string | null;
  onView: (key: string) => void;
  onTick: (on: boolean) => void;
  /** the buttons' class on this surface (`btn ghost` on a menu page, `st-btn` in Settings) */
  buttonClass: string;
  busy?: boolean;
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

export function SkillFiles(p: SkillFilesProps) {
  return (
    <div className="skl-files" data-testid="skl-files">
      {p.skills.map((s) => (
        <section key={s.name} aria-label={s.name}>
          <div className="skl-skill">{s.name}</div>
          <ul className="skl-list">
            {s.files.map((f) => {
              const key = `${s.name}/${f.path}`;
              const script = isScript(f.path, f.text, f.exec);
              const open = p.shown === key;
              return (
                <li key={key} className="skl-file" data-testid="skl-file" data-path={key} data-script={script ? "1" : "0"} data-opened={p.review?.opened(key) ? "1" : "0"}>
                  <div className="skl-row">
                    <span className="skl-path">{f.path}</span>
                    {script && (
                      <span className="skl-tag" data-testid="skl-script">
                        {t("skl.script")}
                      </span>
                    )}
                    <span className="skl-size">{sizeText(bytesOf(f.text))}</span>
                    <button type="button" className={p.buttonClass} aria-expanded={open} aria-label={`${open ? t("skl.hide") : t("skl.view")}: ${key}`} onClick={() => p.onView(key)} data-testid="skl-view">
                      {open ? t("skl.hide") : t("skl.view")}
                    </button>
                  </div>
                  {open && (
                    <pre className="skl-text" data-testid="skl-text">
                      {f.text}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {p.review && (
        <label className="skl-tick">
          <input type="checkbox" checked={p.review.lookedAtAll} disabled={p.busy} onChange={(e) => p.onTick(e.currentTarget.checked)} data-testid="skl-tick" />
          <span>{t("skl.tick")}</span>
        </label>
      )}
      {p.review && !p.review.done && (
        <p className="skl-wait" data-testid="skl-wait">
          {t("skl.wait")}
        </p>
      )}
    </div>
  );
}
