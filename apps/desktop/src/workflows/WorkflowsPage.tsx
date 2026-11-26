// Settings › Workflows (item 77b, the owner's T3 Code Labs screenshot): the switch, "Skipped runs kept", the folder the workflows
// are read from, and each workflow with when it runs, its next run, Run now and its history. A file that is not a workflow is
// listed with why. It is a Settings page, not a page of the side menu: a person who never turns Workflows on sees nothing new
// anywhere else, and the lanes a run starts show where every lane shows, in the Code page's Lanes band.
//
// Item 91: each card shows every step's text in full, with the project's folder and the agent, under "Steps and project". A
// workflow runs only once the person pressed "Allow this workflow to run" there, and only while its file is still that text;
// until then Run now cannot be pressed and the card says why. The press allows the text the card drew (its digest), never the
// file as it may be by the time the press lands.
//
// `WorkflowsView` draws a given state so a test can draw each one; `WorkflowsPage` reads the workflows store and acts.
import { useEffect, useId, useState } from "react";
import "./workflows.css";
import { t } from "../i18n";
import { Toggle } from "../pages/kit";
import { Row } from "../settings/DevRow";
import { agentLabel, folderName, type AgentInfo } from "../sessions/agents";
import { getSessions, useSessions } from "../sessions/sessions";
import { getStore, selectAsks, useStore } from "../state/store";
import type { Workflow, WorkflowFile } from "./file";
import type { RunRec } from "./history";
import { getWorkflowsHost } from "./host";
import { getHost } from "../sessions/host";
import { standingOf, type Allowances, type Standing } from "./allow";
import { getWorkflows, useWorkflows, type LiveRun, type RunRefusal, type WorkflowsState } from "./runner";
import { keptOk, useWorkflowSettings, type WorkflowSettings } from "./settings";
import { fileWhyWords, nextWords, refusedWords, runLine, standingWords, whenWords } from "./words";
import { Icon } from "../ui/icons";

/** How many runs each workflow shows; the rest stay kept, within the history's bounds. */
export const HISTORY_SHOWN = 10;

export interface WorkflowsViewProps {
  settings: WorkflowSettings;
  /** "Skipped runs kept" as typed, which may not be saved yet */
  keptText: string;
  folder: WorkflowsState["folder"];
  files: WorkflowFile[];
  runs: RunRec[];
  live: Record<string, LiveRun>;
  /** the workflows whose run waits on an ask of the person's now */
  waiting: string[];
  /** why a run last did not start, by file */
  refused: Record<string, RunRefusal>;
  /** what the person allowed, by file */
  allowed: Allowances;
  agents: AgentInfo[] | null;
  now: number;
  onOn: (on: boolean) => void;
  onKeptText: (text: string) => void;
  onKeptSave: () => void;
  onShowFolder: () => void;
  onRunNow: (file: string) => void;
  onOpenLane: (session: string) => void;
  onStopAfter: (file: string) => void;
  /** "Allow this workflow to run": `digest` is the text the card drew */
  onAllow: (file: string, digest: string) => void;
  onDisallow: (file: string) => void;
}

/** The number "Skipped runs kept" holds, or null when it is not one the page takes. */
export const keptOf = (text: string): number | null => {
  const n = /^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : NaN;
  return keptOk(n) ? n : null;
};

function folderHint(f: WorkflowsViewProps["folder"]): string {
  if (f.state === "missing") return t("wf.folder.missing");
  if (f.state === "link") return t("wf.folder.link");
  if (f.state === "unreadable") return t("wf.folder.unreadable");
  return t("wf.folder.hint");
}

/** What a run going now is doing, in a line. */
function liveWords(l: LiveRun, waiting: boolean): string {
  if (l.step < 0) return t("wf.live.starting");
  const at = { step: l.step + 1, steps: l.steps.length };
  return waiting ? t("wf.live.waiting", at) : t("wf.live.step", at);
}

/** "Steps and project": every step's text in full, in order, with the project's folder and the agent, and Allow (or Stop
 *  allowing) under them, so a workflow is allowed only from where its steps are read. Open by itself while the workflow is not
 *  allowed, as the kit's accordion opens (KitMore); the panel stays in the page while closed, only hidden. */
function Look({ wf, standing, agents, onAllow, onDisallow }: { wf: Workflow; standing: Standing; agents: AgentInfo[] | null; onAllow: () => void; onDisallow: () => void }) {
  const [shown, setShown] = useState<boolean | null>(null);
  const open = shown ?? standing !== "allowed";
  const id = useId();
  return (
    <div className="wf-look">
      <button type="button" className="wf-look-h" aria-expanded={open} aria-controls={id} onClick={() => setShown(!open)} data-testid="workflow-look">
        <span>{t("wf.look")}</span>
        <Icon name="chevron-down" className="wf-chev" />
      </button>
      <div id={id} className="wf-look-p" role="region" aria-label={t("wf.look")} hidden={!open} data-testid="workflow-steps">
        <dl className="wf-facts">
          <dt>{t("wf.look.project")}</dt>
          <dd className="mono" data-testid="workflow-project">
            {wf.project}
          </dd>
          <dt>{t("wf.look.agent")}</dt>
          <dd>{agentLabel(wf.agent, agents)}</dd>
        </dl>
        <ol className="wf-steps">
          {wf.steps.map((s, i) => (
            <li key={i} data-testid="workflow-step">
              {s}
            </li>
          ))}
        </ol>
        {standing === "allowed" ? (
          <div className="wf-allow">
            <span className="wf-sub">{t("wf.allowed")}</span>
            <button type="button" className="st-btn" onClick={onDisallow} data-testid="workflow-disallow">
              {t("wf.disallow")}
            </button>
          </div>
        ) : (
          <div className="wf-allow">
            <span className="wf-sub">{t("wf.allow.hint")}</span>
            <button type="button" className="st-btn" onClick={onAllow} data-testid="workflow-allow">
              {t("wf.allow")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowsView(p: WorkflowsViewProps) {
  const kept = keptOf(p.keptText);
  const keptChanged = p.keptText.trim() !== String(p.settings.skippedKept);
  const readable = p.files.flatMap((f) => ("workflow" in f ? [f.workflow] : []));
  const bad = p.files.flatMap((f) => ("why" in f ? [f] : []));
  return (
    <div className="st-page" data-testid="workflows-page">
      <div className="st-gh st-gh0">{t("set.workflows")}</div>
      <div className="st-grp">
        <Row title={t("wf.on.title")} hint={t("wf.on.hint")}>
          <Toggle on={p.settings.on} label={t("wf.on.title")} onChange={p.onOn} testId="workflows-on" />
        </Row>
        <Row title={t("wf.kept.title")} hint={keptChanged && kept === null ? t("wf.kept.bad") : t("wf.kept.hint")}>
          <span className="st-pair">
            <input
              type="text"
              inputMode="numeric"
              className="dev-in wf-kept"
              value={p.keptText}
              onChange={(e) => p.onKeptText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && kept !== null && keptChanged && p.onKeptSave()}
              aria-label={t("wf.kept.title")}
              aria-invalid={keptChanged && kept === null}
              autoComplete="off"
              spellCheck={false}
              data-testid="workflows-kept"
            />
            <button type="button" className="st-btn" disabled={!keptChanged || kept === null} onClick={p.onKeptSave} data-testid="workflows-kept-save">
              {t("wf.kept.save")}
            </button>
          </span>
        </Row>
        <Row title={t("wf.folder.title")} hint={folderHint(p.folder)}>
          <span className="st-pair">
            <span className="st-val mono" data-testid="workflows-folder">
              {p.folder.path}
            </span>
            <button type="button" className="st-btn" onClick={p.onShowFolder} disabled={p.folder.state === "link"} data-testid="workflows-folder-show">
              {t("wf.folder.show")}
            </button>
          </span>
        </Row>
      </div>
      <p className="st-note wf-careful" data-testid="workflows-careful">
        {t("wf.careful")}
      </p>

      <div className="st-gh">{t("wf.list")}</div>
      {readable.length === 0 && bad.length === 0 && (
        <p className="st-note" data-testid="workflows-none">
          {t("wf.none")}
        </p>
      )}
      {readable.map((wf) => {
        const l = p.live[wf.file];
        const runs = p.runs.filter((r) => r.file === wf.file && r.state !== "running").slice(0, HISTORY_SHOWN);
        const next = p.settings.on ? nextWords(wf, p.now) : null;
        const standing = standingOf(wf, p.allowed);
        // the standing line already says a run was not allowed, or that the file changed
        const refused = p.refused[wf.file] === standing ? undefined : p.refused[wf.file];
        const steps = wf.steps.length === 1 ? t("wf.steps.one") : t("wf.steps.many", { n: wf.steps.length });
        return (
          <section key={wf.file} className="st-grp wf-card" data-testid="workflow" data-file={wf.file} data-standing={standing}>
            <div className="wf-head">
              <div className="wf-k">
                <b className="wf-name">{wf.name}</b>
                <span className="wf-sub">{[agentLabel(wf.agent, p.agents), folderName(wf.project), steps].join(" · ")}</span>
                <span className="wf-sub" data-testid="workflow-when">
                  {next ? `${whenWords(wf, p.now)} · ${next}` : whenWords(wf, p.now)}
                </span>
              </div>
              <button
                type="button"
                className="st-btn"
                disabled={!p.settings.on || !!l || standing !== "allowed"}
                title={!p.settings.on ? t("wf.off") : standing !== "allowed" ? standingWords(standing) : undefined}
                aria-label={t("wf.runNowAria", { name: wf.name })}
                onClick={() => p.onRunNow(wf.file)}
                data-testid="workflow-run-now"
              >
                {t("wf.runNow")}
              </button>
            </div>
            {standing !== "allowed" && (
              <div className={`wf-stand ${standing}`} role="status" data-testid="workflow-standing">
                {standingWords(standing)}
              </div>
            )}
            <Look wf={wf} standing={standing} agents={p.agents} onAllow={() => p.onAllow(wf.file, wf.digest)} onDisallow={() => p.onDisallow(wf.file)} />
            {l && (
              <div className={`wf-live${p.waiting.includes(wf.file) ? " ask" : ""}`} data-testid="workflow-live">
                <span>{liveWords(l, p.waiting.includes(wf.file))}</span>
                <span className="st-pair">
                  {l.session && (
                    <button type="button" className="st-btn" onClick={() => p.onOpenLane(l.session!)} data-testid="workflow-open-lane">
                      {t("wf.openLane")}
                    </button>
                  )}
                  {l.stopAfter ? (
                    <span className="wf-sub">{t("wf.stopping")}</span>
                  ) : (
                    <button type="button" className="st-btn" onClick={() => p.onStopAfter(wf.file)} data-testid="workflow-stop-after">
                      {t("wf.stopAfter")}
                    </button>
                  )}
                </span>
              </div>
            )}
            {refused && !l && (
              <div className="wf-live" role="status" data-testid="workflow-refused">
                {refusedWords(refused)}
              </div>
            )}
            <div className="wf-hist">
              <div className="wf-hist-h">{t("wf.history")}</div>
              {runs.length === 0 ? (
                <div className="wf-sub">{t("wf.history.none")}</div>
              ) : (
                <ul>
                  {runs.map((r) => (
                    <li key={r.id} className={`wf-run ${r.state}`} data-testid="workflow-run" data-state={r.state}>
                      <span>{runLine(r)}</span>
                      {r.detail && <span className="wf-detail">{r.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      })}
      {bad.length > 0 && (
        <>
          <div className="st-gh">{t("wf.bad")}</div>
          <div className="st-grp">
            {bad.map((f) => (
              <div key={f.file} className="st-row wf-bad" data-testid="workflow-bad" data-file={f.file}>
                <div className="st-k">
                  <b className="mono">{f.file}</b>
                  <span>{fileWhyWords(f.why, f.detail)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {p.folder.more > 0 && <p className="st-note">{t("wf.folder.more", { n: p.folder.more })}</p>}
    </div>
  );
}

export function WorkflowsPage() {
  const settings = useWorkflowSettings();
  const wf = useWorkflows();
  const ss = useSessions();
  const app = useStore();
  const [keptText, setKeptText] = useState(String(settings.skippedKept));
  const [now, setNow] = useState(() => Date.now());
  // the folder is read again as the page opens, so a file saved a moment ago is listed
  useEffect(() => {
    void getWorkflows().refresh();
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const asks = selectAsks(app);
  const waiting = Object.entries(wf.live).flatMap(([file, l]) => {
    const key = l.session ? getSessions().chatKey(l.session) : null;
    return key && asks.some((a) => a.bot === key) ? [file] : [];
  });
  return (
    <WorkflowsView
      settings={settings}
      keptText={keptText}
      folder={wf.folder}
      files={wf.files}
      runs={wf.runs}
      live={wf.live}
      waiting={waiting}
      refused={wf.refused}
      allowed={wf.allowed}
      agents={ss.agents}
      now={now}
      onOn={(on) => getWorkflows().setOn(on)}
      onKeptText={setKeptText}
      onKeptSave={() => {
        const n = keptOf(keptText);
        if (n !== null) getWorkflows().setSkippedKept(n);
      }}
      onShowFolder={() => {
        void (async () => {
          try {
            const path = await getWorkflowsHost().folder();
            await getWorkflows().refresh();
            // shown with the shell's own Reveal, as a session's folder is
            await getHost().reveal(path);
          } catch {
            /* the folder's line says what is wrong with it */
          }
        })();
      }}
      // why it did not start is kept by the store, so the card says it whichever way Run now was pressed (the palette too)
      onRunNow={(file) => void getWorkflows().runNow(file)}
      onOpenLane={(session) => getStore().actions.openSession(session)}
      onStopAfter={(file) => getWorkflows().stopAfterStep(file)}
      onAllow={(file, digest) => void getWorkflows().allow(file, digest)}
      onDisallow={(file) => getWorkflows().disallow(file)}
    />
  );
}
