// The Code page's "Outside Manut AI" lines under the coding plans (item 106): per tool, the tokens its own files on this
// Mac say were used today and this week in sessions run elsewhere, and a small table (day, project folder, tokens) on a
// click. It says where the numbers come from, that a plan's percentage stays what the tool itself reported, and when the
// files were last read. No money is shown: no file states one worth quoting, and a price is never multiplied in.
// Off until the person turns it on in Settings (`outsideUseOn`); the host is the one it is given.
import { useEffect, useRef, useState } from "react";
import type { SessionRec } from "../sessions/agents";
import { getStore } from "../state/store";
import { clock } from "../sidebar/usageFormat";
import { PROVIDER_NAME } from "../sidebar/usageFormat";
import { t } from "../i18n";
import { AgentIcon } from "../ui/AgentIcon";
import { OUTSIDE_TOOLS, outsideHost, outsideUseOn, skippedCount, startedIds, tokenText, watchOutsideUse, type OutsideHost, type OutsideReport, type OutsideTool } from "./outside";
import { errText } from "../lib/errText";

const REFRESH_MS = 120_000;
const ROWS_MAX = 200;
let nextScan = 1;

export type Read = { report: OutsideReport } | { error: string };


export function OutsideUse({
  list,
  host = outsideHost(),
  openSettings = () => getStore().actions.openSettings("providers"),
  now = () => Date.now() / 1000,
}: {
  list: readonly SessionRec[];
  host?: OutsideHost | null;
  openSettings?: () => void;
  now?: () => number;
}) {
  const [on, setOn] = useState(() => outsideUseOn());
  const [reads, setReads] = useState<Partial<Record<OutsideTool, Read>>>({});
  const [open, setOpen] = useState<OutsideTool | null>(null);
  useEffect(() => watchOutsideUse(() => setOn(outsideUseOn())), []);
  // the ids change as sessions come and go; a new set is read on the next tick, not on every change
  const ids = useRef<Record<OutsideTool, string[]>>({ claude: [], codex: [] });
  ids.current = { claude: startedIds(list, "claude"), codex: startedIds(list, "codex") };

  useEffect(() => {
    if (!on || !host) return;
    let alive = true;
    const running = new Set<number>();
    const read = () => {
      for (const tool of OUTSIDE_TOOLS) {
        const id = nextScan++;
        running.add(id);
        host.scan(tool, ids.current[tool], id).then(
          (report) => alive && setReads((r) => ({ ...r, [tool]: { report } })),
          (e) => alive && setReads((r) => ({ ...r, [tool]: { error: errText(e) } })),
        ).finally(() => running.delete(id));
      }
    };
    read();
    const h = setInterval(read, REFRESH_MS);
    return () => {
      // the page closes: stop what is still being read
      alive = false;
      clearInterval(h);
      for (const id of running) void host.cancel(id).catch(() => undefined);
    };
  }, [on, host]);

  if (!host) return null;
  return <OutsideView on={on} reads={reads} open={open} onOpen={setOpen} openSettings={openSettings} now={now()} />;
}

export interface ViewProps {
  on: boolean;
  reads: Partial<Record<OutsideTool, Read>>;
  open: OutsideTool | null;
  onOpen(tool: OutsideTool | null): void;
  openSettings(): void;
  now: number;
}

/** What the lines look like in each state: off, reading, a failed read, nothing found, and the numbers. */
export function OutsideView({ on, reads, open, onOpen, openSettings, now }: ViewProps) {
  if (!on) {
    return (
      <p className="out-off" data-testid="outside-off">
        {t("out.off")}{" "}
        <button type="button" className="out-link" onClick={openSettings} data-testid="outside-turn-on">
          {t("out.turnOn")}
        </button>
      </p>
    );
  }
  const reports = OUTSIDE_TOOLS.flatMap((tool) => {
    const r = reads[tool];
    return r && "report" in r ? [r.report] : [];
  });
  const errors = OUTSIDE_TOOLS.flatMap((tool) => {
    const r = reads[tool];
    return r && "error" in r ? [r.error] : [];
  });
  const loaded = reports.length + errors.length === OUTSIDE_TOOLS.length;
  // a tool whose sessions here are all compressed files that could not be unpacked has not used nothing: its files could not be read, and the line says so
  const unread = (r: OutsideReport) => r.rows.length === 0 && r.skipped.compressed > 0;
  const empty = loaded && reports.length > 0 && reports.every((r) => r.rows.length === 0 && !unread(r));
  const skipped = reports.reduce((n, r) => n + skippedCount(r.skipped), 0);
  const partial = reports.some((r) => r.partial);
  const last = reports.length ? Math.min(...reports.map((r) => r.read_at)) : null;
  return (
    <div className="out" data-testid="outside-use">
      {!loaded && reports.length === 0 && errors.length === 0 && <p className="out-note" data-testid="outside-reading">{t("out.reading")}</p>}
      {errors.map((e, i) => (
        <p className="out-note" role="status" key={i} data-testid="outside-error">{t("out.failed", { error: e })}</p>
      ))}
      {empty && <p className="out-note" data-testid="outside-empty">{t("out.none")}</p>}
      {!empty &&
        reports.map((r) => {
          const tool = r.tool as OutsideTool;
          const shown = open === tool;
          return (
            <div className="out-t" key={r.tool} data-testid={`outside-${r.tool}`}>
              <div className="out-r1">
                <AgentIcon id={r.tool} title={PROVIDER_NAME[r.tool]} size={16} />
                <span className="out-name">{t("out.tool", { tool: PROVIDER_NAME[r.tool] ?? r.tool })}</span>
                <span className="out-n" data-testid={`outside-${r.tool}-n`}>
                  {unread(r) ? t("out.compressed") : `${t("out.today", { n: tokenText(r.today) })} · ${t("out.week", { n: tokenText(r.week) })}`}
                </span>
                {r.rows.length > 0 && (
                  <button type="button" className="out-link" aria-expanded={shown} data-testid={`outside-${r.tool}-details`} onClick={() => onOpen(shown ? null : tool)}>
                    {shown ? t("out.hide") : t("out.details")}
                  </button>
                )}
              </div>
              {shown && (
                <table className="out-table" data-testid={`outside-${r.tool}-table`}>
                  <thead>
                    <tr>
                      <th>{t("out.day")}</th>
                      <th>{t("out.folder")}</th>
                      <th className="num">{t("out.tokens")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.slice(0, ROWS_MAX).map((row, i) => (
                      <tr key={i}>
                        <td>{row.day}</td>
                        <td>{row.project || t("out.noFolder")}</td>
                        <td className="num">{tokenText(row.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      <p className="out-note" data-testid="outside-note">
        {t("out.note")}
        {last !== null && ` ${t("out.read", { when: clock(last, now) })}`}
      </p>
      {skipped > 0 && <p className="out-note" data-testid="outside-skipped">{t("out.skipped", { n: skipped })}</p>}
      {partial && <p className="out-note" data-testid="outside-partial">{t("out.partial")}</p>}
    </div>
  );
}
