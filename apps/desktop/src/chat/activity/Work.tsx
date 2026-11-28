// What a SESSIONS agent showed of its work inside one turn's activity line: a file edit's change (DiffView), its
// todo list (PlanList) and its thinking (ThinkingText). The adapters send all three in one agent-neutral shape
// (`tool.diff`, `plan`, `thinking.text`); an agent that sends none of them shows none of these.
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { DiffFile, PlanItem } from "../../lib/protocol";
import { maskSecrets } from "../../lib/secrets";
import { t, type Key } from "../../i18n";
import { ChevronRight } from "../../ui";
import { pairRows, rowsOf, type DiffRow } from "./diffLayout";
import "./work.css";

const NOTE: Record<NonNullable<DiffFile["note"]>, Key> = { binary: "diff.binary", too_large: "diff.tooLarge", left_out: "diff.leftOut" };

/** Unified: each line under the one before it. Split: the file before the change on the left and after it on the right, a change's
 *  removed and added lines side by side (diffLayout.ts `pairRows`). */
export type DiffLayout = "unified" | "split";

// a key typed into the code is never shown, here or anywhere: the app's one masker hides it
const lineText = (text: string): string => maskSecrets(text) || " ";
const markOf = (kind: DiffRow["kind"]): string => (kind === "add" ? "+" : kind === "del" ? "−" : "");

/** A line number in a gutter, left out of what is selected and read out, since the line's own words are the content. */
const Num = ({ n }: { n: number | undefined }) => (
  <span className="dv-n" aria-hidden="true">
    {n ?? ""}
  </span>
);

/** One numbered line of the unified layout. The data attributes name the line for a note on selected lines (diffNote.ts reads
 *  them back); a number is left out where no hunk header placed the line. */
function NumberedLine({ r }: { r: DiffRow }) {
  return (
    <div className={`dv-l ${r.kind} n`} data-kind={r.kind} data-row={r.index} data-old={r.old} data-new={r.new}>
      <Num n={r.old} />
      <Num n={r.new} />
      <span className="dv-m" aria-hidden="true">
        {markOf(r.kind)}
      </span>
      <span className="dv-t">{lineText(r.text)}</span>
    </div>
  );
}

/** One cell of the split layout: `side` is the file the cell is of, and only that file's number is drawn. A line of context is
 *  a cell on both sides, with both numbers in its attributes. An empty cell is the other side of a line only one file has. */
function SplitCell({ r, side }: { r: DiffRow | undefined; side: "old" | "new" }) {
  if (!r) return <div className="dv-l n s empty" aria-hidden="true" />;
  return (
    <div className={`dv-l ${r.kind} n s`} data-kind={r.kind} data-row={r.index} data-side={side} data-old={r.old} data-new={r.new}>
      <Num n={side === "old" ? r.old : r.new} />
      <span className="dv-m" aria-hidden="true">
        {markOf(r.kind)}
      </span>
      <span className="dv-t">{lineText(r.text)}</span>
    </div>
  );
}

/** The lines of the numbered layouts. In the split layout a press on one side marks the body, so the other side is left out of
 *  what the drag selects (work.css): a selection of lines is of one file, never the two sides' words mixed. */
function NumberedBody({ f, layout }: { f: DiffFile; layout: DiffLayout }) {
  const rows = rowsOf(f.lines);
  if (layout === "unified") {
    return (
      <>
        {rows.map((r) =>
          r.kind === "hunk" ? (
            <div key={r.index} className="dv-l hunk" data-kind="hunk">
              ⋯
            </div>
          ) : (
            <NumberedLine key={r.index} r={r} />
          ),
        )}
      </>
    );
  }
  return (
    <>
      {pairRows(rows).map((p, i) =>
        "hunk" in p ? (
          <div key={i} className="dv-l hunk" data-kind="hunk">
            ⋯
          </div>
        ) : (
          <div key={i} className="dv-sr">
            <SplitCell r={p.left} side="old" />
            <SplitCell r={p.right} side="new" />
          </div>
        ),
      )}
    </>
  );
}

/** One file's change: path and counts, then its lines in mono, capped in height with their own scroll. `numbered` draws the line
 *  numbers git's hunk headers give (the pane beside a lane does; the timeline's own diff has none, and draws as it always did). */
function DiffFileView({ f, testId, layout, numbered }: { f: DiffFile; testId: string; layout: DiffLayout; numbered: boolean }) {
  const split = numbered && layout === "split";
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    const side = (e.target as HTMLElement).closest<HTMLElement>(".dv-l[data-side]")?.dataset.side ?? "";
    e.currentTarget.dataset.pick = side;
  };
  return (
    <div className="dv-file" data-testid={`${testId}-file`} {...(numbered ? { "data-path": f.path } : {})}>
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
      <div className="dv-body" data-testid={`${testId}-body`} {...(split ? { "data-split": "", onMouseDown: pick } : {})}>
        {numbered ? (
          <NumberedBody f={f} layout={layout} />
        ) : (
          f.lines.map((l, i) => {
            const k = l.startsWith("@@") ? "hunk" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
            return (
              <div key={i} className={`dv-l ${k}`} data-kind={k}>
                {k === "hunk" ? "⋯" : lineText(l.slice(1))}
              </div>
            );
          })
        )}
        {f.note ? <div className="dv-l more">{t(NOTE[f.note])}</div> : null}
        {f.more ? <div className="dv-l more">{t("diff.more", { n: f.more })}</div> : null}
      </div>
    </div>
  );
}

/** A file edit's change, per file. Opened by a click, it scrolls itself into view (only then: never while an
 *  answer streams). `testId` names its elements for a place that draws it beside the timeline's own (`diff-view`,
 *  `diff-file`, `diff-body` for the timeline), so a count of the timeline's diffs is not changed by it; `scroll` off
 *  for a place that shows it without being opened by a click (the pane beside a lane). `numbered` and `layout` are the pane's
 *  review (item 146): line numbers, and the split layout, which has them always. `tall` lets a file take the height its lines
 *  need, for the one file shown by itself. */
export function DiffView({ files, scroll = true, testId = "diff", layout = "unified", numbered = false, tall = false }: { files: DiffFile[]; scroll?: boolean; testId?: string; layout?: DiffLayout; numbered?: boolean; tall?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // a block body: newer Chromium (WebView2) returns a Promise from scrollIntoView, which React would then call as
  // this effect's cleanup when the diff closes or its turn is taken back ("destroy is not a function", blank app)
  useLayoutEffect(() => {
    if (scroll) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [scroll]);
  return (
    <div className={tall ? "dv tall" : "dv"} data-testid={`${testId}-view`} ref={ref}>
      {files.map((f, i) => (
        <DiffFileView key={`${f.path}-${i}`} f={f} testId={testId} layout={layout} numbered={numbered || layout === "split"} />
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
          <ChevronRight />
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
