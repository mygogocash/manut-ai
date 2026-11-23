import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useApi, type Shop } from "../api";
import { downloadText, exportFileName } from "./download";
import { deleteAfterText, deleteRefusalText, deleteWhatText, errorText, shopDataWords as W } from "./words";

/// The selected shop's data, exported or deleted at the shop's request. Laid out like "Privacy and data" on
/// the canvas's Settings board: the export and a `btn danger` side by side, then a dialog in the page that
/// says what goes and ends in `btn danger solid`, the last step of something that can't be undone.
export function ShopDataTab({ shop, onDelete }: { shop: Shop; onDelete: (name: string) => Promise<unknown> }) {
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
  // Exactly the shop's name: no trimming and no case folding. A name that is nearly right is the sign of a
  // different shop, and the API compares the same way.
  const matches = typed === shop.name;

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
          {busy ? W.deleting : W.deleteForGood}
        </button>
        <button type="button" className="btn dark" disabled={busy} onClick={onClose}>
          {W.keep}
        </button>
      </div>
    </form>
  );
}
