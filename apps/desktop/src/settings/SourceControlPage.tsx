// Settings › Source control (item 75), the page T3 Code's Source control and issues page showed the owner, in Manut AI's words:
//
// - Version control: git, with its version, or that it is not on this computer.
// - Source control providers: GitHub's CLI (gh) and GitLab's (glab), each with whether it is here, its version, and who is signed
//   in (names only), read through the runners Tasks already uses (src-tauri/src/source_tools.rs). Nothing is installed or signed
//   in from here: a CLI that is missing or signed out says how, in the CLI's own words, in a terminal (`gh auth login`).
// - Repositories: Automatically pull (off by default; lib/sourceControl.ts says why), which keeps a project's default branch
//   current only when its checkout is clean, by a fast-forward (src-tauri/src/git_pull.rs, code/AutoPull.tsx); and Default merge
//   method, what a merge's ask starts with ("the last one I chose" by default). Every merge is still asked (code/Review.tsx).
// - Remove agent credits when merging (off by default): the recognised lines, fixed in `src/lib/agentCredits.json` and shown here
//   as they are, go from the message the app proposes for a merge; every human co-author stays (src-tauri/src/credits.rs).
//
// `SourceControlView` draws a given state so a test can draw each one; `SourceControlPage` reads the shell and acts.
import { useCallback, useEffect, useState } from "react";
import { t, type Key } from "../i18n";
import { getHost } from "../sessions/host";
import { MERGE_METHODS, type MergeMethod, type SourceTool, type SourceTools } from "../code/source";
import { setSourceSettings, SOURCE_DEFAULTS, useSourceSettings, type SourceSettings } from "../lib/sourceControl";
import { Toggle } from "../pages/kit";
import { Row } from "./DevRow";
import CREDITS from "../lib/agentCredits.json";

export interface SourceControlViewProps {
  /** What the shell read; null while it reads, or where nothing can be read (a plain browser with no stand-in). */
  tools: SourceTools | null;
  /** The read failed. */
  failed?: boolean;
  onCheck: () => void;
  /** The page's own choices, saved on this computer. */
  saved?: SourceSettings;
  onAutoPull?: (on: boolean) => void;
  onMergeMethod?: (method: MergeMethod | "last") => void;
  onDropCredits?: (on: boolean) => void;
}

/** The two CLIs, with the words each one's rows use. */
const CLIS = [
  { id: "github", name: "src.github", program: "gh", login: "gh auth login", site: "cli.github.com" },
  { id: "gitlab", name: "src.gitlab", program: "glab", login: "glab auth login", site: "gitlab.com/gitlab-org/cli" },
] as const;

/** What a CLI's row says: missing (with where to get it and how to sign in), signed out (how to sign in), or its version and
 *  the accounts by name, the one the CLI uses now first. */
export function cliLine(tool: SourceTool, cli: (typeof CLIS)[number]): string {
  if (!tool.installed) return t("src.cli.missing", { program: cli.program, site: cli.site, login: cli.login });
  const version = tool.version ? t("src.version", { version: tool.version }) : t("src.versionUnknown");
  if (!tool.signedIn) return t("src.cli.signedOut", { program: cli.program, version, login: cli.login });
  if (tool.accounts.length === 0) return t("src.cli.signedInNoName", { program: cli.program, version });
  return t("src.cli.signedIn", { program: cli.program, version, names: accountNames(tool) });
}

/** The accounts as one line: `octocat`, `ana (ghe.example.com)`, the one in use first. */
export function accountNames(tool: SourceTool): string {
  return [...tool.accounts]
    .sort((a, b) => Number(b.active) - Number(a.active))
    .map((a) => (a.host ? `${a.name} (${a.host})` : a.name))
    .join(", ");
}

/** The short word at the right of a row. */
function stateWord(tool: SourceTool, cli: boolean): Key {
  if (!tool.installed) return "src.state.missing";
  if (cli && !tool.signedIn) return "src.state.signedOut";
  return cli ? "src.state.signedIn" : "src.state.available";
}

export function SourceControlView(p: SourceControlViewProps) {
  const tools = p.tools;
  const saved = p.saved ?? SOURCE_DEFAULTS;
  const reading = !tools;
  const value = (tool: SourceTool | undefined, cli: boolean, id: string) => (
    <span className="st-val" data-testid={`src-${id}-state`} data-ok={tool ? String(tool.installed && (!cli || !!tool.signedIn)) : ""}>
      {tool && <i className={`st-dot ${tool.installed && (!cli || tool.signedIn) ? "online" : "offline"}`} aria-hidden="true" />}
      {tool ? t(stateWord(tool, cli)) : t("src.reading")}
    </span>
  );
  return (
    <div className="st-page" data-testid="source-page">
      <div className="st-gh st-gh0">{t("set.source")}</div>
      <div className="st-gh">{t("src.vcs")}</div>
      <div className="st-grp">
        <Row
          title={t("src.git")}
          hint={
            tools
              ? tools.git.installed
                ? t("src.git.here", { version: tools.git.version ? t("src.version", { version: tools.git.version }) : t("src.versionUnknown") })
                : t("src.git.missing")
              : p.failed
                ? t("src.failed")
                : t("src.reading")
          }
        >
          {value(tools?.git, false, "git")}
        </Row>
      </div>
      <div className="st-gh">{t("src.providers")}</div>
      <div className="st-grp" data-testid="src-providers">
        {CLIS.map((cli) => {
          const tool = tools?.[cli.id];
          return (
            <Row key={cli.id} title={t(cli.name)} hint={tool ? cliLine(tool, cli) : p.failed ? t("src.failed") : t("src.reading")}>
              {value(tool, true, cli.id)}
            </Row>
          );
        })}
      </div>
      <div className="st-gh">{t("src.repos")}</div>
      <div className="st-grp">
        <Row title={t("src.pull.title")} hint={t("src.pull.hint")}>
          <Toggle on={saved.autoPull} label={t("src.pull.title")} onChange={(on) => p.onAutoPull?.(on)} testId="src-auto-pull" />
        </Row>
        <Row title={t("src.merge.title")} hint={t("src.merge.hint")}>
          <select className="dev-in" value={saved.mergeMethod} aria-label={t("src.merge.title")} onChange={(e) => p.onMergeMethod?.(e.currentTarget.value as MergeMethod | "last")} data-testid="src-merge-method">
            <option value="last">{t("src.merge.last")}</option>
            {MERGE_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`review.method.${m}` as Key)}
              </option>
            ))}
          </select>
        </Row>
        <Row title={t("src.credits.title")} hint={t("src.credits.hint")}>
          <Toggle on={saved.dropCredits} label={t("src.credits.title")} onChange={(on) => p.onDropCredits?.(on)} testId="src-drop-credits" />
        </Row>
      </div>
      <div className="st-note" data-testid="src-credits-list">
        {t("src.credits.list", { emails: CREDITS.emails.join(", "), names: CREDITS.githubNoreplyNames.join(", "), agents: CREDITS.agents.join(", ") })}
      </div>
      <div className="st-note">
        <button type="button" className="st-btn" onClick={p.onCheck} disabled={reading && !p.failed} data-testid="src-check">
          {t("src.check")}
        </button>{" "}
        {t("src.never")}
      </div>
    </div>
  );
}

export function SourceControlPage() {
  const [tools, setTools] = useState<SourceTools | null>(null);
  const [failed, setFailed] = useState(false);
  const read = useCallback((fresh: boolean) => {
    const host = getHost();
    if (!host.sourceTools) {
      setFailed(true);
      return;
    }
    if (fresh) setTools(null);
    void host.sourceTools(fresh).then(
      (got) => {
        setTools(got);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);
  // read when the page opens, and again when the window comes back to the front, as it does from a terminal where the person
  // signed in
  useEffect(() => {
    read(false);
    if (typeof window === "undefined") return;
    const again = () => read(true);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [read]);
  const saved = useSourceSettings();
  return <SourceControlView tools={tools} failed={failed} onCheck={() => read(true)} saved={saved} onAutoPull={(autoPull) => setSourceSettings({ autoPull })} onMergeMethod={(mergeMethod) => setSourceSettings({ mergeMethod })} onDropCredits={(dropCredits) => setSourceSettings({ dropCredits })} />;
}
