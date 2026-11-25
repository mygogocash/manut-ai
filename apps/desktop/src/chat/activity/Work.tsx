// What a SESSIONS agent showed of its work inside one turn's activity line: a file edit's change (DiffView), its
// todo list (PlanList) and its thinking (ThinkingText). The adapters send all three in one agent-neutral shape
// (`tool.diff`, `plan`, `thinking.text`); an agent that sends none of them shows none of these.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DiffFile, PlanItem } from "../../lib/protocol";
import { maskSecrets } from "../../lib/secrets";
import { t, type Key } from "../../i18n";
import { ChevronRight } from "../../ui";
import "./work.css";

const NOTE: Record<NonNullable<DiffFile["note"]>, Key> = { binary: "diff.binary", too_large: "diff.tooLarge", left_out: "diff.leftOut" };

/** One file's change: path and counts, then its lines in mono, capped in height with their own scroll. */
function DiffFileView({ f, testId }: { f: DiffFile; testId: string }) {
  return (
    <div className="dv-file" data-testid={`${testId}-file`}>
      <div className="dv-head">
        <span className="dv-path" title={f.path}>
          {f.path}
        </span>
        {f.kind === "add" && <span className="dv-kind">{t("diff.new")}</span>}
        {f.kind === "delete" && <span className="dv-kind">{t("diff.deleted")}</span>}
        {f.from && (
          <span className="dv-kind" title={f.from}>
            {t("diff.renamed", { from: f.from })}
          </span>
        )}
        {f.added > 0 && <span className="dv-add">+{f.added}</span>}
        {f.removed > 0 && <span className="dv-del">−{f.removed}</span>}
      </div>
      <div className="dv-body" data-testid={`${testId}-body`}>
        {f.lines.map((l, i) => {
          const k = l.startsWith("@@") ? "hunk" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
          // a key typed into the code is never shown, here or anywhere: the app's one masker hides it
          return (
            <div key={i} className={`dv-l ${k}`} data-kind={k}>
              {k === "hunk" ? "⋯" : maskSecrets(l.slice(1)) || " "}
            </div>
          );
        })}
        {f.note ? <div className="dv-l more">{t(NOTE[f.note])}</div> : null}
        {f.more ? <div className="dv-l more">{t("diff.more", { n: f.more })}</div> : null}
      </div>
    </div>
  );
}

/** A file edit's change, per file. Opened by a click, it scrolls itself into view (only then: never while an
 *  answer streams). `testId` names its elements for a place that draws it beside the timeline's own (`diff-view`,
 *  `diff-file`, `diff-body` for the timeline), so a count of the timeline's diffs is not changed by it; `scroll` off
 *  for a place that shows it without being opened by a click (the pane beside a lane). */
export function DiffView({ files, scroll = true, testId = "diff" }: { files: DiffFile[]; scroll?: boolean; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // a block body: newer Chromium (WebView2) returns a Promise from scrollIntoView, which React would then call as
  // this effect's cleanup when the diff closes or its turn is taken back ("destroy is not a function", blank app)
  useLayoutEffect(() => {
    if (scroll) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [scroll]);
  return (
    <div className="dv" data-testid={`${testId}-view`} ref={ref}>
      {files.map((f, i) => (
        <DiffFileView key={`${f.path}-${i}`} f={f} testId={testId} />
      ))}
    </div>
  );
}

const PLAN_STATE: Record<PlanItem["status"], Key> = { pending: "plan.pending", in_progress: "plan.doing", completed: "plan.done" };

/** The agent's todo list, one row per item; the list changes in place as the agent updates it. */
export function PlanList({ items }: { items: PlanItem[] }) {
  const done = items.filter((i) => i.status === "completed").length;
  return (
    <div className="pl" data-testid="plan">
      <div className="pl-head">{t("plan.count", { done, n: items.length })}</div>
      {items.map((i, k) => (
        <div key={k} className={`pl-row ${i.status}`} data-testid="plan-row" data-status={i.status}>
          <span className="pl-box" aria-label={t(PLAN_STATE[i.status])} role="img">
            {i.status === "completed" ? "✓" : i.status === "in_progress" ? "•" : ""}
          </span>
          <span className="pl-t">{i.text}</span>
        </div>
      ))}
    </div>
  );
}

/** `name` spans as inline code, the way the answer shows them; the rest of markdown stays plain text here. */
function inlineCode(text: string): ReactNode[] {
  return text.split(/`([^`\n]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/** What the agent thought: one quiet line, closed by default; a click opens the text. */
export function ThinkingText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`th${open ? " open" : ""}`} data-testid="thinking">
      <button type="button" className="th-h" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="thinking-toggle">
        {t("think.label")}
        <span className="th-chev" aria-hidden>
          <ChevronRight size={9} />
        </span>
      </button>
      {open && (
        <div className="th-body" data-testid="thinking-text">
          {inlineCode(text.trim())}
        </div>
      )}
    </div>
  );
}
