import { useState } from "react";
import {
  ApiError,
  isAwaitingOwner,
  type AwaitingOwner,
  type DeletedShop,
  type DeletionRequest,
  type PilotApi,
  type Shop,
} from "../api";
import { isWipeIncomplete } from "./words";

/// A deletion that stopped part way (`partial`), or whose answer never arrived. It is kept here, apart from
/// the shop list, on purpose: an answer may never arrive, and though the API keeps a shop on its list until its
/// deletion has finished, one whose own record the deletion removed can no longer be opened. Sending the same
/// request again is the way to finish either, so it is offered above every shop.
export type UnfinishedDeletion = { tenant: string; name: string; partial: boolean; tries: number; error: unknown };

/// Every deletion to show as not finished, each once: this console's own, with what the API answered it, then those
/// the shop list reports for shops that can no longer be opened (`deleting.shopRecord` false), which come with no
/// answer to quote. A shop this console has just seen deleted is left out until the list is read again.
export function unfinishedDeletions(
  deletion: Pick<ShopDeletion, "gone" | "unfinished">,
  shops: readonly Shop[] | null,
): UnfinishedDeletion[] {
  const own = deletion.unfinished;
  const listed = (shops ?? [])
    .filter((shop) => shop.deleting?.shopRecord === false && !deletion.gone.has(shop.tenant) &&
      !own.some((entry) => entry.tenant === shop.tenant))
    .map((shop): UnfinishedDeletion => ({ tenant: shop.tenant, name: shop.name, partial: true, tries: 0, error: null }));
  return [...own, ...listed];
}

/// Whether the shop's deletion has started and not finished, by the list's own word or by the owner's yes that the
/// wipe has not finished.
export function isDeleting(shop: Shop): boolean {
  return Boolean(shop.deleting) || shop.deletion?.state === "deleting";
}

/// A deletion the API confirmed. `result` is null when the shop was already gone.
export type FinishedDeletion = { name: string; result: DeletedShop | null };

export type ShopDeletion = {
  /// Shops the API has confirmed deleted. The console hides them at once rather than wait for the list to
  /// reload, so a deleted shop's messages never show under the success note.
  gone: ReadonlySet<string>;
  finished: FinishedDeletion | null;
  unfinished: UnfinishedDeletion[];
  /// Live shops whose owner this console has just been asked to confirm a deletion, with the API's link, by tenant.
  /// The shop list carries the same request once it is read again; this shows the link at once.
  asked: ReadonlyMap<string, AwaitingOwner>;
  /// Sends one deletion. Resolves to the API's refusal when nothing was deleted, for the caller to show next
  /// to the name that was typed; every other answer is kept here and shown by the console. `retry` marks a
  /// run of an unfinished deletion, whose refusals stay with it too.
  run(tenant: string, name: string, retry?: boolean): Promise<unknown>;
  dismissFinished(): void;
};

/// The 404 code that means the shop has been deleted: `tenant_deleted`, which the API and the practice fake answer
/// on every operator route once a deletion has run. `shop_not_found` is not one: it means the tenant was never a
/// pilot shop.
const GONE_CODES = new Set(["tenant_deleted"]);

/// The deletion request to show for a shop: the one this console was just answered with, until the shop list has
/// read it back, and then the list's, which also carries the owner's answer. A list still holding an older request
/// (another link) is older than the answer.
export function deletionOf(shop: Shop, asked: ReadonlyMap<string, AwaitingOwner>): DeletionRequest | null {
  const fresh = asked.get(shop.tenant);
  if (fresh && shop.deletion?.confirmUrl !== fresh.confirmUrl) {
    return { state: "awaiting_owner", confirmUrl: fresh.confirmUrl, expiresAt: fresh.expiresAt };
  }
  return shop.deletion ?? null;
}

/// What a deletion that did not answer with its result means for the shop's data.
/// - `gone`: the shop has been deleted, which is what was asked for.
/// - `partial`: the API stopped part way (wipe_incomplete). Some data is deleted and some is still stored.
/// - `refused`: nothing was deleted. The API turned it down with a 4xx; or it could not record the deletion
///   (audit_unavailable), which it writes before the wipe and without which it does not start; or the client
///   never sent it for want of an operator key.
/// - `unclear`: anything else. With no answer, a server error, or a success whose body could not be read,
///   nobody can say how much was deleted.
export type DeleteErrorKind = "gone" | "partial" | "refused" | "unclear";

export function classifyDeleteError(error: unknown): DeleteErrorKind {
  if (!(error instanceof ApiError)) return "unclear";
  if (error.status === 404 && GONE_CODES.has(error.code)) return "gone";
  if (isWipeIncomplete(error)) return "partial";
  if (error.status >= 400 && error.status < 500) return "refused";
  if (error.code === "audit_unavailable" || error.code === "operator_key_missing") return "refused";
  return "unclear";
}

/// Whether the typed name confirms deleting the shop: the same letters, capitals and spaces, so a name that is
/// nearly right, the sign of a different shop, never confirms. How an accented letter was composed is the one
/// difference ignored, because no one can see it and the API ignores it too. Nothing is trimmed: the operator
/// types every space shown.
export function confirmsShopName(typed: string, name: string): boolean {
  return typed.normalize("NFC") === name.normalize("NFC");
}

export function useShopDeletion(
  api: PilotApi,
  events: { onAnswered: () => void; onDeleted: () => void },
): ShopDeletion {
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [finished, setFinished] = useState<FinishedDeletion | null>(null);
  const [unfinished, setUnfinished] = useState<UnfinishedDeletion[]>([]);
  const [asked, setAsked] = useState<ReadonlyMap<string, AwaitingOwner>>(() => new Map());

  function finish(tenant: string, name: string, result: DeletedShop | null): void {
    setGone((current) => new Set(current).add(tenant));
    setUnfinished((list) => list.filter((entry) => entry.tenant !== tenant));
    setFinished({ name, result });
    events.onDeleted();
  }

  async function run(tenant: string, name: string, retry = false): Promise<unknown> {
    try {
      const answer = await api.deleteShop({ tenant, confirmName: name });
      if (isAwaitingOwner(answer)) {
        // Nothing was deleted: the shop is live, and its owner decides through the link. An earlier attempt whose
        // answer was lost is settled by this one, which says where things stand.
        setAsked((current) => new Map(current).set(tenant, answer));
        setUnfinished((list) => list.filter((entry) => entry.tenant !== tenant));
        return null;
      }
      finish(tenant, name, answer);
      return null;
    } catch (error) {
      const kind = classifyDeleteError(error);
      // A shop that no longer exists is what the operator asked for. On a retry it means an earlier attempt
      // finished after all, even though its answer was lost.
      if (kind === "gone") {
        finish(tenant, name, null);
        return null;
      }
      if (kind === "refused" && !retry) return error;
      setUnfinished((list) => {
        const previous = list.find((entry) => entry.tenant === tenant);
        const entry: UnfinishedDeletion = {
          tenant,
          name,
          // Once part of a shop is known to be deleted, a later unclear answer does not make that less so.
          partial: kind === "partial" || (previous?.partial ?? false),
          tries: (previous?.tries ?? 0) + 1,
          error,
        };
        return previous ? list.map((item) => (item.tenant === tenant ? entry : item)) : [...list, entry];
      });
      return null;
    } finally {
      // Whatever the answer, the list should show what the server now has: a partial wipe may already have
      // taken the shop off it, and a name mismatch means the name on screen is out of date.
      events.onAnswered();
    }
  }

  return { gone, finished, unfinished, asked, run, dismissFinished: () => setFinished(null) };
}
