// Kit on the Code page, for one project at a time (the canvas's StatesCodeDev board, "What Kit may do" and
// "Secrets"): how much Kit does alone, with the level's own line and "Going live always asks, at every level"; a key
// typed into a session's changes; what was stopped outside the project, with Allow this folder; and what the
// developer kept with "Always allow in this project" and the folders Kit may read, each of which can be taken back.
// The project is a folder the Code page lists (a session's or an added one). `KitPanelView` takes everything it shows
// as props and uses no hooks, so a test can draw it; `KitPanel` reads the stores.
import "./kit.css";
import { useCallback, useEffect, useState, type ReactNode } from "react";
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
import { useRowMarks } from "../sidebar/rows";
import { laneBase, LanesView, openLane, useLaneRows, type LaneRow, type LanesProps } from "./Lanes";
import { openNewSessionMenu } from "../sessions/newMenu";
import { KeptLanes, useLaneProjects } from "./KeptLanes";
import { MainMoved } from "./MainMoved";
import { PreviewSample } from "./PreviewSample";
import { allowFolder, dropRule, mayAllow, removeFolder, setLevel, updateKitProjects, useKitProject, type KitProject } from "./project";

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
  /** The lane whose Bring it back is open, the link on its line that opens it, and what a lane's row shows under its line
   *  (KitPanel fills these: the panel under a Reverted lane reads the stores). */
  laneBack?: Pick<LanesProps, "backOpen" | "onBack" | "below" | "marks" | "away" | "onAway">;
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
}

/** A folder as the developer reads it: `~` for the home folder. */
const tilde = (path: string, home: string | null) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

export function KitPanelView(p: KitPanelProps) {
  const { root, project, home } = p;
  const name = projectName(root);
  return (
    <section className="kitp" aria-labelledby="kit-dial-title" data-testid="kit-panel">
      {/* the project's lanes come first, as the canvas's Code board draws them: the work, then how much Kit does alone */}
      <LanesView rows={p.lanes ?? []} now={p.now ?? 0} onOpen={p.onOpenLane ?? (() => undefined)} onNew={p.onNewLane} {...p.laneBack} />
      {p.kept}
      <div className="band">
        <span id="kit-dial-title">{t("kit.dial")}</span>
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
 *  files back, then the note that the branch it was made from changed the files it changed (read in the lane's own folder for its
 *  own base, while that folder is on its branch). */
function LaneBelow({ root, row, backOpen, onCloseBack }: { root: string; row: LaneRow; backOpen: boolean; onCloseBack: () => void }) {
  // a lane that can no longer bring its files back (a turn began, or they were brought back) shuts its panel for good
  useEffect(() => {
    if (backOpen && !row.canBringBack) onCloseBack();
  }, [backOpen, row.canBringBack, onCloseBack]);
  const own = laneBase(row);
  return (
    <>
      {backOpen && row.canBringBack ? <BringBack id={row.id} onClose={onCloseBack} /> : null}
      {own && <MainMoved root={root} {...(row.dir ? { dir: row.dir } : {})} base={own.base} branch={own.branch} lane={row.id} />}
    </>
  );
}

export function KitPanel() {
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
  const lanes = useLaneRows(root);
  // the lane whose Bring it back panel is open: one at a time
  const [backFor, setBackFor] = useState<string | null>(null);
  const closeBack = useCallback(() => setBackFor(null), []);
  // what the person did to each lane (pinned, snoozed, done for now, archived), and whether the snoozed and archived ones are open
  const rowMarks = useRowMarks();
  const [awayOpen, setAwayOpen] = useState(false);
  // the time a turn has run moves while one does
  const now = useNow(lanes.some((l) => l.status === "working"), 1_000);
  if (!root) return null;
  const keys: KeyNote[] = sessionsWithKeys()
    .map((k) => ({ session: k.chat.slice("agent:".length), files: k.files }))
    .filter((k) => pathKey(ss.list.find((r) => r.id === k.session)?.cwd ?? "") === root);
  return (
    <>
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
        laneBack={{
          backOpen: backFor,
          onBack: (id) => setBackFor((now) => (now === id ? null : id)),
          below: (row) => <LaneBelow root={root} row={row} backOpen={backFor === row.id} onCloseBack={closeBack} />,
          marks: rowMarks,
          away: awayOpen,
          onAway: () => setAwayOpen((v) => !v),
        }}
        onProject={setPicked}
        onLevel={(level) => updateKitProjects((x) => setLevel(x, root, level))}
        onAllow={(folder) => updateKitProjects((x) => allowFolder(x, root, folder))}
        onDropRule={(rule) => updateKitProjects((x) => dropRule(x, root, rule))}
        onDropFolder={(folder) => updateKitProjects((x) => removeFolder(x, root, folder))}
        onOpenSession={(id) => getStore().actions.openSession(id)}
        kept={<KeptLanes root={root} />}
      >
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
