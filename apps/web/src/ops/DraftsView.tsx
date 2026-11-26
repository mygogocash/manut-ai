import { useEffect, useRef, useState } from "react";
import { useApi, type Shop, type WorkerJobEntry } from "../api";
import { formatStamp, langOf } from "../format";
import { useLoad } from "./useLoad";
import {
  draftSendText,
  draftsErrorText,
  draftsWords,
  errorText,
  isAuthError,
  jobAboutText,
  jobEndingNote,
  jobEndingTag,
  jobKindText,
  memberName,
  memberRole,
} from "./words";

/// The Drafts page: what Nam, Pim and Ton did for one shop, as the API lists it (`GET /v1/admin/workers/drafts`), newest
/// first, a page at a time. Each job shows its member, what it was, when it started, how it ended and the draft in full,
/// with what its model calls cost, and a job passed from one member to another says so. Every draft says it has not been
/// sent, and the page has nothing that sends anything: a reply goes out only by being proposed on the Messages tab and
/// approved by its owner, so this page only reads. The shop is chosen on the page, starting from the one chosen in the
/// side menu. Older pages are added below the newest; a refresh or another shop starts from the newest page again, as the
/// Audit page does.

/// Jobs each page asks for: the API's own default. Each job shows its draft in full, so a page is long enough already.
export const DRAFTS_PAGE_SIZE = 10;

type Older = { tenant: string; jobs: WorkerJobEntry[]; next: string | null };

export function DraftsView({ shops, tenant: chosen, listError, onRetry, onForget }: {
  shops: Shop[] | null;
  tenant: string | null;
  /// Why the shop list itself could not be read, which the console's side menu reads, when it could not.
  listError?: unknown;
  onRetry?: () => void;
  onForget: () => void;
}) {
  const api = useApi();
  const [tenant, setTenant] = useState(() => chosen ?? shops?.[0]?.tenant ?? "");
  const shop = shops?.find((s) => s.tenant === tenant) ?? null;
  const first = useLoad(shop ? () => api.listWorkerJobs(shop.tenant, { limit: DRAFTS_PAGE_SIZE }) : null,
    `drafts:${shop?.tenant ?? ""}`);
  const [older, setOlder] = useState<Older | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  // Every refresh or change of shop starts a new reading, and an older page asked for in an earlier one is dropped when it
  // arrives, so it can never be added under another shop's jobs or a fresher first page.
  const reading = useRef(0);

  // Keeps the chosen shop while the list still has it; one deleted meanwhile gives way to the first.
  useEffect(() => {
    if (!shops) return;
    setTenant((current) => (shops.some((s) => s.tenant === current) ? current : (shops[0]?.tenant ?? "")));
  }, [shops]);

  function startOver() {
    reading.current += 1;
    setOlder(null);
    setOlderBusy(false);
    setOlderError(null);
  }

  const kept = older?.tenant === tenant ? older : null;
  const jobs = [...(first.data?.jobs ?? []), ...(kept?.jobs ?? [])];
  const next = kept ? kept.next : (first.data?.next ?? null);

  async function showOlder() {
    if (!shop || !next || olderBusy) return;
    const at = reading.current;
    setOlderBusy(true);
    setOlderError(null);
    try {
      const page = await api.listWorkerJobs(shop.tenant, { before: next, limit: DRAFTS_PAGE_SIZE });
      if (reading.current !== at) return;
      setOlder((current) => ({
        tenant: shop.tenant,
        jobs: [...(current?.tenant === shop.tenant ? current.jobs : []), ...page.jobs],
        next: page.next,
      }));
    } catch (error) {
      if (reading.current === at) setOlderError(error);
    } finally {
      if (reading.current === at) setOlderBusy(false);
    }
  }

  const now = Date.now();
  // Without a shop list there is no shop to read jobs for, and the page says why rather than wait for ever.
  const listFailed = !shops && Boolean(listError);

  return (
    <>
      <div className="top">
        <h1>{draftsWords.title}</h1>
        {shops && shops.length > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="drafts-shop" className="mut" style={{ fontSize: 13 }}>
              {draftsWords.shopLabel}
            </label>
            <select
              id="drafts-shop"
              className="input"
              value={tenant}
              onChange={(event) => {
                startOver();
                setTenant(event.target.value);
              }}
            >
              {shops.map((s) => (
                <option key={s.tenant} value={s.tenant}>
                  {s.name}
                </option>
              ))}
            </select>
          </span>
        )}
        <div className="acts">
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              startOver();
              first.reload();
            }}
          >
            {draftsWords.refresh}
          </button>
        </div>
      </div>
      {listFailed ? (
        <div style={{ padding: "16px 16px 0" }}>
          <div className="banner err" role="alert">
            <span className="grow">{errorText(listError)}</span>
            {isAuthError(listError) ? (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
                {draftsWords.anotherKey}
              </button>
            ) : onRetry ? (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onRetry}>
                {draftsWords.tryAgain}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {first.error ? (
        <div style={{ padding: "16px 16px 0" }}>
          <div className="banner err" role="alert">
            <span className="grow">{draftsErrorText(first.error)}</span>
            {isAuthError(first.error) ? (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
                {draftsWords.anotherKey}
              </button>
            ) : (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={first.reload}>
                {draftsWords.tryAgain}
              </button>
            )}
          </div>
        </div>
      ) : null}
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, maxWidth: 880 }}>
        <p className="hint" style={{ margin: 0 }}>
          {draftsWords.intro}
        </p>
        {shops && shops.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            {draftsWords.noShops}
          </p>
        ) : listFailed ? null : !shop || (!first.data && !first.error) ? (
          <div className="skel" style={{ height: 120 }} aria-label={draftsWords.loading} />
        ) : first.data && jobs.length === 0 && !next ? (
          <>
            <p style={{ margin: 0 }}>{draftsWords.empty}</p>
            <p className="hint" style={{ margin: 0 }}>
              {draftsWords.emptyHint}
            </p>
          </>
        ) : jobs.length > 0 ? (
          <ul aria-label={draftsWords.listLabel(shop.name)} style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {jobs.map((job) => (
              <JobRow key={job.taskId} job={job} ownerName={shop.ownerName} now={now} />
            ))}
          </ul>
        ) : null}
        {olderError ? (
          <div className="banner err" role="alert">
            <span className="grow">{draftsErrorText(olderError)}</span>
          </div>
        ) : null}
        {next && (
          <div>
            <button
              type="button"
              className="btn"
              disabled={olderBusy}
              aria-busy={olderBusy ? true : undefined}
              onClick={() => void showOlder()}
            >
              {olderBusy ? draftsWords.loadingOlder : draftsWords.older}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function JobRow({ job, ownerName, now }: { job: WorkerJobEntry; ownerName: string; now: number }) {
  const tag = jobEndingTag(job.ending, ownerName);
  const note = jobEndingNote(job.ending);
  const role = memberRole(job.member);
  const sending = draftSendText(job.draft?.send, ownerName);
  const meta = [
    formatStamp(job.at, now),
    jobAboutText(job.draft?.about),
    draftsWords.task(job.taskId),
    job.costSatang === undefined ? null : draftsWords.cost(job.costSatang),
  ].filter((part): part is string => part !== null).join(" · ");
  return (
    <li
      className="rowl"
      style={{ flexDirection: "column", alignItems: "stretch", flexWrap: "nowrap", gap: 8, padding: "12px 10px",
        borderTop: "1px solid var(--line)" }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span>
            <strong>{memberName(job.member)}</strong>
            {role ? <span className="mut"> {role}</span> : null}
            {` · ${jobKindText(job.job)}`}
          </span>
          <span className="mut" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
            {meta}
          </span>
        </div>
        <span className={tag.className}>{tag.label}</span>
      </div>
      {job.passedFrom ? (
        <span className="mut" style={{ fontSize: 12.5 }}>
          {draftsWords.passed(job.passedFrom, job.member)}
        </span>
      ) : null}
      {note ? (
        <span className="mut" style={{ fontSize: 12.5 }}>
          {note}
        </span>
      ) : null}
      {job.draft ? (
        <div className="box" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} lang={langOf(job.draft.text)}>
            {job.draft.text}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span className="tag">{draftsWords.notSent}</span>
            <span className="mut" style={{ fontSize: 12.5 }}>
              {draftsWords.notSentNote}
            </span>
          </div>
          {sending ? (
            <span className="mut" style={{ fontSize: 12.5 }}>
              {sending}
            </span>
          ) : null}
        </div>
      ) : job.ending.state === "handed_over" ? null : (
        <span className="mut" style={{ fontSize: 12.5 }}>
          {job.ending.state === "running" ? draftsWords.notWritten : draftsWords.noDraft}
        </span>
      )}
    </li>
  );
}
