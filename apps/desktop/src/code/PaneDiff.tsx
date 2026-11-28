// The Diff in the pane beside a lane, as a review (item 146). It lists the files the lane changed, drawn by the app's own
// `DiffView` (chat/activity/Work.tsx), in three scopes: All changes (everything since the lane started, the list it has always
// been), Not committed (the folder against HEAD) and Commits (one section for each of the lane's own commits, newest first). The
// files are read as the list or one at a time, with Prev and Next and the file's place ("2 of 7"), and drawn unified or side by side;
// both choices are kept on this computer (diffPrefs.ts). Text selected in the lines can be noted for the chat beside it
// (chat/box/SelectionNote.tsx, which reads the lines back from the attributes `DiffView` draws): the note carries the file and the
// line range, and nothing is sent.
//
// `PaneDiffView` takes everything it shows as props, as `LanePaneView` does, so a test can draw it. The one thing it keeps is whether
// a commit's section is open.
import { memo, useMemo, useState } from "react";
import { DiffView, type DiffLayout } from "../chat/activity/Work";
import { t, type Key } from "../i18n";
import { maskSecrets } from "../lib/secrets";
import type { DiffFile } from "../lib/protocol";
import { ChevronRight } from "../ui";
import { Modes } from "../ui/Modes";
import type { DiffPrefs } from "./diffPrefs";
import type { LaneReview } from "./laneFolder";
import { entriesOf, placeOf, sectionsOf, stepPlace, SCOPES, type Current, type Scope, type Section, type WholeList } from "./paneReview";

export interface PaneScopes {
  scope: Scope;
  onScope: (scope: Scope) => void;
  /** What the shell read for Not committed and Commits, once it has; none until then. */
  review: LaneReview | null;
  /** The newest try to read it failed. */
  failed: boolean;
}

export interface PaneDiffProps {
  whole: WholeList;
  /** The scopes, where the shell can read the lane's folder; none where only the chat's events say what changed (the Diff is then the
   *  whole list alone). */
  scopes: PaneScopes | null;
  prefs: DiffPrefs;
  onPrefs: (patch: Partial<DiffPrefs>) => void;
  current: Current;
  onCurrent: (current: Current) => void;
}

const SCOPE_WORDS: Record<Scope, Key> = { all: "lane.pane.diff.scope.all", uncommitted: "lane.pane.diff.scope.uncommitted", commits: "lane.pane.diff.scope.commits" };
const NONE_WORDS: Record<Scope, Key> = { all: "lane.pane.diff.none", uncommitted: "lane.pane.diff.noneUncommitted", commits: "lane.pane.diff.noneCommits" };

// Memoised on its files, which stay the same array while nothing was read again: a long diff is not drawn again for each word of an
// answer that streams in beside it.
const Files = memo(function Files({ files, layout }: { files: DiffFile[]; layout: DiffLayout }) {
  return <DiffView files={files} scroll={false} testId="lane-diff" layout={layout} numbered />;
});

/** The one file shown by itself, which takes the height its lines need and leaves the scrolling to the pane. */
const One = memo(function One({ file, layout }: { file: DiffFile; layout: DiffLayout }) {
  const files = useMemo(() => [file], [file]);
  return <DiffView files={files} scroll={false} testId="lane-diff" layout={layout} numbered tall />;
});

const filesWords = (n: number): string => (n === 1 ? t("lane.pane.diff.filesOne") : t("lane.pane.diff.filesMany", { n }));

/** What heads a section: the commit's short id and subject, or Not committed yet. A subject can hold a key, so it passes the page's masker too. */
function Heading({ s }: { s: Section }) {
  if (!s.commit) return <span className="pd-sub">{t("lane.pane.diff.sec.uncommitted")}</span>;
  return (
    <>
      <span className="mono pd-id">{s.commit.id}</span>{" "}
      <span className="pd-sub">{maskSecrets(s.commit.subject) || t("lane.pane.diff.sec.noSubject")}</span>
    </>
  );
}

/** A section's files, or why it has none. */
function SectionFiles({ s, layout }: { s: Section; layout: DiffLayout }) {
  if (s.commit?.unread) {
    return (
      <p className="mut lp-none" data-testid="lane-diff-unread">
        {t("lane.pane.diff.commitUnread")}
      </p>
    );
  }
  if (s.files.length === 0 && s.commit) {
    return (
      <p className="mut lp-none" data-testid="lane-diff-commit-empty">
        {t("lane.pane.diff.commitEmpty")}
      </p>
    );
  }
  return (
    <>
      <Files files={s.files} layout={layout} />
      {s.moreFiles > 0 && (
        <p className="mut lp-none" data-testid="lane-diff-more-files">
          {t("lane.pane.diff.moreFiles", { n: s.moreFiles })}
        </p>
      )}
    </>
  );
}

/** One of the lane's commits: its heading, which opens and shuts its files. The newest opens first and the rest stay shut, so a
 *  lane of many commits is a short list a person opens from. */
function CommitSection({ s, layout, first }: { s: Section; layout: DiffLayout; first: boolean }) {
  const [open, setOpen] = useState(first);
  return (
    <section className="pd-sec" data-testid="lane-diff-commit" data-commit={s.id}>
      <button type="button" className="pd-sec-h" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="lane-diff-commit-head">
        <span className="pd-chev" aria-hidden="true">
          <ChevronRight />
        </span>
        <Heading s={s} />{" "}
        <span className="mut pd-n">{s.commit?.unread ? "" : filesWords(s.files.length + s.moreFiles)}</span>
      </button>
      {open && <SectionFiles s={s} layout={layout} />}
    </section>
  );
}

export function PaneDiffView({ whole, scopes, prefs, onPrefs, current, onCurrent }: PaneDiffProps) {
  const scope: Scope = scopes?.scope ?? "all";
  const review = scopes?.review ?? null;
  const sections = sectionsOf(scope, whole, review);
  const entries = entriesOf(sections);
  const waiting = scope !== "all" && review === null;
  // the scope has no file, or no commit, to list
  const empty = !waiting && (sections.length === 0 || (!sections[0].commit && sections[0].files.length === 0));
  const place = placeOf(entries, current.key, current.was);
  const one = prefs.one && entries.length > 0;
  const shown = one ? entries[place] : null;
  const move = (by: 1 | -1) => {
    const to = stepPlace(place, entries.length, by);
    onCurrent({ key: entries[to].key, was: to });
  };
  const more = sections.reduce((n, s) => n + s.moreFiles, 0);
  return (
    <div className="pd" data-testid="lane-diff-pane" data-scope={scope} data-layout={prefs.layout} data-one={one ? "true" : "false"}>
      {(scopes || entries.length > 0) && (
        <div className="pd-bar">
          {scopes && (
            <Modes
              label={t("lane.pane.diff.scope")}
              value={scopes.scope}
              options={SCOPES.map((v) => ({ value: v, label: t(SCOPE_WORDS[v]) }))}
              onChange={(v) => scopes.onScope(v as Scope)}
              testId="lane-diff-scope"
            />
          )}
          {entries.length > 0 && (
            <>
              <Modes
                label={t("lane.pane.diff.layout")}
                value={prefs.layout}
                options={[
                  { value: "unified", label: t("lane.pane.diff.layout.unified") },
                  { value: "split", label: t("lane.pane.diff.layout.split") },
                ]}
                onChange={(v) => onPrefs({ layout: v as DiffLayout })}
                testId="lane-diff-layout"
              />
              <Modes
                label={t("lane.pane.diff.show")}
                value={prefs.one ? "one" : "list"}
                options={[
                  { value: "list", label: t("lane.pane.diff.show.list") },
                  { value: "one", label: t("lane.pane.diff.show.one") },
                ]}
                onChange={(v) => {
                  // opening one at a time starts at the first file, and follows it from there
                  if (v === "one") onCurrent({ key: entries[0]?.key ?? null, was: 0 });
                  onPrefs({ one: v === "one" });
                }}
                testId="lane-diff-show"
              />
            </>
          )}
        </div>
      )}
      {waiting && (
        <p className="mut lp-none" role="status" data-testid={scopes?.failed ? "lane-diff-failed" : "lane-diff-reading"}>
          {t(scopes?.failed ? "lane.pane.diff.readFailed" : "lane.pane.diff.reading")}
        </p>
      )}
      {empty && (
        <p className="mut lp-none" data-testid={scope === "all" ? "lane-diff-none" : `lane-diff-none-${scope}`}>
          {t(NONE_WORDS[scope])}
        </p>
      )}
      {shown && (
        <div className="pd-one" data-testid="lane-diff-one">
          <div className="pd-nav" role="group" aria-label={t("lane.pane.diff.files")}>
            <button type="button" className="btn" disabled={place <= 0} onClick={() => move(-1)} data-testid="lane-diff-prev">
              {t("lane.pane.diff.prev")}
            </button>
            <span className="pd-place" role="status" data-testid="lane-diff-place">
              {t("lane.pane.diff.place", { n: place + 1, total: entries.length })}
            </span>
            <button type="button" className="btn" disabled={place >= entries.length - 1} onClick={() => move(1)} data-testid="lane-diff-next">
              {t("lane.pane.diff.next")}
            </button>
          </div>
          {shown.section.id !== "all" && (
            <p className="pd-in" data-testid="lane-diff-in">
              <Heading s={shown.section} />
            </p>
          )}
          <One file={shown.file} layout={prefs.layout} />
          {more > 0 && (
            <p className="mut lp-none" data-testid="lane-diff-more-files">
              {t("lane.pane.diff.moreFiles", { n: more })}
            </p>
          )}
        </div>
      )}
      {!one && !empty && !waiting && (
        <div className="pd-list" data-testid="lane-diff-list">
          {scope === "commits" ? (
            <>
              {sections.map((s, i) => (
                <CommitSection key={s.id} s={s} layout={prefs.layout} first={i === 0} />
              ))}
              {review && review.moreCommits > 0 && (
                <p className="mut lp-none" data-testid="lane-diff-more-commits">
                  {t("lane.pane.diff.moreCommits", { n: review.moreCommits })}
                </p>
              )}
            </>
          ) : (
            sections.map((s) => (
              <section key={s.id} className="pd-sec" data-testid={s.id === "all" ? undefined : "lane-diff-section"} data-section={s.id}>
                {s.id !== "all" && (
                  <h3 className="pd-sec-h pd-sec-static">
                    <Heading s={s} />{" "}
                    <span className="mut pd-n">{filesWords(s.files.length + s.moreFiles)}</span>
                  </h3>
                )}
                <SectionFiles s={s} layout={prefs.layout} />
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}
