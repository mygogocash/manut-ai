// Recent work: the newest jobs as a short list that opens each job's page. Home lists the team's, and a member's panel lists
// that member's own, which is the canvas's member page ("Recent work", Member.dc.html). Both read the runtime's jobs (the
// connected runtime's are the viewed shop's tasks) and show nothing where the runtime has none to give, so neither is ever a
// made-up list.
import { useEffect, useState } from "react";
import "./mission.css";
import { t } from "../i18n";
import type { JobRow } from "../runtime/mission";
import { getStore, useStore } from "../state/store";
import { stageTag, whenText } from "./job";
import { load } from "./load";

/** One job as a Recent work row shows it. */
export interface RecentRow {
  key: string;
  title: string;
  /** the member who does it, as the app names them */
  who: string;
  /** where it stands, in words and the canvas's tag colour */
  word: string;
  cls: string;
  /** when it last moved ("09:20", "Yesterday 18:40") */
  when: string;
  open: () => void;
}

/** The newest jobs, newest first, at most `n` (three), of one member when `bot` is given. */
export function recentRows(
  jobs: readonly JobRow[],
  o: { nameOf: (bot: string) => string; nowMs: number; open: (id: string) => void; bot?: string; n?: number },
): RecentRow[] {
  const mine = o.bot ? jobs.filter((j) => j.bot === o.bot) : [...jobs];
  return mine
    .sort((a, b) => b.at - a.at)
    .slice(0, o.n ?? 3)
    .map((j) => {
      const tag = stageTag(j.stage);
      return { key: j.id, title: j.title, who: o.nameOf(j.bot), word: t(tag.word), cls: tag.cls, when: whenText(j.at, o.nowMs), open: () => o.open(j.id) };
    });
}

/** Home's list: each row is one button that opens the job's page (the menu pages' `.rows` and `.rowl`). */
export function RecentWorkList({ rows }: { rows: readonly RecentRow[] }) {
  return (
    <ul className="rows">
      {rows.map((r) => (
        <li key={r.key}>
          <button type="button" className="rowl" onClick={r.open} data-testid="recent-row">
            <span className="grow">
              <span className="l1">{r.title}</span>
              <span className="l2">{r.who}</span>
            </span>
            <span className={r.cls}>{r.word}</span>
            <span className="when">{r.when}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A member's section of the Details panel, in the panel's own look (elsewhere.css). Nothing at all when there is no work,
 *  so a member who has done none, or a runtime that cannot say, leaves the panel as it was. */
export function MemberWorkView({ rows }: { rows: readonly RecentRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mw">
      <div className="ew-sec" data-testid="work-sec">
        {t("pn.recentWork")}
        <span>{rows.length}</span>
      </div>
      <ul className="ew-sess" data-testid="work-list">
        {rows.map((r) => (
          <li key={r.key}>
            <button type="button" className="ew-ss link" onClick={r.open} data-testid="work-row">
              <span className="t1" title={r.title}>
                {r.title}
              </span>
              <span className="st">{r.when}</span>
              <span className="t2">
                <span className={r.cls}>{r.word}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The runtime's jobs, newest first; none while they load or when the runtime cannot say (the connected one answers "not
 *  yet"). Read again when a member is paused or resumed, which moves a running job to paused and back. */
export function useJobs(): JobRow[] {
  const s = useStore();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const held = s.bots.map((b) => (b.paused ? b.name : "")).join();
  useEffect(() => {
    let live = true;
    void load(() => getStore().actions.missionJobs()).then((r) => {
      if (live) setJobs(r.kind === "ready" ? r.value.jobs : []);
    });
    return () => {
      live = false;
    };
  }, [held]);
  return jobs;
}

export function MemberWork({ bot }: { bot: string }) {
  const s = useStore();
  const jobs = useJobs();
  return <MemberWorkView rows={recentRows(jobs, { nameOf: (b) => s.bots.find((x) => x.name === b)?.display_name ?? b, nowMs: Date.now(), open: (id) => s.openJob(id), bot })} />;
}
