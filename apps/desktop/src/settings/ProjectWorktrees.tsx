// Settings › Worktrees › For one project (item 99, "settings for one project"): pick a project, then for each of start from the
// remote, the branch prefix and both clean-ups, either follow all projects' choice (said with its value) or set the project's
// own. Where lanes are made stays one choice for all projects. Kept on this Mac (lib/worktrees.ts `setProjectWorktrees`).
//
// `ProjectWorktreesView` draws from props alone, so a test draws each state; `ProjectWorktrees` reads the projects and acts.
import { useState } from "react";
import { t, type Key } from "../i18n";
import { Modes } from "../ui/Modes";
import { prefixProblem, projectsWithOwnWorktrees, setProjectWorktrees, useProjectWorktrees, useWorktreeSettings, type ProjectWorktrees as Own, type WorktreeSettings } from "../lib/worktrees";
import { kitProjects } from "../code/project";
import { pathKey } from "../sessions/folders";
import { useSessions } from "../sessions/sessions";
import { Row } from "./DevRow";

type Flag = "remote" | "cleanDeleted" | "cleanMerged";
const FLAGS: readonly { field: Flag; title: Key }[] = [
  { field: "remote", title: "worktrees.remote.title" },
  { field: "cleanDeleted", title: "worktrees.deleted.title" },
  { field: "cleanMerged", title: "worktrees.merged.title" },
];

export interface ProjectWorktreesViewProps {
  readonly projects: readonly string[];
  readonly project: string | null;
  readonly own: Own;
  /** every project's choices, which the project follows where it set none */
  readonly all: WorktreeSettings;
  readonly prefixText: string;
  onProject: (p: string) => void;
  onFlag: (field: Flag, value: boolean | null) => void;
  onPrefixText: (text: string) => void;
  onPrefixSave: () => void;
  onPrefixClear: () => void;
}

const onOff = (v: boolean) => t(v ? "worktrees.project.on" : "worktrees.project.off");

export function ProjectWorktreesView(p: ProjectWorktreesViewProps) {
  const problem = p.prefixText ? prefixProblem(p.prefixText) : null;
  return (
    <>
      <div className="st-gh">{t("worktrees.project.title")}</div>
      <div className="st-note">{t("worktrees.project.hint")}</div>
      <div className="st-grp" data-testid="worktrees-project">
        <Row title={t("worktrees.project.pick")}>
          {p.projects.length ? (
            <select className="dev-in" value={p.project ?? ""} aria-label={t("worktrees.project.pick")} onChange={(e) => p.onProject(e.currentTarget.value)} data-testid="worktrees-project-pick">
              {p.projects.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          ) : (
            <span className="st-val" data-testid="worktrees-project-none">
              {t("worktrees.project.none")}
            </span>
          )}
        </Row>
        {p.project &&
          FLAGS.map(({ field, title }) => {
            const own = p.own[field];
            return (
              <Row key={field} title={t(title)}>
                <Modes
                  label={t(title)}
                  value={own === undefined ? "all" : own ? "on" : "off"}
                  options={[
                    { value: "all", label: t("worktrees.project.asAll", { value: onOff(p.all[field]) }) },
                    { value: "on", label: t("worktrees.project.on") },
                    { value: "off", label: t("worktrees.project.off") },
                  ]}
                  onChange={(v) => p.onFlag(field, v === "all" ? null : v === "on")}
                  testId={`worktrees-project-${field}`}
                />
              </Row>
            );
          })}
        {p.project && (
          <Row
            title={t("worktrees.prefix.title")}
            hint={problem ? t(`worktrees.prefix.${problem}` as Key) : t("worktrees.project.prefixHint", { prefix: p.all.prefix })}
          >
            <span className="st-pair">
              <input
                type="text"
                className="dev-in"
                value={p.prefixText}
                placeholder={p.all.prefix}
                onChange={(e) => p.onPrefixText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && p.prefixText && !problem && p.onPrefixSave()}
                aria-label={t("worktrees.prefix.title")}
                aria-invalid={!!problem}
                autoComplete="off"
                spellCheck={false}
                data-testid="worktrees-project-prefix"
              />
              <button type="button" className="st-btn" disabled={!p.prefixText || !!problem || p.prefixText === p.own.prefix} onClick={p.onPrefixSave} data-testid="worktrees-project-prefix-save">
                {t("worktrees.prefix.save")}
              </button>
              {p.own.prefix !== undefined && (
                <button type="button" className="st-btn" onClick={p.onPrefixClear} data-testid="worktrees-project-prefix-clear">
                  {t("worktrees.project.prefixClear")}
                </button>
              )}
            </span>
          </Row>
        )}
      </div>
    </>
  );
}

/** The projects to pick from: every coding chat's folder, every project Kit's dial knows, and every one that set its own. */
export function projectChoices(folders: readonly string[], dial: readonly string[], own: readonly string[]): string[] {
  return [...new Set([...folders, ...dial, ...own].filter(Boolean).map(pathKey))].sort((a, b) => a.localeCompare(b));
}

export function ProjectWorktrees() {
  const all = useWorktreeSettings();
  const list = useSessions().list;
  const projects = projectChoices(list.map((r) => r.cwd), Object.keys(kitProjects()), projectsWithOwnWorktrees());
  const [picked, setPicked] = useState<string | null>(null);
  const project = picked && projects.includes(picked) ? picked : (projects[0] ?? null);
  const own = useProjectWorktrees(project ?? "");
  const [prefixText, setPrefixText] = useState<string | null>(null);
  const text = prefixText ?? own.prefix ?? "";
  return (
    <ProjectWorktreesView
      projects={projects}
      project={project}
      own={project ? own : {}}
      all={all}
      prefixText={text}
      onProject={(p) => {
        setPicked(p);
        setPrefixText(null);
      }}
      onFlag={(field, value) => project && setProjectWorktrees(project, { [field]: value })}
      onPrefixText={setPrefixText}
      onPrefixSave={() => {
        if (project && text && !prefixProblem(text)) setProjectWorktrees(project, { prefix: text });
        setPrefixText(null);
      }}
      onPrefixClear={() => {
        if (project) setProjectWorktrees(project, { prefix: null });
        setPrefixText(null);
      }}
    />
  );
}
