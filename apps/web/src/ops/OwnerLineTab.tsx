import { useState } from "react";
import { useApi, type OwnerLinkCode, type Shop } from "../api";
import { formatLinkCode } from "../api/ownerLine";
import { CopyButton } from "./CopyButton";
import { useLoad } from "./useLoad";
import { errorText, ownerLineErrorText, ownerLineWords as W } from "./words";

/// The shop's owner on Manut AI's own LINE account (docs/pilot-api.md, "Owner messages on LINE"): whether they are
/// linked, a one-time code to link them with the steps to use it, and unlinking. The console only ever learns when
/// an owner linked, never who they are on LINE. A code is shown once, as the API answers it once; asking again
/// gives a new one and retires the old.
export function OwnerLineTab({ shop, onChanged }: { shop: Shop; onChanged: () => void }) {
  const api = useApi();
  const status = useLoad(() => api.getOwnerLine(), `owner-line:${shop.tenant}`);
  // The code, with the shop's link as it stood when it was asked for: once that changes (the owner linked, or was
  // unlinked), the code's steps are done and it is no longer shown.
  const [code, setCode] = useState<{ result: OwnerLinkCode; linkedAt: string | undefined } | null>(null);
  const [busy, setBusy] = useState<"code" | "unlink" | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const owner = shop.ownerName;
  const enabled = status.data?.enabled === true;
  const account = status.data?.account ?? null;
  const linked = Boolean(shop.ownerLinkedAt);
  const shownCode = code && code.linkedAt === shop.ownerLinkedAt ? code.result : null;

  async function getCode() {
    if (busy) return;
    setBusy("code");
    setError(null);
    try {
      const result = await api.createOwnerLinkCode(shop.tenant);
      setCode({ result, linkedAt: shop.ownerLinkedAt });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function unlink() {
    if (busy) return;
    setBusy("unlink");
    setError(null);
    try {
      await api.unlinkOwner(shop.tenant);
      setAsking(false);
      setCode(null);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      role="tabpanel"
      id="panel-owner"
      aria-labelledby="tab-owner"
      style={{ padding: 16, maxWidth: 680, display: "flex", flexDirection: "column", gap: 14 }}
    >
      <section className="box" aria-labelledby="owner-line-title" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="owner-line-title" className="h2">
          {W.title(owner)}
        </h2>
        <p style={{ margin: 0 }}>{shop.ownerLinkedAt ? W.linked(owner, shop.ownerLinkedAt) : W.notLinked(owner)}</p>
        <p className="hint" style={{ margin: 0 }}>
          {W.what(owner)}
        </p>
        {status.error ? (
          <div className="banner err" role="alert">
            <span className="grow">{errorText(status.error)}</span>
            <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={status.reload}>
              {W.tryAgain}
            </button>
          </div>
        ) : !status.data ? (
          <div className="skel" style={{ height: 34 }} aria-label={W.loading} />
        ) : !enabled ? (
          <div className="banner warn">
            <span className="grow">{W.off}</span>
          </div>
        ) : !account ? (
          <div className="banner warn">
            <span className="grow">{W.noAccount}</span>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn dark"
            disabled={!enabled || !account || busy !== null}
            aria-busy={busy === "code" ? true : undefined}
            onClick={() => void getCode()}
          >
            {busy === "code" ? W.gettingCode : linked ? W.newCode : W.getCode}
          </button>
          {linked && !asking && (
            <button type="button" className="btn" disabled={busy !== null} onClick={() => setAsking(true)}>
              {W.unlink}
            </button>
          )}
        </div>
        {linked && asking && (
          <div
            role="group"
            aria-labelledby="owner-unlink-title"
            className="box rise"
            style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}
          >
            <div id="owner-unlink-title" style={{ fontWeight: 500 }}>
              {W.unlinkTitle(owner)}
            </div>
            <p className="help" style={{ margin: 0 }}>
              {W.unlinkText(owner)}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn dark"
                disabled={busy !== null}
                aria-busy={busy === "unlink" ? true : undefined}
                onClick={() => void unlink()}
              >
                {busy === "unlink" ? W.unlinking : W.unlinkConfirm(owner)}
              </button>
              <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => setAsking(false)}>
                {W.keep}
              </button>
            </div>
          </div>
        )}
        {shownCode && (
          <div
            role="group"
            aria-labelledby="owner-code-title"
            className="box rise"
            style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}
          >
            <div id="owner-code-title" style={{ fontWeight: 500 }}>
              {W.codeTitle(owner)}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                className="input mono"
                readOnly
                value={formatLinkCode(shownCode.code)}
                aria-label={W.codeLabel}
                onFocus={(event) => event.currentTarget.select()}
                style={{ flex: "0 1 220px", fontSize: 24, letterSpacing: 2 }}
              />
              <CopyButton text={shownCode.code} what={W.codeWhat} />
            </div>
            <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 }}>
              {W.codeSteps(owner, account?.basicId, shownCode.expiresAt).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        )}
        {error !== null && (
          <div className="banner err" role="alert">
            <span className="grow">{ownerLineErrorText(error)}</span>
          </div>
        )}
      </section>
    </div>
  );
}
