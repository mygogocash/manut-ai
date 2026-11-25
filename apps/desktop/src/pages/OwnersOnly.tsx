// What a page that is a shop's owner's shows at a shop the person only helps at (docs/runtime-adapter.md, "A shop the person
// helps at"). A helper's session reads the requests that wait for them there and nothing else: the team, its past work, the
// activity log and the routines answer it 403 `owner_only` (docs/pilot-api.md, "A helper's own routes"). So those pages draw
// none of it, not even an empty list, which would read as a shop with no team or no work: they say whose it is, and where
// what waits for the helper is. The words are src/lib/shops.ts's `ownersWords`.
import type { ReactNode } from "react";
import { t } from "../i18n";
import type { ShopRow } from "../lib/protocol";
import { ownersWords, type OwnersScreen } from "../lib/shops";

export function OwnersOnly({ shop, screen, icon, onNeeds }: { shop: Pick<ShopRow, "name" | "owner">; screen: OwnersScreen; icon: ReactNode; onNeeds?: () => void }) {
  const words = ownersWords(screen, shop);
  return (
    <div className="empty" role="status" data-testid={`owners-${screen}`}>
      <span className="ico" aria-hidden="true">
        {icon}
      </span>
      <h2>{words.title}</h2>
      <p>{words.text}</p>
      {onNeeds && (
        <button type="button" className="btn" onClick={onNeeds} data-testid="owners-needs">
          {t("owners.toNeeds")}
        </button>
      )}
    </div>
  );
}
