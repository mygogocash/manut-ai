// Settings › General's first group: who and which shop the first-run setup kept on this computer, and the one way to
// change them, which opens the setup again on Your shop (store.ts `openFirstRun`). The setup is where the shop's details
// are typed, so Settings opens it rather than repeat its fields here. The markup is Settings' own row (Settings.slot.tsx
// `Row`), so the group looks like the rest of the page.
import { t } from "../i18n";
import { accountLabel, type ShopProfile } from "./shop";

export function ShopSettings({ shop, onSetUp }: { shop: ShopProfile; onSetUp: () => void }) {
  const known = !!(shop.person || shop.shop);
  return (
    <>
      <div className="st-gh st-gh0">{t("onb.set.title")}</div>
      <div className="st-grp" data-testid="set-shop">
        <div className="st-row">
          <div className="st-k">
            <b>{known ? accountLabel(shop).name : t("onb.set.none")}</b>
            <span>{t("onb.set.hint")}</span>
          </div>
          <div className="st-v">
            <button type="button" className="st-btn" onClick={onSetUp} data-testid="set-shop-setup">
              {known ? t("onb.set.again") : t("onb.set.start")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
