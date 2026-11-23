import { useEffect, useRef, useState } from "react";
import { ApiError, useApi, type AuditEntry, type Shop } from "../api";
import { formatStamp } from "../format";
import { useLoad } from "./useLoad";
import {
  auditOutcomeTag,
  auditReasonText,
  auditSentence,
  auditSubjectText,
  auditWords,
  errorText,
  isAuthError,
} from "./words";

/// The Audit page: one shop's audit log as the API keeps it (`GET /v1/admin/audit`), newest first, a page at a time.
/// The shop is chosen on the page, starting from the one chosen in the side menu, so the page stays open while the
/// operator looks through several shops. Older pages are added below the newest; a refresh or another shop starts
/// from the newest page again. When the API says entries could not be written, the page says the log is not
/// complete rather than letting a gap read as nothing having happened.

/// Entries each page asks for: the API's own default.
export const AUDIT_PAGE_SIZE = 50;

type Older = { tenant: string; entries: AuditEntry[]; next: string | null };

export function AuditView({ shops, tenant: chosen, onForget }: {
  shops: Shop[] | null;
  tenant: string | null;
  onForget: () => void;
}) {
  const api = useApi();
  const [tenant, setTenant] = useState(() => chosen ?? shops?.[0]?.tenant ?? "");
  const shop = shops?.find((s) => s.tenant === tenant) ?? null;
  const first = useLoad(shop ? () => api.listAudit(shop.tenant, { limit: AUDIT_PAGE_SIZE }) : null,
    `audit:${shop?.tenant ?? ""}`);
  const [older, setOlder] = useState<Older | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  // Every refresh or change of shop starts a new reading, and an older page asked for in an earlier one is dropped
  // when it arrives, so it can never be added under another shop's entries or a fresher first page.
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
  const entries = [...(first.data?.entries ?? []), ...(kept?.entries ?? [])];
  const next = kept ? kept.next : (first.data?.next ?? null);

  async function showOlder() {
    if (!shop || !next || olderBusy) return;
    const at = reading.current;
    setOlderBusy(true);
    setOlderError(null);
    try {
      const page = await api.listAudit(shop.tenant, { before: next, limit: AUDIT_PAGE_SIZE });
      if (reading.current !== at) return;
      setOlder((current) => ({
        tenant: shop.tenant,
        entries: [...(current?.tenant === shop.tenant ? current.entries : []), ...page.entries],
        next: page.next,
      }));
    } catch (error) {
      if (reading.current === at) setOlderError(error);
    } finally {
      if (reading.current === at) setOlderBusy(false);
    }
  }

  const now = Date.now();
  const missed = first.data?.missed ?? null;

  return (
    <>
      <div className="top">
        <h1>{auditWords.title}</h1>
        {shops && shops.length > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="audit-shop" className="mut" style={{ fontSize: 13 }}>
              {auditWords.shopLabel}
            </label>
            <select
              id="audit-shop"
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
            {auditWords.refresh}
          </button>
        </div>
      </div>
      {first.error ? (
        <div style={{ padding: "16px 16px 0" }}>
          <div className="banner err" role="alert">
            <span className="grow">{auditErrorText(first.error)}</span>
            {isAuthError(first.error) ? (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
                {auditWords.anotherKey}
              </button>
            ) : (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={first.reload}>
                {auditWords.tryAgain}
              </button>
            )}
          </div>
        </div>
      ) : null}
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, maxWidth: 880 }}>
        <p className="hint" style={{ margin: 0 }}>
          {auditWords.intro}
        </p>
        {missed && (
          <div className="banner warn" role="alert">
            <span className="grow">{auditWords.missed(missed, now)}</span>
          </div>
        )}
        {shops && shops.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            {auditWords.noShops}
          </p>
        ) : !shop || (!first.data && !first.error) ? (
          <div className="skel" style={{ height: 120 }} aria-label={auditWords.loading} />
        ) : first.data && entries.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            {auditWords.empty}
          </p>
        ) : entries.length > 0 ? (
          <ul aria-label={auditWords.listLabel(shop.name)} style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} ownerName={shop.ownerName} now={now} />
            ))}
          </ul>
        ) : null}
        {olderError ? (
          <div className="banner err" role="alert">
            <span className="grow">{errorText(olderError)}</span>
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
              {olderBusy ? auditWords.loadingOlder : auditWords.older}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/// The API answers 503 `audit_unavailable` when the shop's log cannot be read: it never answers an empty page instead.
function auditErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === "audit_unavailable") return auditWords.unavailable;
  return errorText(error);
}

function AuditRow({ entry, ownerName, now }: { entry: AuditEntry; ownerName: string; now: number }) {
  const tag = auditOutcomeTag(entry.outcome, ownerName);
  const about = auditSubjectText(entry.subject);
  return (
    <li className="rowl" style={{ flexWrap: "nowrap", alignItems: "flex-start", borderTop: "1px solid var(--line)" }}>
      <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span>{auditSentence(entry, ownerName)}</span>
        <span className="mut" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
          {about ? `${formatStamp(entry.at, now)} · ${about}` : formatStamp(entry.at, now)}
        </span>
        {entry.reason && (
          <span className="mut" style={{ fontSize: 12.5 }}>
            {auditReasonText(entry.reason)}
          </span>
        )}
      </div>
      {tag && <span className={tag.className}>{tag.label}</span>}
    </li>
  );
}
