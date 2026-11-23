import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useApiSetup } from "../api";
import { BrandMark, StoreIcon, useColorScheme } from "../ui/marks";
import { DeletionNotices } from "./DeletionNotices";
import { MessagesTab } from "./MessagesTab";
import { forgetOperatorKey, readOperatorKey, saveOperatorKey } from "./operatorKey";
import { PaymentsTab } from "./PaymentsTab";
import { ShopDataTab } from "./ShopDataTab";
import { useLoad } from "./useLoad";
import { deletionOf, useShopDeletion } from "./useShopDeletion";
import { errorText, isAuthError, shopDataWords } from "./words";

/// The operator console for the concierge pilot, desktop first, in the canvas's side-menu layout: shops in
/// the side menu, the chosen shop's messages, replies, payments and data in the main column.

export const REFRESH_MS = 15000;

type Tab = "messages" | "payments" | "data";

export function OpsConsole() {
  const { api, mode } = useApiSetup();
  const scheme = useColorScheme();
  const [hasKey, setHasKey] = useState(() => readOperatorKey() !== null);
  const [tenant, setTenant] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("messages");

  const shops = useLoad(hasKey ? () => api.listShops() : null, `shops:${hasKey}`);
  // After a deletion the operator lands on the next shop's messages, never on its delete button.
  const deletion = useShopDeletion(api, { onAnswered: shops.reload, onDeleted: () => setTab("messages") });
  const shopList = useMemo(
    () => shops.data?.filter((s) => !deletion.gone.has(s.tenant)) ?? null,
    [shops.data, deletion.gone],
  );
  const shop = shopList?.find((s) => s.tenant === tenant) ?? null;
  // A live shop's deletion waits for its owner: the header says so, and the Shop data tab shows the link.
  const shopDeletion = shop ? deletionOf(shop, deletion.asked) : null;
  const messages = useLoad(shop ? () => api.listMessages(shop.tenant) : null, `messages:${shop?.tenant ?? ""}`);
  const actions = useLoad(shop ? () => api.listActions(shop.tenant) : null, `actions:${shop?.tenant ?? ""}`);
  const { reload: reloadMessages } = messages;
  const { reload: reloadActions } = actions;

  useEffect(() => {
    document.title = "Pilot console";
  }, []);

  useEffect(() => {
    const first = shopList?.[0];
    if (first && !shopList?.some((s) => s.tenant === tenant)) setTenant(first.tenant);
  }, [shopList, tenant]);

  // Owners answer from their phones, so the lists refresh themselves while the console is open.
  useEffect(() => {
    if (!shop) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      reloadMessages();
      reloadActions();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [shop, reloadMessages, reloadActions]);

  const forget = () => {
    forgetOperatorKey();
    setHasKey(false);
    setTenant(null);
  };

  const refresh = () => {
    shops.reload();
    reloadMessages();
    reloadActions();
  };

  const authFailed = [shops.error, messages.error, actions.error].some(isAuthError);

  return (
    <div className="r app" data-t={scheme}>
      <nav className="sb" aria-label="Console">
        <div className="brand">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BrandMark />
            <span style={{ fontWeight: 600 }}>Pilot console</span>
          </span>
        </div>
        {hasKey && (
          <>
            <div className="mut" style={{ padding: "12px 10px 4px", fontSize: 12 }} id="shops-label">
              Shops
            </div>
            {shopList ? (
              <ul aria-labelledby="shops-label" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {shopList.map((s) => (
                  <li key={s.tenant}>
                    <button
                      type="button"
                      className="nav"
                      style={{ width: "100%" }}
                      aria-current={s.tenant === tenant ? "page" : undefined}
                      onClick={() => {
                        setTenant(s.tenant);
                        deletion.dismissFinished();
                      }}
                    >
                      <StoreIcon />
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : shops.loading ? (
              <div className="skel" style={{ height: 34, margin: "0 6px" }} aria-label="Loading shops" />
            ) : null}
          </>
        )}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 6, padding: "0 6px" }}>
          {mode === "fake" && <span className="planp" style={{ alignSelf: "flex-start" }}>Practice mode</span>}
          {hasKey && (
            <div className="mut" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "4px 4px 6px" }}>
              <span style={{ flex: 1 }}>Operator key kept for this tab</span>
              <button type="button" className="lk" onClick={forget}>
                Forget
              </button>
            </div>
          )}
        </div>
      </nav>

      <div className="mainc">
        {!hasKey ? (
          <KeyForm
            practice={mode === "fake"}
            onSaved={() => {
              setHasKey(true);
            }}
          />
        ) : (
          <>
            <div className="top">
              <h1>{shop?.name ?? "Shops"}</h1>
              {shop && (
                <>
                  <span className="mut" style={{ fontSize: 13 }}>
                    Owner {shop.ownerName}
                  </span>
                  <span className={shop.lineConnectionId ? "tag ok" : "tag"}>
                    {shop.lineConnectionId ? "LINE connected" : "LINE not connected"}
                  </span>
                  <span className={shop.consent ? "tag ok" : "tag warn"}>
                    {shop.consent ? "Owner allowed sending" : "Owner has not allowed sending yet"}
                  </span>
                  {shopDeletion?.state === "awaiting_owner" && (
                    <span className="tag warn">{shopDataWords.waitingTag(shop.ownerName)}</span>
                  )}
                  {shopDeletion?.state === "deleting" && <span className="tag err">{shopDataWords.unfinishedTag}</span>}
                </>
              )}
              <div className="tabs" role="tablist" aria-label="Sections">
                <button
                  type="button"
                  role="tab"
                  id="tab-messages"
                  className="tab"
                  aria-selected={tab === "messages"}
                  aria-controls="panel-messages"
                  onClick={() => setTab("messages")}
                >
                  Messages
                </button>
                <button
                  type="button"
                  role="tab"
                  id="tab-payments"
                  className="tab"
                  aria-selected={tab === "payments"}
                  aria-controls="panel-payments"
                  onClick={() => setTab("payments")}
                >
                  PromptPay
                </button>
                <button
                  type="button"
                  role="tab"
                  id="tab-data"
                  className="tab"
                  aria-selected={tab === "data"}
                  aria-controls="panel-data"
                  onClick={() => setTab("data")}
                >
                  {shopDataWords.tab}
                </button>
              </div>
              <div className="acts">
                <button type="button" className="btn ghost" onClick={refresh}>
                  Refresh
                </button>
              </div>
            </div>
            <DeletionNotices deletion={deletion} />
            {authFailed && (
              <div style={{ padding: "12px 16px 0" }}>
                <div className="banner err" role="alert">
                  <span className="grow">{errorText(shops.error ?? messages.error ?? actions.error)}</span>
                  <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={forget}>
                    Enter another key
                  </button>
                </div>
              </div>
            )}
            {shops.error && !authFailed ? (
              <div style={{ padding: 16 }}>
                <div className="banner err" role="alert">
                  <span className="grow">{errorText(shops.error)}</span>
                  <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={shops.reload}>
                    Try again
                  </button>
                </div>
              </div>
            ) : shopList && shopList.length === 0 ? (
              <div className="empty">
                <span className="ico">
                  <StoreIcon />
                </span>
                <h3>No shops yet</h3>
                <p>Add a shop with POST /v1/admin/pilot/shops, then connect its LINE account.</p>
              </div>
            ) : shop ? (
              tab === "messages" ? (
                <MessagesTab
                  key={shop.tenant}
                  shop={shop}
                  messages={messages}
                  actions={actions}
                  onChanged={() => {
                    reloadMessages();
                    reloadActions();
                  }}
                />
              ) : tab === "payments" ? (
                <PaymentsTab key={shop.tenant} shop={shop} />
              ) : (
                <ShopDataTab
                  key={shop.tenant}
                  shop={shop}
                  request={shopDeletion}
                  onDelete={(name) => deletion.run(shop.tenant, name)}
                  onFinish={() => deletion.run(shop.tenant, shop.name, true)}
                />
              )
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function KeyForm({ practice, onSaved }: { practice: boolean; onSaved: () => void }) {
  const [value, setValue] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    saveOperatorKey(value);
    setValue("");
    onSaved();
  }

  return (
    <div className="col" style={{ maxWidth: 460, paddingTop: 64 }}>
      <form className="box" onSubmit={submit} style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <h1 className="big">Enter the operator key</h1>
        <div className="field">
          <label htmlFor="operator-key">Operator key</label>
          <input
            id="operator-key"
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-describedby="operator-key-help"
          />
          <div id="operator-key-help" className="help">
            Kept only in this tab and sent only to the admin routes. Closing the tab forgets it.
            {practice ? " Practice mode: any key works." : ""}
          </div>
        </div>
        <div>
          <button type="submit" className="btn dark" disabled={!value.trim()}>
            Use this key
          </button>
        </div>
      </form>
    </div>
  );
}
