// Settings › Worktrees (item 73): how a lane's folder is made and cleaned up. Each lane works in a git worktree of its own
// (docs/code-editor.md, "Where a lane works"); these five rows are the choices T3 Code's Worktrees page has, with Manut AI's
// words and defaults (lib/worktrees.ts says why each default is what it is):
//
// - Where lanes are made: a folder the person chooses. The shell refuses one inside a project's own files, one it cannot write
//   in and one that is too broad, with words that say why. Lanes already made stay where they are.
// - Start from the remote: off by default.
// - Branch prefix: free text, refused with words unless it is one or two lower case words that each end in a slash.
// - Remove a deleted chat's folder (on) and remove a merged lane's folder (off): neither removes a folder with work of its own.
//
// Under them, one project can set its own (ProjectWorktrees.tsx, item 99).
//
// `WorktreesView` draws a given state so a test can draw each one; `WorktreesPage` keeps the form's state and acts.
import { useState, type ReactNode } from "react";
import { Toggle } from "../pages/kit";
import { t, type Key } from "../i18n";
import { getHost } from "../sessions/host";
import { prefixProblem, setWorktreeSettings, useWorktreeSettings, WORKTREE_DEFAULTS, type WorktreeSettings } from "../lib/worktrees";
import { Row } from "./DevRow";
import { ProjectWorktrees } from "./ProjectWorktrees";

export const DEFAULT_LANES_FOLDER = "~/.manut/lanes";

export interface WorktreesViewProps {
  saved: WorktreeSettings;
  /** The prefix as typed, which may not be saved yet. */
  prefixText: string;
  /** Why the chosen folder was refused (a shell code), or null. */
  rootError: string | null;
  onChoose: () => void;
  onReset: () => void;
  onRemote: (on: boolean) => void;
  onPrefixText: (text: string) => void;
  onPrefixSave: () => void;
  onDeleted: (on: boolean) => void;
  onMerged: (on: boolean) => void;
  /** what follows the choices for every project: the part for one project (item 99) */
  children?: ReactNode;
}

/** What a refused folder says: the shell's code, in words; any other failure as the shell said it. */
export function rootWords(code: string): string {
  const key = `worktrees.root.${code}` as Key;
  return ["bad_root", "root_too_broad", "root_in_checkout", "root_unwritable"].includes(code) ? t(key) : code;
}

export function WorktreesView(p: WorktreesViewProps) {
  const problem = prefixProblem(p.prefixText);
  const unchanged = p.prefixText === p.saved.prefix;
  return (
    <div className="st-page" data-testid="worktrees-page">
      <div className="st-gh st-gh0">{t("set.worktrees")}</div>
      <div className="st-grp">
        <Row title={t("worktrees.where.title")} hint={p.rootError ? rootWords(p.rootError) : t("worktrees.where.hint")}>
          <span className="st-pair">
            <span className="st-val mono" data-testid="worktrees-root">
              {p.saved.root || t("worktrees.where.default", { folder: DEFAULT_LANES_FOLDER })}
            </span>
            <button type="button" className="st-btn" onClick={p.onChoose} data-testid="worktrees-choose">
              {t("worktrees.where.choose")}
            </button>
            {p.saved.root && (
              <button type="button" className="st-btn" onClick={p.onReset} data-testid="worktrees-reset">
                {t("worktrees.where.reset")}
              </button>
            )}
          </span>
        </Row>
        <Row title={t("worktrees.remote.title")} hint={t("worktrees.remote.hint")}>
          <Toggle on={p.saved.remote} label={t("worktrees.remote.title")} onChange={p.onRemote} testId="worktrees-remote" />
        </Row>
        <Row title={t("worktrees.prefix.title")} hint={!unchanged && problem ? t(`worktrees.prefix.${problem}` as Key) : t("worktrees.prefix.hint")}>
          <span className="st-pair">
            <input
              type="text"
              className="dev-in"
              value={p.prefixText}
              onChange={(e) => p.onPrefixText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !problem && p.onPrefixSave()}
              aria-label={t("worktrees.prefix.title")}
              aria-invalid={!unchanged && !!problem}
              autoComplete="off"
              spellCheck={false}
              data-testid="worktrees-prefix"
            />
            <button type="button" className="st-btn" disabled={unchanged || !!problem} onClick={p.onPrefixSave} data-testid="worktrees-prefix-save">
              {t("worktrees.prefix.save")}
            </button>
          </span>
        </Row>
      </div>
      <div className="st-gh">{t("worktrees.cleanup")}</div>
      <div className="st-grp">
        <Row title={t("worktrees.deleted.title")} hint={t("worktrees.deleted.hint")}>
          <Toggle on={p.saved.cleanDeleted} label={t("worktrees.deleted.title")} onChange={p.onDeleted} testId="worktrees-deleted" />
        </Row>
        <Row title={t("worktrees.merged.title")} hint={t("worktrees.merged.hint")}>
          <Toggle on={p.saved.cleanMerged} label={t("worktrees.merged.title")} onChange={p.onMerged} testId="worktrees-merged" />
        </Row>
      </div>
      {p.children}
    </div>
  );
}

export function WorktreesPage() {
  const saved = useWorktreeSettings();
  const [prefixText, setPrefixText] = useState(saved.prefix);
  const [rootError, setRootError] = useState<string | null>(null);

  const choose = async () => {
    const host = getHost();
    try {
      const picked = await host.pickFolder(saved.root || "");
      if (!picked) return;
      // the shell checks it and makes it; what it answers is the real path the lanes go under
      const real = host.laneRootCheck ? await host.laneRootCheck(picked) : picked;
      setWorktreeSettings({ root: real });
      setRootError(null);
    } catch (e) {
      setRootError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <WorktreesView
      saved={saved}
      prefixText={prefixText}
      rootError={rootError}
      onChoose={() => void choose()}
      onReset={() => {
        setWorktreeSettings({ root: WORKTREE_DEFAULTS.root });
        setRootError(null);
      }}
      onRemote={(remote) => setWorktreeSettings({ remote })}
      onPrefixText={setPrefixText}
      onPrefixSave={() => {
        if (!prefixProblem(prefixText)) setWorktreeSettings({ prefix: prefixText });
      }}
      onDeleted={(cleanDeleted) => setWorktreeSettings({ cleanDeleted })}
      onMerged={(cleanMerged) => setWorktreeSettings({ cleanMerged })}
    >
      <ProjectWorktrees />
    </WorktreesView>
  );
}
