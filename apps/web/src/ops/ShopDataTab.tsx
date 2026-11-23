import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { isLiveShop, useApi, type DeletionRequest, type Shop } from "../api";
import { CopyButton } from "./CopyButton";
import { downloadText, exportFileName } from "./download";
import { confirmsShopName } from "./useShopDeletion";
import {
  deleteAfterText,
  deleteRefusalText,
  deleteWhatText,
  deletionLinkHelp,
  deletionRequestText,
  errorText,
  shopDataWords as W,
} from "./words";

/// The selected shop's data, exported or deleted at the shop's request. Laid out like "Privacy and data" on
/// the canvas's Settings board: the export and a `btn danger` side by side, then a dialog in the page that
/// says what goes and ends in `btn danger solid`, the last step of something that can't be undone.
///
/// A live shop's deletion waits for its owner's yes (`request`): the tab then shows the link to send the owner,
/// as the messages tab shows an approval link, and afterwards what the owner answered.
export function ShopDataTab({
  shop,
  request,
  onDelete,
  onFinish,
}: {
  shop: Shop;
  request: DeletionRequest | null;
  onDelete: (name: string) => Promise<unknown>;
  /// Sends the deletion the owner already said yes to again, which finishes a wipe that stopped part way.
  onFinish: () => Promise<unknown>;
}) {
  const api = useApi();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState(false);
  // Held here so the button that opened the form cannot close it while a deletion is on its way, which would
  // lose the answer the form is waiting to show.
  const [deleteBusy, setDeleteBusy] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const focusOpener = useRef(false);

  // When the form closes, focus goes back to the button that opened it rather than to the page. It waits for
  // the render that enables that button again: after an answer, closing and the end of the wait arrive
  // together, and a disabled button takes no focus.
  useEffect(() => {
    if (deleting || deleteBusy || !focusOpener.current) return;
    focusOpener.current = false;
    opener.current?.focus();
  }, [deleting, deleteBusy]);

  async function exportData() {
    if (exporting) return;
    setExporting(true);
    setExported(null);
    setExportError(null);
    try {
      const data = await api.exportShop(shop.tenant);
      const file = exportFileName(shop.name, shop.tenant, data.exportedAt);
      // Saved whole, as the API sent it: nothing renamed, dropped or re-indented, so the file is the export.
      downloadText(file, JSON.stringify(data), "application/json");
      setExported(file);
    } catch (error) {
      setExportError(error);
    } finally {
      setExporting(false);
    }
  }

  function closeDeletion() {
    focusOpener.current = true;
    setDeleting(false);
  }

  return (
    <div
      className="col"
      role="tabpanel"
      id="panel-data"
      aria-labelledby="tab-data"
      style={{ gap: 12, paddingTop: 16, maxWidth: 820 }}
    >
      <section aria-labelledby="data-title" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="band">
          <h2 id="data-title" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {W.title}
          </h2>
          <span>{W.when}</span>
        </div>
        <div style={{ padding: "0 10px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="chips" style={{ alignItems: "center" }}>
            <button
              type="button"
              className="btn"
              disabled={exporting}
              aria-busy={exporting ? true : undefined}
              onClick={() => void exportData()}
            >
              {exporting ? W.exporting : W.exportButton}
            </button>
            <button
              ref={opener}
              type="button"
              className="btn danger"
              aria-expanded={deleting}
              disabled={deleteBusy}
              onClick={() => setDeleting((open) => !open)}
            >
              {W.deleteButton}
            </button>
          </div>
          <span className="help">{W.intro(shop.name)}</span>
          {exportError ? (
            <div className="banner err" role="alert">
              <span className="grow">{errorText(exportError)}</span>
            </div>
          ) : null}
          {exported && (
            <div className="banner ok" role="status">
              <span className="grow">{W.exported(exported, shop.ownerName)}</span>
            </div>
          )}
          {request && <DeletionRequestPanel shop={shop} request={request} onFinish={onFinish} />}
          {deleting && (
            <DeleteShopForm
              shop={shop}
              busy={deleteBusy}
              onBusy={setDeleteBusy}
              onDelete={onDelete}
              onClose={closeDeletion}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function DeleteShopForm({
  shop,
  busy,
  onBusy,
  onDelete,
  onClose,
}: {
  shop: Shop;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDelete: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [refusal, setRefusal] = useState<unknown>(null);
  // What was typed is sent as it is: the API decides, and this only keeps the button shut until it can agree.
  const matches = confirmsShopName(typed, shop.name);
  // A live shop is not deleted by this form: it asks the owner, who answers through the link it returns. The API
  // decides which happens, so this only picks the words.
  const live = isLiveShop(shop);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !matches) return;
    onBusy(true);
    setRefusal(null);
    let answer: unknown = null;
    try {
      answer = await onDelete(typed);
    } catch (error) {
      answer = error;
    } finally {
      onBusy(false);
    }
    // A refusal deleted nothing, so the form stays, with the name, for another try. Every other answer is
    // the console's to show, because the shop may already have left the list.
    if (answer) setRefusal(answer);
    else onClose();
  }

  function closeOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || busy) return;
    event.preventDefault();
    onClose();
  }

  return (
    <form
      className="dialog"
      aria-labelledby="delete-title"
      noValidate
      onSubmit={(event) => void submit(event)}
      onKeyDown={closeOnEscape}
      style={{ maxWidth: 560 }}
    >
      <h3 id="delete-title">{W.deleteTitle(shop.name)}</h3>
      <p style={{ margin: 0 }}>{deleteWhatText(shop)}</p>
      <p style={{ margin: 0 }}>{deleteAfterText(shop)}</p>
      {live && <p style={{ margin: 0 }}>{W.ownerStep(shop.name, shop.ownerName)}</p>}
      <p style={{ margin: 0 }}>{W.undone}</p>
      <div className="field">
        <label htmlFor="delete-name">
          {W.confirmLabel}{" "}
          {/* pre-wrap keeps every space of the name visible, since each one has to be typed. */}
          <span style={{ fontWeight: 600, whiteSpace: "pre-wrap" }}>{shop.name}</span>
        </label>
        <input
          id="delete-name"
          className="input"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          aria-describedby="delete-name-help"
        />
        <div id="delete-name-help" className="help">
          {W.confirmHelp}
        </div>
      </div>
      {refusal ? (
        <div className="banner err" role="alert">
          <span className="grow">{deleteRefusalText(refusal)}</span>
        </div>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="submit"
          className="btn danger solid"
          disabled={!matches || busy}
          aria-busy={busy ? true : undefined}
        >
          {busy ? (live ? W.asking : W.deleting) : live ? W.askOwner(shop.ownerName) : W.deleteForGood}
        </button>
        <button type="button" className="btn dark" disabled={busy} onClick={onClose}>
          {W.keep}
        </button>
      </div>
    </form>
  );
}

/// The shop's latest deletion request. While it waits, the link to send the owner, in the same box the messages tab
/// uses for an approval link. Once answered, what the owner said; and when they said yes but the wipe stopped part
/// way, the one thing to do: send the request again, which finishes it.
function DeletionRequestPanel({
  shop,
  request,
  onFinish,
}: {
  shop: Shop;
  request: DeletionRequest;
  onFinish: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);

  async function finish() {
    if (busy) return;
    setBusy(true);
    try {
      await onFinish();
    } finally {
      setBusy(false);
    }
  }

  if (request.state === "awaiting_owner") {
    return (
      <div className="box rise" role="status" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontWeight: 500 }}>{W.linkTitle(shop.ownerName)}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="input mono"
            readOnly
            value={request.confirmUrl}
            aria-label={W.linkLabel}
            onFocus={(event) => event.currentTarget.select()}
            style={{ flex: "1 1 220px", fontSize: 12.5 }}
          />
          <CopyButton text={request.confirmUrl} what="deletion link" />
        </div>
        <p className="help" style={{ margin: 0 }}>
          {deletionLinkHelp(shop.ownerName, request.expiresAt)}
        </p>
      </div>
    );
  }
  if (request.state === "deleting") {
    return (
      <div className="banner err" role="alert">
        <span className="grow">{deletionRequestText(request, shop)}</span>
        <button
          type="button"
          className="btn danger solid"
          disabled={busy}
          aria-busy={busy ? true : undefined}
          onClick={() => void finish()}
        >
          {busy ? W.deleting : W.finish}
        </button>
      </div>
    );
  }
  if (request.state === "deleted") return null;
  return (
    <div className={request.state === "declined" ? "banner info" : "banner warn"}>
      <span className="grow">{deletionRequestText(request, shop)}</span>
    </div>
  );
}
