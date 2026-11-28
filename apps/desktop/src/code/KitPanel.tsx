// Kit on the Code page, for one project at a time (the canvas's StatesCodeDev board, "What Kit may do" and
// "Secrets"): how much Kit does alone, with the level's own line and "Going live always asks, at every level"; a key
// typed into a session's changes; what was stopped outside the project, with Allow this folder; and what the
// developer kept with "Always allow in this project" and the folders Kit may read, each of which can be taken back.
// The project is a folder the Code page lists (a session's or an added one). `KitPanelView` takes everything it shows
// as props and uses no hooks, so a test can draw it; `KitPanel` reads the stores.
import "./kit.css";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { KIT_LEVELS, type KitLevel } from "@manut/member-grants";
import { t } from "../i18n";
import { addedFolders, folderGroups, pathKey, useFolderPrefs } from "../sessions/folders";
import { useSessions } from "../sessions/sessions";
import type { SessionRec } from "../sessions/agents";
import { getStore } from "../state/store";
import { useNow } from "../elsewhere/useNow";
import { RunningPanel } from "../running/RunningPanel";
import { ruleText, type Rule } from "./command";
import { BringBack } from "./BringBack";
import { projectName, sessionsWithKeys, useKeysVersion } from "./kitAsks";
import { showPull } from "../tasks/state";
import { useRowMarks } from "../sidebar/rows";
import { laneBase, LanesView, openLane, useLaneRows, useLaneSettle, type LaneRow, type LanesProps } from "./Lanes";
import { openNewSessionMenu } from "../sessions/newMenu";
import { usePlace } from "../palette/places";
import { getHost } from "../sessions/host";
import { openFolderInEditor } from "./editor";
import { KeptLanes, useLaneProjects } from "./KeptLanes";
import { LaneSync } from "./LaneSync";
import { MainMoved } from "./MainMoved";
import { AutoPull } from "./AutoPull";
import { LaneReview } from "./Review";
import { PreviewSample } from "./PreviewSample";
import { ProjectIconView, useProjectIcon } from "./ProjectIcon";
import { allowFolder, dropRule, mayAllow, removeFolder, setLevel, updateKitProjects, useKitProject, type KitProject } from "./project";
import { Empty } from "../pages/MenuPage";
import { KeyCaps } from "../ui/KeyCaps";
import { useKeyShown, withKey, type KeyShown } from "../app/keyHints";
import { MenuIcon } from "../sidebar/menuIcons";

/** A session of this project whose changes hold a key. */
export interface KeyNote {
  session: string;
  files: string[];
}

export interface KitPanelProps {
  root: string;
  /** Every project the page lists, for the picker (one: no picker). */
  projects: string[];
  project: KitProject;
  keys: KeyNote[];
  home: string | null;
  /** The project's lanes (Lanes.tsx): none draws no Lanes band. */
  lanes?: LaneRow[];
  /** The time now (ms), for the time each working lane's turn has run. */
  now?: number;
  onOpenLane?: (id: string) => void;
  /** New lane in the Lanes band (KitPanel fills it: the + menu's Chat with Kit for this project). Without it the band has no link. */
  onNewLane?: () => void;
  /** The key of the + menu New lane opens (item 167d), as the person set it: KeyCaps beside the link while the project has no lane. */
  newKey?: KeyShown | null;
  /** The lane whose Bring it back is open, the link on its line that opens it, and what a lane's row shows under its line
   *  (KitPanel fills these: the panel under a Reverted lane reads the stores). */
  /** The pull request on a lane's row was pressed: Tasks opens on it (tasks/state.ts `showPull`). */
  onOpenPull?: LanesProps["onPull"];
  laneBack?: Pick<LanesProps, "backOpen" | "onBack" | "below" | "marks" | "away" | "onAway" | "jobOpen" | "onJob" | "onJobView">;
  onProject: (root: string) => void;
  onLevel: (level: KitLevel) => void;
  onAllow: (folder: string) => void;
  onDropRule: (rule: Rule) => void;
  onDropFolder: (folder: string) => void;
  onOpenSession: (id: string) => void;
  /** What the project's own state adds under the keys: a preview on a sample, the main branch moving (KitPanel fills it). */
  children?: ReactNode;
  /** The lanes' folders kept on this computer, under the lanes (KitPanel fills it: KeptLanes.tsx). */
  kept?: ReactNode;
  /** The project's own icon (item 100b, ProjectIcon.tsx), shown before its name when its folder keeps one. */
  icon?: string | null;
}

/** A folder as the developer reads it: `~` for the home folder. */
const tilde = (path: string, home: string | null) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

export function KitPanelView(p: KitPanelProps) {
  const { root, project, home } = p;
  const name = projectName(root);
  return (
    <section className="kitp" aria-labelledby="kit-dial-title" data-testid="kit-panel">
      {/* the project's lanes come first, as the canvas's Code board draws them: the work, then how much Kit does alone */}
      <LanesView rows={p.lanes ?? []} now={p.now ?? 0} onOpen={p.onOpenLane ?? (() => undefined)} onPull={p.onOpenPull} onNew={p.onNewLane} newKey={p.newKey} {...p.laneBack} />
      {p.kept}
      <div className="band">
        <span id="kit-dial-title">{t("kit.dial")}</span>
        <span className="kit-proj">
          <ProjectIconView icon={p.icon ?? null} />
          {p.projects.length > 1 ? (
            <select aria-label={t("kit.project")} value={root} onChange={(e) => p.onProject(e.currentTarget.value)} data-testid="kit-project">
              {p.projects.map((r) => (
                <option key={r} value={r}>
                  {projectName(r)}
                </option>
              ))}
            </select>
          ) : (
            <span className="mono" title={root}>
              {name}
            </span>
          )}
        </span>
      </div>
      <div className="dial" role="group" aria-label={t("kit.dial")} data-testid="kit-dial">
        {KIT_LEVELS.map((l) => (
          <button key={l} type="button" aria-pressed={project.level === l} onClick={() => p.onLevel(l)} data-testid={`kit-level-${l}`}>
            {t(`kit.level.${l}`)}
          </button>
        ))}
      </div>
      <p className="lv" aria-live="polite" data-testid="kit-line">
        {t(`kit.line.${project.level}`)}
      </p>
      <p className="mut">{t("kit.live")}</p>

      {p.keys.map((k) => (
        <div key={k.session} className="banner warn" role="status" data-testid="kit-key">
          <span className="grow">{k.files.length === 1 ? t("kit.keyFound", { file: k.files[0] }) : t("kit.keyFoundMany", { n: k.files.length })}</span>
          <button type="button" className="lk" onClick={() => p.onOpenSession(k.session)}>
            {t("kit.seeChange")}
          </button>
        </div>
      ))}

      {p.children}

      {project.blocked.length > 0 && (
        <>
          <div className="band">
            <span>{t("kit.blockedTitle")}</span>
          </div>
          {project.blocked.map((b) => (
            <div key={b.path} data-testid="kit-blocked">
              <div className="rowl">
                <span className="tag">{t("kit.blocked")}</span>
                <span className="grow">{t(b.lane ? `kit.blocked.lane.${b.what}` : `kit.blocked.${b.what}`, { project: name })}</span>
              </div>
              <div className="rowl">
                <span className="mono grow">{b.path}</span>
                {mayAllow(b.folder, root) && (
                  <button type="button" className="lk" onClick={() => p.onAllow(b.folder)} title={tilde(b.folder, home)} data-testid="kit-allow-folder">
                    {t("kit.allowFolder")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      {project.rules.length > 0 && (
        <>
          <div className="band">
            <span>{t("kit.rulesTitle")}</span>
          </div>
          {project.rules.map((r) => (
            <div key={ruleText(r)} className="rowl" data-testid="kit-rule">
              <span className="mono grow">{ruleText(r)}</span>
              <button type="button" className="lk" onClick={() => p.onDropRule(r)}>
                {t("kit.takeBack")}
              </button>
            </div>
          ))}
        </>
      )}

      {project.folders.length > 0 && (
        <>
          <div className="band">
            <span>{t("kit.foldersTitle")}</span>
          </div>
          {project.folders.map((f) => (
            <div key={f} className="rowl" data-testid="kit-folder">
              <span className="mono grow" title={f}>
                {tilde(f, home)}
              </span>
              <button type="button" className="lk" onClick={() => p.onDropFolder(f)}>
                {t("kit.takeBack")}
              </button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/** Whether every session of project `root` works in a lane's folder of its own (and there is one): Kit then works nowhere in the
 *  developer's folder, so the note under the dial, which reads that folder, stands down. */
export function onlyInOwnFolders(list: readonly Pick<SessionRec, "cwd" | "status" | "lane">[], root: string): boolean {
  const here = list.filter((r) => r.status !== "draft" && pathKey(r.cwd) === pathKey(root));
  return here.length > 0 && here.every((r) => !!r.lane?.dir);
}

/** The projects the Code page lists: the folders sessions run in, newest first, then the folders the person added, then the
 *  folders lanes were made from whose folders are kept (`lanes`), so a kept folder is never out of sight. */
export function codeProjects(cwds: readonly string[], added: readonly string[], lanes: readonly string[] = []): string[] {
  const groups = folderGroups(cwds.map((cwd) => ({ cwd }))).map((g) => g.cwd);
  return [...new Set([...groups, ...added.map(pathKey), ...lanes.map(pathKey)])].filter(Boolean);
}

/** What a lane's row shows under its line: Bring it back's panel, while the person has it open and the lane can still bring its
 *  files back, then how far its branch is from its remote (item 146), then the note that the branch it was made from changed the
 *  files it changed (read in the lane's own folder for its own base, while that folder is on its branch), then Put up for review for
 *  a lane with a folder and a branch of its own. */
function LaneBelow({ root, row, backOpen, onCloseBack }: { root: string; row: LaneRow; backOpen: boolean; onCloseBack: () => void }) {
  // a lane that can no longer bring its files back (a turn began, or they were brought back) shuts its panel for good
  useEffect(() => {
    if (backOpen && !row.canBringBack) onCloseBack();
  }, [backOpen, row.canBringBack, onCloseBack]);
  // a helper lane's work goes back to its lead by landing (item 102i), never by merging its lead's branch into it or by a pull request
  // of its own (docs/several-agents.md, "What it does not do"): it offers neither main-moved's merge nor Put up for review
  const own = row.helper ? null : laneBase(row);
  return (
    <>
      {backOpen && row.canBringBack ? <BringBack id={row.id} onClose={onCloseBack} /> : null}
      {own && row.worktree && <LaneSync worktree={row.worktree} mark={`${row.status}:${row.lastAt ?? 0}`} />}
      {own && <MainMoved root={root} {...(row.dir ? { dir: row.dir } : {})} base={own.base} branch={own.branch} lane={row.id} />}
      {own && row.worktree && <LaneReview root={root} worktree={row.worktree} branch={own.branch} title={row.title} />}
    </>
  );
}

/** The Lanes band with nothing under it yet: what a lane is, and New lane, which opens the + menu on its Chat with Kit. */
export function LanesEmpty({ onNew }: { onNew: () => void }) {
  // the + menu's key, beside the link that opens the same menu (item 167d), as the person set it
  const key = useKeyShown("new-session");
  return (
    <section className="lanes-empty" aria-labelledby="lanes-empty-h" data-testid="lanes-empty">
      <div className="band" data-testid="lanes-band">
        <span id="lanes-empty-h">{t("lane.title")}</span>
        <span className="lk-w">
          {key && <KeyCaps shown={key} />}
          <button type="button" className="lk" onClick={onNew} title={withKey(t("lane.newTip"), key)} data-testid="lane-new">
            {t("lane.new")}
          </button>
        </span>
      </div>
      <Empty icon={<MenuIcon row="code" />} title={t("lane.emptyTitle")} text={t("lane.emptyText")} testId="lanes-empty-state" />
    </section>
  );
}

export function KitPanel({ onJobView }: { onJobView?: (job: string) => void } = {}) {
  const newKey = useKeyShown("new-session");
  const ss = useSessions();
  const prefs = useFolderPrefs();
  useKeysVersion();
  const lanesMadeIn = useLaneProjects();
  const projects = codeProjects(
    ss.list.map((r) => r.cwd).filter(Boolean),
    addedFolders(prefs),
    lanesMadeIn,
  );
  const [picked, setPicked] = useState<string | null>(null);
  const root = picked && projects.includes(picked) ? picked : (projects[0] ?? "");
  const project = useKitProject(root);
  const icon = useProjectIcon(getHost(), root);
  const lanes = useLaneRows(root);
  // a lane whose pull request merged, or that has been quiet, settles by itself (item 94)
  useLaneSettle(lanes);
  // The command palette offers New lane while a project is open here, and presses this very link's function.
  const laneAction = useMemo(() => (root ? { newLane: () => openNewSessionMenu({ chat: true, folder: root }) } : null), [root]);
  usePlace("lane", laneAction);
  // The palette's Open the project in <editor>: the developer's own folder of the open project, never a lane's. A failure is said
  // on this page, in the app's own words, since the palette has closed.
  const [editorWhy, setEditorWhy] = useState("");
  const editorAction = useMemo(
    () =>
      root
        ? {
            open: () => {
              setEditorWhy("");
              void openFolderInEditor(getHost(), root).catch((e: unknown) => setEditorWhy(e instanceof Error ? e.message : ""));
            },
          }
        : null,
    [root],
  );
  usePlace("editorProject", editorAction);
  useEffect(() => {
    if (!editorWhy) return;
    const id = window.setTimeout(() => setEditorWhy(""), 8000);
    return () => window.clearTimeout(id);
  }, [editorWhy]);
  // the lane whose Bring it back panel is open: one at a time
  const [backFor, setBackFor] = useState<string | null>(null);
  const closeBack = useCallback(() => setBackFor(null), []);
  // what the person did to each lane (pinned, snoozed, done for now, archived), and whether the snoozed and archived ones are open
  const rowMarks = useRowMarks();
  const [awayOpen, setAwayOpen] = useState(false);
  // the jobs (Ask several agents, item 102a) whose lanes are listed under their row
  const [jobsOpen, setJobsOpen] = useState<string[]>([]);
  // the time a turn has run moves while one does
  const now = useNow(lanes.some((l) => l.status === "working"), 1_000);
  // No project yet: the canvas's Lanes band with its New lane, over the empty state that says what a lane is, so the page
  // opens on Kit's work and never on an empty list of terminals (item 85i, finding 5).
  if (!root) return <LanesEmpty onNew={() => openNewSessionMenu({ chat: true })} />;
  const keys: KeyNote[] = sessionsWithKeys()
    .map((k) => ({ session: k.chat.slice("agent:".length), files: k.files }))
    .filter((k) => pathKey(ss.list.find((r) => r.id === k.session)?.cwd ?? "") === root);
  return (
    <>
      {editorWhy && (
        <p className="kit-editor-why" role="alert" data-testid="kit-editor-why">
          {editorWhy}
        </p>
      )}
      <KitPanelView
        root={root}
        projects={projects}
        project={project}
        keys={keys}
        home={ss.home}
        lanes={lanes}
        now={now}
        onOpenLane={openLane}
        onNewLane={() => openNewSessionMenu({ chat: true, folder: root })}
        newKey={newKey}
        onOpenPull={(pull) => {
          // the same place Tasks opens a request: its list for that repository, with the request selected
          if (showPull(pull.source, pull.repo, pull.number, root)) getStore().actions.openTasks();
        }}
        laneBack={{
          backOpen: backFor,
          onBack: (id) => setBackFor((now) => (now === id ? null : id)),
          below: (row) => <LaneBelow root={root} row={row} backOpen={backFor === row.id} onCloseBack={closeBack} />,
          marks: rowMarks,
          away: awayOpen,
          onAway: () => setAwayOpen((v) => !v),
          jobOpen: jobsOpen,
          onJob: (job) => setJobsOpen((cur) => (cur.includes(job) ? cur.filter((j) => j !== job) : [...cur, job])),
          onJobView,
        }}
        onProject={setPicked}
        onLevel={(level) => updateKitProjects((x) => setLevel(x, root, level))}
        onAllow={(folder) => updateKitProjects((x) => allowFolder(x, root, folder))}
        onDropRule={(rule) => updateKitProjects((x) => dropRule(x, root, rule))}
        onDropFolder={(folder) => updateKitProjects((x) => removeFolder(x, root, folder))}
        onOpenSession={(id) => getStore().actions.openSession(id)}
        kept={<KeptLanes root={root} />}
        icon={icon}
      >
        {/* Settings › Source control › Automatically pull: what the last pull of this project's default branch did, or why not */}
        <AutoPull root={root} />
        <PreviewSample root={root} />
        {/* a lane's row carries its own note, read in its own folder. The developer's folder keeps one here while Kit works in it:
            a session with no folder of its own (a terminal, a lane that could not have one), or no session yet; with every
            session in a folder of its own, Kit does not work in the developer's folder and this note has nothing of Kit's to say */}
        <MainMoved root={root} off={onlyInOwnFolders(ss.list, root)} />
      </KitPanelView>
      {/* what keeps running (src/running/) for the project the panel shows, right under it */}
      <RunningPanel project={root} />
    </>
  );
}
