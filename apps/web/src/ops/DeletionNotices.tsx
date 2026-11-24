import { useState } from "react";
import type { Shop } from "../api";
import { unfinishedDeletions, type ShopDeletion, type UnfinishedDeletion } from "./useShopDeletion";
import { deletedText, shopDataWords as W, unfinishedText } from "./words";

/// What became of a deletion, shown above every tab and every shop: the shop it was about may no longer be
/// on the list, or no longer open, and a deletion that did not finish must stay in sight until it does. `shops`
/// is the list as the API last answered it, which reports the deletions this console did not send.
export function DeletionNotices({ deletion, shops }: { deletion: ShopDeletion; shops: readonly Shop[] | null }) {
  const { finished } = deletion;
  const unfinished = unfinishedDeletions(deletion, shops);
  if (!finished && unfinished.length === 0) return null;
  return (
    <div style={{ padding: "12px 16px 0", display: "flex", flexDirection: "column", gap: 8 }}>
      {unfinished.map((entry) => (
        <UnfinishedNotice
          key={entry.tenant}
          entry={entry}
          onRetry={() => deletion.run(entry.tenant, entry.name, true)}
        />
      ))}
      {finished && (
        <div className="banner ok" role="status">
          <span className="grow">{deletedText(finished.name, finished.result)}</span>
        </div>
      )}
    </div>
  );
}

/// Sending the same deletion again finishes it, so the only action offered is to run it again. It is the
/// last step of something that can't be undone, so it is a `btn danger solid`, as on the canvas.
function UnfinishedNotice({ entry, onRetry }: { entry: UnfinishedDeletion; onRetry: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);

  async function retry() {
    if (busy) return;
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={entry.partial ? "banner err" : "banner warn"} role="alert">
      <span className="grow">{unfinishedText(entry)}</span>
      <button
        type="button"
        className="btn danger solid"
        disabled={busy}
        aria-busy={busy ? true : undefined}
        onClick={() => void retry()}
      >
        {busy ? W.deleting : entry.partial ? W.finish : W.runAgain}
      </button>
    </div>
  );
}
